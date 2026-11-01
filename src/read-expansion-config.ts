/**
 * Read expansion setting — the `read.expansion` key, resolved through the shared ladder:
 * environment override, then project file, then global file, then the default `on`.
 *
 * Mirrors `bash.view`: a missing file is silent, an existing-but-unusable file warns and falls
 * through, an invalid value is ignored at its rung, and the read side never throws.
 */
import { DomainError } from "./domain-errors.js";
import {
  configFilePath,
  isConfigScope,
  isRecord,
  readScopeConfig,
  updateConfigFile,
  type ConfigOnWarn,
  type ConfigRung,
  type ConfigScope,
} from "./json-config.js";

export type ReadExpansionMode = "on" | "off";

/** Environment override; values outside the enum are ignored, not fatal. */
export const READ_EXPANSION_ENV_VAR = "PI_BETTER_EDIT_READ_EXPANSION";

/** An unconfigured session expands by default. */
export const READ_EXPANSION_DEFAULT: ReadExpansionMode = "on";

const READ_EXPANSION_MODES: readonly ReadExpansionMode[] = ["on", "off"];

/** The single key this owner reads and writes under `read`. */
const READ_EXPANSION_KEY = "expansion";

export function isReadExpansionMode(value: unknown): value is ReadExpansionMode {
  return typeof value === "string" && READ_EXPANSION_MODES.some((mode) => mode === value);
}

export function isReadExpansionScope(value: unknown): value is ConfigScope {
  return isConfigScope(value);
}

function readScopeMode(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): ReadExpansionMode | undefined {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return undefined;
  const read = config.read;
  if (!isRecord(read)) return undefined;
  const mode = read[READ_EXPANSION_KEY];
  return isReadExpansionMode(mode) ? mode : undefined;
}

export function readReadExpansionConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: ReadExpansionMode; global?: ReadExpansionMode } {
  const project = readScopeMode("project", cwd, onWarn);
  const global = readScopeMode("global", cwd, onWarn);
  return {
    ...(project !== undefined ? { project } : {}),
    ...(global !== undefined ? { global } : {}),
  };
}

function envText(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined ? undefined : raw.trim();
}

function readEnvMode(): ReadExpansionMode | undefined {
  const mode = envText(READ_EXPANSION_ENV_VAR)?.toLowerCase();
  return mode !== undefined && isReadExpansionMode(mode) ? mode : undefined;
}

export interface ResolvedReadExpansionMode {
  readonly value: ReadExpansionMode;
  readonly source: ConfigRung;
}

export function resolveReadExpansionModeWithSource(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedReadExpansionMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const config = readReadExpansionConfig(cwd, onWarn);
  if (config.project !== undefined) return { value: config.project, source: "project" };
  if (config.global !== undefined) return { value: config.global, source: "global" };
  return { value: READ_EXPANSION_DEFAULT, source: "default" };
}

export function resolveReadExpansionMode(cwd: string, onWarn?: ConfigOnWarn): ReadExpansionMode {
  return resolveReadExpansionModeWithSource(cwd, onWarn).value;
}

export function saveReadExpansionConfig(
  mode: ReadExpansionMode,
  scope: ConfigScope,
  cwd: string,
): { path: string } {
  if (!isReadExpansionMode(mode)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown read expansion mode "${String(mode)}".`,
    });
  }
  if (!isReadExpansionScope(scope)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown read expansion scope "${String(scope)}".`,
    });
  }

  const path = configFilePath(scope, cwd);
  // WHY: only `read.expansion` is ours to set; every other top-level and `read.*` key survives.
  updateConfigFile(path, (existing) => ({
    ...existing,
    read: { ...(isRecord(existing.read) ? existing.read : {}), [READ_EXPANSION_KEY]: mode },
  }));

  return { path };
}
