import path from "node:path";
import { Effect } from "effect";
import { getEmbeddedRegistryItemEffect } from "./embedded";
import type { FetchRegistryItemError, RegistryItemParseError } from "./errors";
import { err, ok, runEffect, toEffect, type Result } from "./result";
import type { RegistryItem, RegistryItemV1 } from "./types";

function parseError(message: string): RegistryItemParseError {
  return { _tag: "RegistryItemParseError", message };
}

function embeddedReadFailed(name: string, cause: unknown): FetchRegistryItemError {
  return { _tag: "EmbeddedReadFailed", name, cause };
}

function fetchFailed(url: string, status?: number, cause?: unknown): FetchRegistryItemError {
  return { _tag: "FetchFailed", url, status, cause };
}

function fileReadFailed(p: string, cause: unknown): FetchRegistryItemError {
  return { _tag: "FileReadFailed", path: p, cause };
}

function jsonParseFailed(source: string, cause: unknown): FetchRegistryItemError {
  return { _tag: "JSONParseFailed", source, cause };
}

function missingSpec(): FetchRegistryItemError {
  return { _tag: "MissingSpec" };
}

function unknownSpec(spec: string): FetchRegistryItemError {
  return { _tag: "UnknownSpec", spec };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStringArray(
  val: unknown,
  field: string,
): Result<string[], RegistryItemParseError> {
  if (val === undefined) return ok([]);

  if (!Array.isArray(val) || val.some((v) => typeof v !== "string")) {
    return err(parseError(`Invalid registry item: ${field} must be string[]`));
  }

  return ok(val);
}

function parseOptionalString(
  val: unknown,
  field: string,
): Result<string | undefined, RegistryItemParseError> {
  if (val === undefined) return ok(undefined);
  if (typeof val === "string") return ok(val);
  return err(parseError(`Invalid registry item: ${field} must be string`));
}

function parseV1(raw: unknown): Result<RegistryItemV1, RegistryItemParseError> {
  if (!isRecord(raw)) return err(parseError("Invalid registry item: expected object"));

  const ver = raw.schemaVersion;
  if (ver !== 1) {
    return err(parseError("Invalid registry item: unsupported schemaVersion"));
  }

  const kind = raw.kind;
  if (kind !== "tool" && kind !== "agent" && kind !== "command" && kind !== "themes") {
    return err(parseError("Invalid registry item: unsupported kind"));
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return err(parseError("Invalid registry item: name must be a non-empty string"));
  }

  const descRes = parseOptionalString(raw.description, "description");
  if (descRes._tag === "Err") return descRes;

  const depsRes = parseStringArray(raw.registryDependencies, "registryDependencies");
  if (depsRes._tag === "Err") return depsRes;

  const filesRaw = raw.files;
  if (!Array.isArray(filesRaw)) {
    return err(parseError("Invalid registry item: files must be an array"));
  }

  const files: RegistryItemV1["files"] = [];

  for (const f of filesRaw) {
    if (!isRecord(f)) return err(parseError("Invalid registry item: file must be object"));

    const p = f.path;
    const content = f.content;

    if (typeof p !== "string" || p.length === 0) {
      return err(parseError("Invalid registry item: file.path must be string"));
    }

    if (typeof content !== "string") {
      return err(parseError("Invalid registry item: file.content must be string"));
    }

    const m = f.mode;
    if (m === undefined) {
      files.push({ path: p, content });
      continue;
    }

    if (m !== "0644" && m !== "0755") {
      return err(parseError("Invalid registry item: file.mode must be 0644|0755"));
    }

    files.push({ path: p, content, mode: m });
  }

  const entryRes = parseOptionalString(raw.entry, "entry");
  if (entryRes._tag === "Err") return entryRes;

  const post = raw.postinstall;
  let postinstall: RegistryItemV1["postinstall"];

  if (post === undefined) {
    postinstall = undefined;
  } else {
    if (!isRecord(post)) {
      return err(parseError("Invalid registry item: postinstall must be object"));
    }

    const cmds = post.commands;
    if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== "string")) {
      return err(parseError("Invalid registry item: postinstall.commands must be string[]"));
    }

    const cwdRes = parseOptionalString(post.cwd, "postinstall.cwd");
    if (cwdRes._tag === "Err") return cwdRes;

    postinstall = { commands: cmds, cwd: cwdRes.value };
  }

  return ok({
    schemaVersion: 1,
    kind,
    name,
    description: descRes.value,
    registryDependencies: depsRes.value,
    files,
    entry: entryRes.value,
    postinstall,
  });
}

function isUrl(spec: string): boolean {
  return spec.startsWith("http://") || spec.startsWith("https://");
}

function isPath(spec: string): boolean {
  return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.endsWith(".json");
}

function fetchJSONEffect(url: string): Effect.Effect<unknown, FetchRegistryItemError> {
  return Effect.tryPromise({
    try: () => fetch(url),
    catch: (cause): FetchRegistryItemError => fetchFailed(url, undefined, cause),
  }).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) {
        return Effect.fail(fetchFailed(url, res.status));
      }

      return Effect.tryPromise({
        try: () => res.json(),
        catch: (cause): FetchRegistryItemError => jsonParseFailed(url, cause),
      });
    }),
  );
}

function readTextEffect(p: string): Effect.Effect<string, FetchRegistryItemError> {
  return Effect.tryPromise({
    try: () => Bun.file(p).text(),
    catch: (cause): FetchRegistryItemError => fileReadFailed(p, cause),
  });
}

function parseJsonEffect(text: string, source: string): Effect.Effect<unknown, FetchRegistryItemError> {
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause): FetchRegistryItemError => jsonParseFailed(source, cause),
  });
}

export type FetchRegistryItemResult = {
  item: RegistryItem;
  source: string;
};

export function fetchRegistryItemEffect(
  spec: string,
  opts: { cwd: string },
): Effect.Effect<FetchRegistryItemResult, FetchRegistryItemError> {
  const s = spec.trim();

  if (s.length === 0) {
    return Effect.fail(missingSpec());
  }

  return getEmbeddedRegistryItemEffect(s).pipe(
    Effect.mapError((e): FetchRegistryItemError => embeddedReadFailed(e.name, e.cause)),
    Effect.flatMap((embedded) => {
      if (embedded) {
        return Effect.succeed({
          item: embedded,
          source: `embedded:${embedded.kind}/${embedded.name}`,
        });
      }

      if (isUrl(s)) {
        return fetchJSONEffect(s).pipe(
          Effect.flatMap((raw) => toEffect(parseV1(raw))),
          Effect.map((item) => ({ item, source: s })),
        );
      }

      if (isPath(s)) {
        const resolved = path.isAbsolute(s) ? s : path.resolve(opts.cwd, s);

        return readTextEffect(resolved).pipe(
          Effect.flatMap((text) => parseJsonEffect(text, resolved)),
          Effect.flatMap((raw) => toEffect(parseV1(raw))),
          Effect.map((item) => ({ item, source: resolved })),
        );
      }

      return Effect.fail(unknownSpec(s));
    }),
  );
}

export async function fetchRegistryItem(
  spec: string,
  opts: { cwd: string },
): Promise<Result<FetchRegistryItemResult, FetchRegistryItemError>> {
  return runEffect(fetchRegistryItemEffect(spec, opts));
}
