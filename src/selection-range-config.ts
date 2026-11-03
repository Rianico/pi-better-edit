/**
 * Selection-range note setting — the `read.selectionRange` key, resolved through the shared ladder:
 * environment override, then project file, then global file, then the default `on`.
 *
 * Mirrors `bash.view`: a missing file is silent, an existing-but-unusable file warns and falls
 * through, an invalid value is ignored at its rung, and the read side never throws.
 */
import {
  isRecord,
  readScopeConfig,
  type ConfigOnWarn,
  type ConfigRung,
  type ConfigScope,
} from "./json-config.js";

export type SelectionRangeMode = "on" | "off";

/** Environment override; values outside the enum are ignored, not fatal. */
const SELECTION_RANGE_ENV_VAR = "PI_BETTER_EDIT_READ_SELECTION_RANGE";

/** An unconfigured session expands by default. */
const SELECTION_RANGE_DEFAULT: SelectionRangeMode = "on";

const SELECTION_RANGE_MODES: readonly SelectionRangeMode[] = ["on", "off"];

/** The single key this owner reads and writes under `read`. */
const SELECTION_RANGE_KEY = "selectionRange";

function isSelectionRangeMode(value: unknown): value is SelectionRangeMode {
  return typeof value === "string" && SELECTION_RANGE_MODES.some((mode) => mode === value);
}

function readScopeMode(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): SelectionRangeMode | undefined {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return undefined;
  const read = config.read;
  if (!isRecord(read)) return undefined;
  const mode = read[SELECTION_RANGE_KEY];
  return isSelectionRangeMode(mode) ? mode : undefined;
}

function readSelectionRangeConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: SelectionRangeMode; global?: SelectionRangeMode } {
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

function readEnvMode(): SelectionRangeMode | undefined {
  const mode = envText(SELECTION_RANGE_ENV_VAR)?.toLowerCase();
  return mode !== undefined && isSelectionRangeMode(mode) ? mode : undefined;
}

export interface ResolvedSelectionRangeMode {
  readonly value: SelectionRangeMode;
  readonly source: ConfigRung;
}

export function resolveSelectionRangeModeWithSource(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedSelectionRangeMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const config = readSelectionRangeConfig(cwd, onWarn);
  if (config.project !== undefined) return { value: config.project, source: "project" };
  if (config.global !== undefined) return { value: config.global, source: "global" };
  return { value: SELECTION_RANGE_DEFAULT, source: "default" };
}

export function resolveSelectionRangeMode(cwd: string, onWarn?: ConfigOnWarn): SelectionRangeMode {
  return resolveSelectionRangeModeWithSource(cwd, onWarn).value;
}
