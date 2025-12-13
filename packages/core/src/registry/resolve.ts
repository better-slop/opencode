import { Effect } from "effect";
import type { ResolveRegistryTreeError } from "./errors";
import { runEffect, type Result } from "./result";
import { fetchRegistryItemEffect } from "./registry";
import type { RegistryItem } from "./types";

export type ResolvedItem = {
  item: RegistryItem;
  source: string;
};

function dependencyCycle(at: string): ResolveRegistryTreeError {
  return { _tag: "DependencyCycle", at };
}

export function resolveRegistryTreeEffect(
  specs: string[],
  opts: { cwd: string },
): Effect.Effect<ResolvedItem[], ResolveRegistryTreeError> {
  const map = new Map<string, ResolvedItem>();
  const visiting = new Set<string>();
  const out: ResolvedItem[] = [];

  const visit = (spec: string): Effect.Effect<void, ResolveRegistryTreeError> =>
    fetchRegistryItemEffect(spec, opts).pipe(
      Effect.flatMap((res) => {
        const key = `${res.item.kind}/${res.item.name}`;

        if (map.has(key)) return Effect.void;
        if (visiting.has(key)) return Effect.fail(dependencyCycle(key));

        const deps = res.item.registryDependencies ?? [];

        return Effect.sync(() => {
          visiting.add(key);
        }).pipe(
          Effect.zipRight(
            Effect.forEach(deps, (dep) => visit(dep), { concurrency: 1 }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  visiting.delete(key);
                }),
              ),
            ),
          ),
          Effect.zipRight(
            Effect.sync(() => {
              map.set(key, res);
              out.push(res);
            }),
          ),
        );
      }),
    );

  return Effect.forEach(specs, (spec) => visit(spec), { concurrency: 1 }).pipe(Effect.as(out));
}

export async function resolveRegistryTree(
  specs: string[],
  opts: { cwd: string },
): Promise<Result<ResolvedItem[], ResolveRegistryTreeError>> {
  return runEffect(resolveRegistryTreeEffect(specs, opts));
}
