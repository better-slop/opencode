export type JSONCError = {
  _tag: "JSONCError";
  message: string;
};

export type RegistryItemParseError = {
  _tag: "RegistryItemParseError";
  message: string;
};

export type FetchRegistryItemError =
  | { _tag: "MissingSpec" }
  | { _tag: "UnknownSpec"; spec: string }
  | { _tag: "EmbeddedReadFailed"; name: string; cause: unknown }
  | { _tag: "FetchFailed"; url: string; status?: number; cause?: unknown }
  | { _tag: "FileReadFailed"; path: string; cause: unknown }
  | { _tag: "JSONParseFailed"; source: string; cause: unknown }
  | RegistryItemParseError;

export type ResolveRegistryTreeError =
  | { _tag: "DependencyCycle"; at: string }
  | FetchRegistryItemError;

export type InstallError =
  | { _tag: "NoPlans" }
  | { _tag: "MissingConfigRoot" }
  | { _tag: "InvalidRegistryFilePath"; path: string; message: string }
  | { _tag: "WriteOutsideTargetDir"; path: string }
  | { _tag: "TargetAlreadyExists"; path: string }
  | { _tag: "IOError"; operation: string; path?: string; cause: unknown }
  | { _tag: "PostinstallFailed"; cmd: string; code: number }
  | JSONCError;
