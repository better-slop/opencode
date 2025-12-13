import type { RegistryItem } from "./types";
import { fetchRegistryItem } from "./registry";

export type ResolvedItem = {
  item: RegistryItem;
  source: string;
};

export async function resolveRegistryTree(
  specs: string[],
  opts: { cwd: string },
): Promise<ResolvedItem[]> {
  const map = new Map<string, ResolvedItem>();
  const visiting = new Set<string>();
  const out: ResolvedItem[] = [];

  async function visit(spec: string): Promise<void> {
    const res = await fetchRegistryItem(spec, opts);
    const key = `${res.item.kind}/${res.item.name}`;

    if (map.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Registry dependency cycle detected at ${key}`);
    }

    visiting.add(key);

    for (const dep of res.item.registryDependencies ?? []) {
      await visit(dep);
    }

    visiting.delete(key);
    map.set(key, res);
    out.push(res);
  }

  for (const spec of specs) {
    await visit(spec);
  }

  return out;
}
