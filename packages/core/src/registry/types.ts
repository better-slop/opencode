export type OCXItemKind = "tool" | "agent" | "command" | "themes";

export type ConfigRootKind = "project" | "global";

export type ConfigRoot = {
  kind: ConfigRootKind;
  rootDir: string;
  opencodeDir: string;
  configPath: string;
};

export type RegistryItemSchemaVersion = 1;

export type RegistryItemV1 = {
  schemaVersion: RegistryItemSchemaVersion;
  kind: OCXItemKind;
  name: string;
  description?: string;
  registryDependencies?: string[];
  files: Array<{
    path: string;
    content: string;
    mode?: "0644" | "0755";
  }>;
  entry?: string;
  postinstall?: {
    commands: string[];
    cwd?: string;
  };
};

export type RegistryItem = RegistryItemV1;

export type InstallPlan = {
  configRoot: ConfigRoot;
  item: {
    kind: OCXItemKind;
    name: string;
    source: string;
    targetDir: string;
    entryRel: string;
  };
  mkdirs: string[];
  writes: Array<{
    path: string;
    content: string;
    mode?: "0644" | "0755";
  }>;
  configEdits: Array<{
    jsonPath: Array<string | number>;
    value: unknown;
  }>;
  postinstall: null | {
    commands: string[];
    cwd: string;
  };
  dependencies: {
    // TODO: decide bun add defaults
    packagesToAdd?: string[];
  };
};

export type ApplyInstallResult = {
  wroteFiles: string[];
  editedConfigPath: string;
  ranPostinstall: boolean;
};
