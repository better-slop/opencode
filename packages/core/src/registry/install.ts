import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { Effect } from "effect";
import type { InstallError, JSONCError } from "./errors";
import { getTopLevelJsoncPropertyValueText, upsertTopLevelJsoncProperty } from "./jsonc";
import { err, ok, runEffect, toEffect, type Result } from "./result";
import type { ResolvedItem } from "./resolve";
import type { ApplyInstallResult, ConfigRoot, InstallPlan, OCXItemKind } from "./types";

type InstalledOCXItem = {
  source: string;
  dir: string;
  entry: string;
  postinstall?: {
    commands: string[];
    cwd: string;
  };
};

type OCXManagedConfig = {
  items: Record<OCXItemKind, Record<string, InstalledOCXItem>>;
};

function jsoncError(message: string): JSONCError {
  return { _tag: "JSONCError", message };
}

function noPlans(): InstallError {
  return { _tag: "NoPlans" };
}

function missingConfigRoot(): InstallError {
  return { _tag: "MissingConfigRoot" };
}

function invalidRegistryFilePath(p: string, message: string): InstallError {
  return { _tag: "InvalidRegistryFilePath", path: p, message };
}

function writeOutsideTargetDir(p: string): InstallError {
  return { _tag: "WriteOutsideTargetDir", path: p };
}

function targetAlreadyExists(p: string): InstallError {
  return { _tag: "TargetAlreadyExists", path: p };
}

function ioError(operation: string, cause: unknown, p?: string): InstallError {
  return { _tag: "IOError", operation, path: p, cause };
}

function postinstallFailed(cmd: string, code: number): InstallError {
  return { _tag: "PostinstallFailed", cmd, code };
}

