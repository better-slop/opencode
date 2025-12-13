import path from "node:path";
import { readFile } from "node:fs/promises";
import { getEmbeddedRegistryItem } from "./embedded";
import type { RegistryItem, RegistryItemV1 } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(val: unknown, field: string): string[] {
  if (val === undefined) return [];
  if (!Array.isArray(val) || val.some((v) => typeof v !== "string")) {
    throw new Error(`Invalid registry item: ${field} must be string[]`);
  }
  return val;
}

function parseV1(raw: unknown): RegistryItemV1 {
  if (!isRecord(raw)) throw new Error("Invalid registry item: expected object");

  const ver = raw.schemaVersion;
  if (ver !== 1) {
    throw new Error("Invalid registry item: unsupported schemaVersion");
  }

  const kind = raw.kind;
  if (kind !== "tool" && kind !== "agent" && kind !== "command" && kind !== "themes") {
    throw new Error("Invalid registry item: unsupported kind");
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Invalid registry item: name must be a non-empty string");
  }

  const desc =
    raw.description === undefined
      ? undefined
      : typeof raw.description === "string"
        ? raw.description
        : (() => {
            throw new Error("Invalid registry item: description must be string");
          })();

  const filesRaw = raw.files;
  if (!Array.isArray(filesRaw)) {
    throw new Error("Invalid registry item: files must be an array");
  }

  const files = filesRaw.map((f) => {
    if (!isRecord(f)) throw new Error("Invalid registry item: file must be object");
    const p = f.path;
    const content = f.content;

    if (typeof p !== "string" || p.length === 0) {
      throw new Error("Invalid registry item: file.path must be string");
    }

    if (typeof content !== "string") {
      throw new Error("Invalid registry item: file.content must be string");
    }

    const m = f.mode;
    let mode: "0644" | "0755" | undefined;

    if (m === undefined) {
      mode = undefined;
    } else if (m === "0644" || m === "0755") {
      mode = m;
    } else {
      throw new Error("Invalid registry item: file.mode must be 0644|0755");
    }

    return mode ? { path: p, content, mode } : { path: p, content };
  });

  const entryRaw = raw.entry;
  const entry =
    entryRaw === undefined
      ? undefined
      : typeof entryRaw === "string"
        ? entryRaw
        : (() => {
            throw new Error("Invalid registry item: entry must be string");
          })();

  const post = raw.postinstall;
  const postinstall =
    post === undefined
      ? undefined
      : (() => {
          if (!isRecord(post)) {
            throw new Error("Invalid registry item: postinstall must be object");
          }
          const cmds = post.commands;
          if (!Array.isArray(cmds) || cmds.some((c) => typeof c !== "string")) {
            throw new Error("Invalid registry item: postinstall.commands must be string[]");
          }
          const cwd = post.cwd;
          if (cwd !== undefined && typeof cwd !== "string") {
            throw new Error("Invalid registry item: postinstall.cwd must be string");
          }
          return { commands: cmds, cwd };
        })();

  return {
    schemaVersion: 1,
    kind,
    name,
    description: desc,
    registryDependencies: asStringArray(raw.registryDependencies, "registryDependencies"),
    files,
    entry,
    postinstall,
  };
}

function isUrl(spec: string): boolean {
  return spec.startsWith("http://") || spec.startsWith("https://");
}

function isPath(spec: string): boolean {
  return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.endsWith(".json");
}

async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch registry item: ${url} (${res.status})`);
  }
  return await res.json();
}

export type FetchRegistryItemResult = {
  item: RegistryItem;
  source: string;
};

export async function fetchRegistryItem(
  spec: string,
  opts: { cwd: string },
): Promise<FetchRegistryItemResult> {
  const s = spec.trim();

  if (s.length === 0) {
    throw new Error("Missing registry item spec");
  }

  const embedded = await getEmbeddedRegistryItem(s);
  if (embedded) {
    return { item: embedded, source: `embedded:${embedded.kind}/${embedded.name}` };
  }

  if (isUrl(s)) {
    const raw = await fetchJSON(s);
    return { item: parseV1(raw), source: s };
  }

  if (isPath(s)) {
    const resolved = path.isAbsolute(s) ? s : path.resolve(opts.cwd, s);
    const text = await readFile(resolved, "utf8");
    return { item: parseV1(JSON.parse(text)), source: resolved };
  }

  throw new Error(
    `Unknown registry spec: ${s} (try embedded item, URL, or path to .json)`,
  );
}
