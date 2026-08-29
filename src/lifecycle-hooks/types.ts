import type { ServedRow } from "../hashline/served.js";
import type { EditDetails } from "../edit-response.js";
import type { NormFile, ReadNormOptions } from "../file-reader.js";
import type { LFile, LoadFileOptions } from "../file-kind.js";
import type { Hasher } from "../hashline/hasher.js";

export type ToolResultEvent = {
  toolName: string;
  isError: boolean;
  input?: Record<string, unknown>;
  content?: Array<{ type: string; text: string }>;
  details?: EditDetails;
};

export type ToolContext = {
  cwd: string;
  sessionManager?: { getSessionId(): string };
  ui: { notify: (msg: string, level: string) => void };
};

export type LifecycleDeps = {
  initHasher: () => Promise<Hasher>;
  pruneMissingAll: () => Promise<void>;
  clearUndo: (path: string) => Promise<void>;
  resolveTarget: (path: string) => Promise<string>;
  toCwd: (path: string, cwd: string) => string;
  valAccess: (resolved: string, display: string) => Promise<void>;
  loadFileKindAndText: (path: string, opts?: LoadFileOptions) => Promise<LFile>;
  readNormFile: (
    displayPath: string,
    cwd: string,
    opts?: ReadNormOptions,
  ) => Promise<NormFile>;
  fmtReadPreview: (
    normalized: string,
    opts: Record<string, never>,
    fileHashes: string[],
    absolutePath: string,
    maxBytes: number,
    maxLines: number,
  ) => Promise<{ text: string; served: ServedRow[] }>;
  recordDiffServes: (input: {
    sessionKey: string;
    path: string;
    servedRows: ServedRow[];
    resultLineCount?: number;
    firstChangedLine?: number;
  }) => Promise<void>;
  sessionKeyFor: (ctx?: { sessionManager?: { getSessionId(): string } }) => string;
  finalizeToolResult: (details: EditDetails) => {
    content: Array<{ type: string; text: string }>;
    servedRows?: ServedRow[];
  };
  visLines: (s: string) => string[];
};

export type WriteResult =
  | { handled: false }
  | { handled: true; content: Array<{ type: string; text: string }> };

export type EditResult =
  | { handled: false }
  | { handled: true; content?: Array<{ type: string; text: string }> };