function emptyOCXManagedConfig(): OCXManagedConfig {
  return {
    items: {
      tool: {},
      agent: {},
      command: {},
      themes: {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureRecordMap(value: unknown): Record<string, InstalledOCXItem> {
  if (!isRecord(value)) return {};
  return value as Record<string, InstalledOCXItem>;
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function normalizeRelPath(p: string): Result<string, InstallError> {
  const norm = path.posix.normalize(p).replace(/^\.\//, "");

  if (path.posix.isAbsolute(norm)) {
    return err(invalidRegistryFilePath(p, "Registry file path must be relative"));
  }

  if (norm === ".." || norm.startsWith("../")) {
    return err(invalidRegistryFilePath(p, "Registry file path cannot escape target dir"));
  }

  if (norm.length === 0) {
    return err(invalidRegistryFilePath(p, "Registry file path cannot be empty"));
  }

  return ok(norm);
}

function computeDirRel(configRoot: ConfigRoot, kind: OCXItemKind, name: string): string {
  const parts = configRoot.kind === "project" ? [".opencode", kind, name] : [kind, name];

  return parts.join("/");
}

function toMode(mode: "0644" | "0755"): number {
  if (mode === "0644") return 0o644;
  return 0o755;
}

function mkdirEffect(p: string): Effect.Effect<void, InstallError> {
  return Effect.tryPromise({
    try: () => mkdir(p, { recursive: true }),
    catch: (cause): InstallError => ioError("mkdir", cause, p),
  }).pipe(Effect.asVoid);
}

function mkdtempEffect(prefix: string): Effect.Effect<string, InstallError> {
  return Effect.tryPromise({
    try: () => mkdtemp(prefix),
    catch: (cause): InstallError => ioError("mkdtemp", cause, prefix),
  });
}

function renameEffect(from: string, to: string): Effect.Effect<void, InstallError> {
  return Effect.tryPromise({
    try: () => rename(from, to),
    catch: (cause): InstallError => ioError("rename", cause, `${from} -> ${to}`),
  }).pipe(Effect.asVoid);
}

function rmEffect(p: string): Effect.Effect<void, InstallError> {
  return Effect.tryPromise({
    try: () => rm(p, { recursive: true, force: true }),
    catch: (cause): InstallError => ioError("rm", cause, p),
  }).pipe(Effect.asVoid);
}

function chmodEffect(p: string, mode: number): Effect.Effect<void, InstallError> {
  return Effect.tryPromise({
    try: () => chmod(p, mode),
    catch: (cause): InstallError => ioError("chmod", cause, p),
  }).pipe(Effect.asVoid);
}

function pathExistsEffect(p: string): Effect.Effect<boolean, never> {
  return Effect.promise(() => stat(p).then(() => true).catch(() => false));
}

function bunWriteEffect(p: string, content: string): Effect.Effect<void, InstallError> {
  return Effect.tryPromise({
    try: () => Bun.write(p, content),
    catch: (cause): InstallError => ioError("write", cause, p),
  }).pipe(Effect.asVoid);
}

function withTmpDirEffect<A>(
  parent: string,
  prefix: string,
  use: (tmp: string) => Effect.Effect<A, InstallError>,
): Effect.Effect<A, InstallError> {
  return Effect.acquireUseRelease(
    mkdtempEffect(path.join(parent, prefix)),
    use,
    (tmp) => rmEffect(tmp).pipe(Effect.catchAll(() => Effect.void)),
  );
}

function writeAtomicEffect(dest: string, content: string): Effect.Effect<void, InstallError> {
  const dir = path.dirname(dest);

  return mkdirEffect(dir).pipe(
    Effect.zipRight(
      withTmpDirEffect(dir, `.tmp-ocx-${Date.now()}-`, (tmp) => {
        const file = path.join(tmp, "file");
        return bunWriteEffect(file, content).pipe(Effect.zipRight(renameEffect(file, dest)));
      }),
    ),
  );
}

function stageDirEffect(plan: InstallPlan, overwrite: boolean): Effect.Effect<string, InstallError> {
  const dir = path.dirname(plan.item.targetDir);

  return mkdirEffect(dir).pipe(
    Effect.zipRight(
      withTmpDirEffect(dir, `.tmp-ocx-${plan.item.name}-`, (tmp) =>
        Effect.gen(function* () {
          for (const w of plan.writes) {
            const rel = path.relative(plan.item.targetDir, w.path);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              return yield* Effect.fail(writeOutsideTargetDir(w.path));
            }

            const dest = path.join(tmp, rel);
            yield* mkdirEffect(path.dirname(dest));
            yield* bunWriteEffect(dest, w.content);

            if (w.mode) {
              yield* chmodEffect(dest, toMode(w.mode));
            }
          }

          const exists = yield* pathExistsEffect(plan.item.targetDir);

          if (exists && !overwrite) {
            return yield* Effect.fail(targetAlreadyExists(plan.item.targetDir));
          }

          if (exists && overwrite) {
            yield* rmEffect(plan.item.targetDir);
          }

          yield* renameEffect(tmp, plan.item.targetDir);
          return plan.item.targetDir;
        }),
      ),
    ),
  );
}

function parseExistingOCXManagedConfigEffect(text: string): Effect.Effect<OCXManagedConfig, InstallError> {
  const ocxRes = getTopLevelJsoncPropertyValueText(text, "ocx");

  return toEffect(ocxRes).pipe(
    Effect.flatMap((val) => {
      if (!val) return Effect.succeed(emptyOCXManagedConfig());

      return Effect.try({
        try: () => JSON.parse(val) as unknown,
        catch: (cause) => jsoncError(`Invalid JSON in ocx property: ${stringifyCause(cause)}`),
      }).pipe(
        Effect.flatMap((parsed) => {
          if (!isRecord(parsed)) {
            return Effect.fail(jsoncError("Invalid ocx config: expected object"));
          }

          const raw = parsed.items;
          const items = isRecord(raw) ? raw : {};

          return Effect.succeed({
            items: {
              tool: ensureRecordMap(items.tool),
              agent: ensureRecordMap(items.agent),
              command: ensureRecordMap(items.command),
              themes: ensureRecordMap(items.themes),
            },
          });
        }),
      );
    }),
  );
}

function updateConfigEffect(configPath: string, plans: InstallPlan[]): Effect.Effect<void, InstallError> {
  return Effect.promise(() => Bun.file(configPath).text().catch(() => "{}" as const)).pipe(
    Effect.flatMap((text) =>
      parseExistingOCXManagedConfigEffect(text).pipe(
        Effect.flatMap((cfg) =>
          Effect.sync(() => {
            for (const plan of plans) {
              const { kind, name, source, entryRel } = plan.item;
              const dir = entryRel.split("/").slice(0, -1).join("/");

              cfg.items[kind][name] = {
                source,
                dir,
                entry: entryRel,
                ...(plan.postinstall ? { postinstall: plan.postinstall } : {}),
              };
            }

            return cfg;
          }),
        ),
        Effect.flatMap((cfg) => toEffect(upsertTopLevelJsoncProperty(text, "ocx", cfg))),
        Effect.flatMap((updated) => writeAtomicEffect(configPath, updated)),
      ),
    ),
  );
}

function runPostinstallEffect(plan: InstallPlan): Effect.Effect<void, InstallError> {
  if (!plan.postinstall) return Effect.void;

  return Effect.forEach(
    plan.postinstall.commands,
    (cmd) =>
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn({
            cmd: ["bash", "-lc", cmd],
            cwd: plan.postinstall?.cwd,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
            env: {
              ...process.env,
            },
          });

          return await proc.exited;
        },
        catch: (cause): InstallError => ioError("postinstall", cause),
      }).pipe(
        Effect.flatMap((code) => {
          if (code === 0) return Effect.void;
          return Effect.fail(postinstallFailed(cmd, code));
        }),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
}

export function planInstalls(
  resolved: ResolvedItem[],
  configRoot: ConfigRoot,
): Result<InstallPlan[], InstallError> {
  const plans: InstallPlan[] = [];

  for (const { item, source } of resolved) {
    const kindDir = path.join(configRoot.opencodeDir, item.kind);
    const targetDir = path.join(kindDir, item.name);

    const dirRel = computeDirRel(configRoot, item.kind, item.name);

    const entryRes = normalizeRelPath(item.entry ?? "index.ts");
    if (entryRes._tag === "Err") return entryRes;

    const entryRel = `${dirRel}/${entryRes.value}`;

    const mkdirSet = new Set<string>([configRoot.opencodeDir, kindDir, targetDir]);
    const writes: InstallPlan["writes"] = [];

    for (const file of item.files) {
      const relRes = normalizeRelPath(file.path);
      if (relRes._tag === "Err") return relRes;

      const dest = path.join(targetDir, ...relRes.value.split("/"));
      mkdirSet.add(path.dirname(dest));
      writes.push({ path: dest, content: file.content, mode: file.mode });
    }

    const postinstall = item.postinstall
      ? {
          commands: item.postinstall.commands,
          cwd: path.resolve(configRoot.rootDir, item.postinstall.cwd ?? "."),
        }
      : null;

    plans.push({
      configRoot,
      item: {
        kind: item.kind,
        name: item.name,
        source,
        targetDir,
        entryRel,
      },
      mkdirs: Array.from(mkdirSet),
      writes,
      configEdits: [
        {
          jsonPath: ["ocx", "items", item.kind, item.name],
          value: {
            source,
            dir: dirRel,
            entry: entryRel,
            ...(postinstall ? { postinstall } : {}),
          },
        },
      ],
      postinstall,
      dependencies: {
        // TODO: decide bun add defaults
      },
    });
  }

  return ok(plans);
}

export function applyInstallPlansEffect(
  plans: InstallPlan[],
  opts: {
    overwrite: boolean;
    allowPostinstall: boolean;
  },
): Effect.Effect<ApplyInstallResult, InstallError> {
  const root = plans[0]?.configRoot;

  if (plans.length === 0) return Effect.fail(noPlans());
  if (!root) return Effect.fail(missingConfigRoot());

  const wrote: string[] = [];

  return Effect.gen(function* () {
    yield* mkdirEffect(root.opencodeDir);

    for (const plan of plans) {
      const dir = yield* stageDirEffect(plan, opts.overwrite);
      wrote.push(dir);
    }

    yield* mkdirEffect(path.dirname(root.configPath));
    yield* updateConfigEffect(root.configPath, plans);

    let ran = false;

    if (opts.allowPostinstall) {
      for (const plan of plans) {
        if (!plan.postinstall) continue;
        ran = true;
        yield* runPostinstallEffect(plan);
      }
    }

    return {
      wroteFiles: wrote,
      editedConfigPath: root.configPath,
      ranPostinstall: ran,
    };
  });
}

export async function applyInstallPlans(
  plans: InstallPlan[],
  opts: {
    overwrite: boolean;
    allowPostinstall: boolean;
  },
): Promise<Result<ApplyInstallResult, InstallError>> {
  return runEffect(applyInstallPlansEffect(plans, opts));
}

export function defaultHomeDir(): string {
  return os.homedir();
}
