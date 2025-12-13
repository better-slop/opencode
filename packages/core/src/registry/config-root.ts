import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { ConfigRoot } from "./types";

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function normalize(p: string): string {
  return path.resolve(p);
}

function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);

  // TODO: windows support (drive letters + case-insensitive filesystems)

  const sep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c === p || c.startsWith(sep);
}

async function findProjectRoot(cwd: string): Promise<string> {
  let cur = normalize(cwd);

  while (true) {
    const candidate = path.join(cur, ".opencode");
    if (await isDir(candidate)) {
      return cur;
    }

    const parent = path.dirname(cur);
    if (parent === cur) {
      return normalize(cwd);
    }
    cur = parent;
  }
}

export async function resolveConfigRoot(
  cwd: string,
  home = os.homedir(),
): Promise<ConfigRoot> {
  const abs = normalize(cwd);

  const globals = [
    path.join(home, ".config", "opencode"),
    path.join(home, ".opencode"),
  ];

  for (const dir of globals) {
    if (isInside(abs, dir)) {
      return {
        kind: "global",
        rootDir: dir,
        opencodeDir: dir,
        configPath: path.join(dir, "opencode.jsonc"),
      };
    }
  }

  const root = await findProjectRoot(abs);
  const dir = path.join(root, ".opencode");

  return {
    kind: "project",
    rootDir: root,
    opencodeDir: dir,
    configPath: path.join(dir, "opencode.jsonc"),
  };
}
