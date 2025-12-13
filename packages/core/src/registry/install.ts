import path from "node:path";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import type {
  ApplyInstallResult,
  ConfigRoot,
  InstallPlan,
  OCXItemKind,
} from "./types";
import type { ResolvedItem } from "./resolve";
import {
  getTopLevelJsoncPropertyValueText,
  upsertTopLevelJsoncProperty,
} from "./jsonc";

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

function parseExistingOCXManagedConfig(text: string): OCXManagedConfig {
  const val = getTopLevelJsoncPropertyValueText(text, "ocx");
  if (!val) return emptyOCXManagedConfig();

  try {
    const parsed: unknown = JSON.parse(val);
    if (!isRecord(parsed)) return emptyOCXManagedConfig();

    const raw = parsed.items;
    const items = isRecord(raw) ? raw : {};

    return {
      items: {
        tool: ensureRecordMap(items.tool),
        agent: ensureRecordMap(items.agent),
        command: ensureRecordMap(items.command),
        themes: ensureRecordMap(items.themes),
      },
    };
  } catch {
    return emptyOCXManagedConfig();
  }
}

function normalizeRelPath(p: string): string {
  const norm = path.posix.normalize(p).replace(/^\.\//, "");

  if (path.posix.isAbsolute(norm)) {
    throw new Error(`Registry file path must be relative: ${p}`);
  }

  if (norm === ".." || norm.startsWith("../")) {
    throw new Error(`Registry file path cannot escape target dir: ${p}`);
  }

  if (norm.length === 0) {
    throw new Error("Registry file path cannot be empty");
  }

  return norm;
}

function computeDirRel(configRoot: ConfigRoot, kind: OCXItemKind, name: string): string {
  const parts = configRoot.kind === "project"
    ? [".opencode", kind, name]
    : [kind, name];

  return parts.join("/");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function planInstalls(
  resolved: ResolvedItem[],
  configRoot: ConfigRoot,
): InstallPlan[] {
  return resolved.map(({ item, source }) => {
    const kindDir = path.join(configRoot.opencodeDir, item.kind);
    const targetDir = path.join(kindDir, item.name);

    const dirRel = computeDirRel(configRoot, item.kind, item.name);
    const entryFile = normalizeRelPath(item.entry ?? "index.ts");
    const entryRel = `${dirRel}/${entryFile}`;

    const mkdirSet = new Set<string>([configRoot.opencodeDir, kindDir, targetDir]);
    const writes = item.files.map((file) => {
      const rel = normalizeRelPath(file.path);
      const dest = path.join(targetDir, ...rel.split("/"));
      mkdirSet.add(path.dirname(dest));
      return { path: dest, content: file.content, mode: file.mode };
    });

    const postinstall = item.postinstall
      ? {
          commands: item.postinstall.commands,
          cwd: path.resolve(
            configRoot.rootDir,
            item.postinstall.cwd ?? ".",
          ),
        }
      : null;

    return {
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
    };
  });
}

async function ensureDirs(dirs: string[]): Promise<void> {
  for (const d of dirs) {
    await mkdir(d, { recursive: true });
  }
}

async function writeAtomic(dest: string, content: string): Promise<void> {
  const dir = path.dirname(dest);
  await mkdir(dir, { recursive: true });

  const base = path.join(dir, `.tmp-ocx-${Date.now()}-`);
  const tmp = await mkdtemp(base);
  const file = path.join(tmp, "file");

  await Bun.write(file, content);
  await rename(file, dest);
  await rm(tmp, { recursive: true, force: true });
}

async function stageDir(
  plan: InstallPlan,
  overwrite: boolean,
): Promise<string> {
  const dir = path.dirname(plan.item.targetDir);
  await mkdir(dir, { recursive: true });

  const tmp = await mkdtemp(path.join(dir, `.tmp-ocx-${plan.item.name}-`));

  try {
    for (const w of plan.writes) {
      const rel = path.relative(plan.item.targetDir, w.path);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing to write outside target dir: ${w.path}`);
      }

      const dest = path.join(tmp, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await Bun.write(dest, w.content);
    }

    const exists = await pathExists(plan.item.targetDir);
    if (exists) {
      if (!overwrite) {
        throw new Error(
          `Target already exists: ${plan.item.targetDir} (use --overwrite)`,
        );
      }
      await rm(plan.item.targetDir, { recursive: true, force: true });
    }

    await rename(tmp, plan.item.targetDir);
    return plan.item.targetDir;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function updateConfig(
  path: string,
  plans: InstallPlan[],
): Promise<void> {
  const text = await Bun.file(path).text().catch(() => "{}");

  const cfg = parseExistingOCXManagedConfig(text);

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

  const updated = upsertTopLevelJsoncProperty(text, "ocx", cfg);
  await writeAtomic(path, updated);
}

async function runPostinstall(plan: InstallPlan): Promise<void> {
  if (!plan.postinstall) return;

  for (const cmd of plan.postinstall.commands) {
    const proc = Bun.spawn({
      cmd: ["bash", "-lc", cmd],
      cwd: plan.postinstall.cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: {
        ...process.env,
      },
    });

    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Postinstall command failed (${code}): ${cmd}`);
    }
  }
}

export async function applyInstallPlans(
  plans: InstallPlan[],
  opts: {
    overwrite: boolean;
    allowPostinstall: boolean;
  },
): Promise<ApplyInstallResult> {
  if (plans.length === 0) {
    throw new Error("No install plans to apply");
  }

  const root = plans[0]?.configRoot;
  if (!root) throw new Error("Missing config root");

  await ensureDirs([root.opencodeDir]);

  const wrote: string[] = [];

  for (const plan of plans) {
    const dir = await stageDir(plan, opts.overwrite);
    wrote.push(dir);
  }

  await ensureDirs([path.dirname(root.configPath)]);
  await updateConfig(root.configPath, plans);

  let ran = false;
  if (opts.allowPostinstall) {
    for (const plan of plans) {
      if (!plan.postinstall) continue;
      ran = true;
      await runPostinstall(plan);
    }
  }

  return {
    wroteFiles: wrote,
    editedConfigPath: root.configPath,
    ranPostinstall: ran,
  };
}

export function defaultHomeDir(): string {
  return os.homedir();
}
