import { Effect } from "effect";
import type { RegistryItemV1 } from "./types";

const TOOLS = {
  hello: new URL("./embedded/tools/hello.ts", import.meta.url),
} as const;

export type EmbeddedName = keyof typeof TOOLS;

export function listEmbeddedItems(): EmbeddedName[] {
  return Object.keys(TOOLS) as EmbeddedName[];
}

export type EmbeddedReadFailed = {
  _tag: "EmbeddedReadFailed";
  name: string;
  cause: unknown;
};

export function getEmbeddedRegistryItemEffect(
  name: string,
): Effect.Effect<RegistryItemV1 | null, EmbeddedReadFailed> {
  const s = name.trim();
  const key = s.includes("/") ? (s.split("/").at(-1) ?? "") : s;

  if (!(key in TOOLS)) return Effect.succeed(null);

  const k = key as EmbeddedName;
  const url = TOOLS[k];

  return Effect.tryPromise({
    try: () => Bun.file(url).text(),
    catch: (cause): EmbeddedReadFailed => ({ _tag: "EmbeddedReadFailed", name: k, cause }),
  }).pipe(
    Effect.map((content) => ({
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
    })),
  );
}
