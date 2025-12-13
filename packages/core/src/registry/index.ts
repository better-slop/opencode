export { applyInstallPlans, defaultHomeDir, planInstalls } from "./install";
export { resolveConfigRoot } from "./config-root";
export { listEmbeddedItems } from "./embedded";
export { fetchRegistryItem } from "./registry";
export { resolveRegistryTree } from "./resolve";
export { isErr, isOk } from "./result";

export type {
  FetchRegistryItemError,
  InstallError,
  JSONCError,
  RegistryItemParseError,
  ResolveRegistryTreeError,
} from "./errors";
export type { Err, Ok, Result } from "./result";
export type { ResolvedItem } from "./resolve";
export type {
  ApplyInstallResult,
  ConfigRoot,
  InstallPlan,
  OCXItemKind,
  RegistryItem,
  RegistryItemV1,
} from "./types";
