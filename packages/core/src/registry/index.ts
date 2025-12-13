export { resolveConfigRoot } from "./config-root";
export { fetchRegistryItem } from "./registry";
export { resolveRegistryTree } from "./resolve";
export { planInstalls, applyInstallPlans, defaultHomeDir } from "./install";
export { listEmbeddedItems } from "./embedded";

export type {
  OCXItemKind,
  ConfigRoot,
  RegistryItem,
  RegistryItemV1,
  InstallPlan,
  ApplyInstallResult,
} from "./types";
