import type { RegistryItemV1 } from "./types";

const TOOLS = {
  hello: new URL("./embedded/tools/hello.ts", import.meta.url),
} as const;

export type EmbeddedName = keyof typeof TOOLS;

export function listEmbeddedItems(): EmbeddedName[] {
  return Object.keys(TOOLS) as EmbeddedName[];
}

export async function getEmbeddedRegistryItem(
  name: string,
): Promise<RegistryItemV1 | null> {
  const s = name.trim();
  const key = s.includes("/") ? (s.split("/").at(-1) ?? "") : s;

  if (key in TOOLS) {
    const k = key as EmbeddedName;
    const url = TOOLS[k];
    const content = await Bun.file(url).text();

    return {
      schemaVersion: 1,
      kind: "tool",
      name: k,
      description: "Embedded ocx registry item",
      files: [
        {
          path: "index.ts",
          content,
        },
      ],
      entry: "index.ts",
    };
  }

  return null;
}
