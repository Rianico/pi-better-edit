/**
 * Span mode setting — the `edit.span_mode` key, whose literal spelling comes from the span-mode
 * spec, resolved through the shared ladder: environment override, then project file, then global
 * file, then the default `hint`.
 *
 * An invalid value is ignored at its rung, so the next rung answers; an existing-but-unusable
 * file is reported through `onWarn`. A missing file warns about nothing, and nothing here throws
 * on the read side.
 */
import {
  isRecord,
  readScopeConfig,
  type ConfigOnWarn,
  type ConfigRung,
  type ConfigScope,
} from "./json-config.js";

export type SpanMode = "hint" | "strict";

/** Environment override; wins over both files. Values outside the enum are ignored, not fatal. */
export const SPAN_MODE_ENV_VAR = "PI_BETTER_EDIT_SPAN_MODE";

/** The mode an unconfigured session gets: anchors are reported as a hint. */
export const SPAN_MODE_DEFAULT: SpanMode = "hint";

const SPAN_MODE_VALUES: readonly SpanMode[] = ["hint", "strict"];

/** The subtree and key this owner reads, spelled exactly as the span-mode spec spells them. */
const SPAN_MODE_SUBTREE = "edit";
const SPAN_MODE_KEY = "span_mode";

/** Runtime guard for values arriving from files and the environment variable. */
export function isSpanMode(value: unknown): value is SpanMode {
  return typeof value === "string" && SPAN_MODE_VALUES.some((mode) => mode === value);
}

/** One scope file's mode, or `undefined` when the file carries no accepted value. */
function readScopeMode(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): SpanMode | undefined {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return undefined;
  const edit = config[SPAN_MODE_SUBTREE];
  if (!isRecord(edit)) return undefined;
  const mode = edit[SPAN_MODE_KEY];
  return isSpanMode(mode) ? mode : undefined;
}

/**
 * Both scopes' configured modes. Pure read: never creates the directory or the file, never
 * throws. A scope is absent (rather than `undefined`-valued) when its file is missing or holds a
 * value outside the enum.
 */
export function readSpanModeConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: SpanMode; global?: SpanMode } {
  const project = readScopeMode("project", cwd, onWarn);
  const global = readScopeMode("global", cwd, onWarn);
  return {
    ...(project !== undefined ? { project } : {}),
    ...(global !== undefined ? { global } : {}),
  };
}

/** A trimmed environment value, or `undefined` when the variable is unset. */
function envText(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined ? undefined : raw.trim();
}

/** Case-sensitive on purpose: the ticket pins `hint` and `strict` in lower case. */
function readEnvMode(): SpanMode | undefined {
  const mode = envText(SPAN_MODE_ENV_VAR);
  return mode !== undefined && isSpanMode(mode) ? mode : undefined;
}

/**
 * One resolved setting: the value the session will use, and the rung of the ladder
 * that supplied it.
 */
export interface ResolvedSpanMode {
  readonly value: SpanMode;
  readonly source: ConfigRung;
}

/**
 * The effective mode WITH its rung: env override, then project, then global, then `"hint"`.
 * Never throws. This is the ladder itself, and `resolveSpanMode` is its value half, so the two
 * cannot disagree about which rung won — a caller that has to NAME the winner reads it here
 * instead of re-walking the two files.
 */
export function resolveSpanModeWithSource(cwd: string, onWarn?: ConfigOnWarn): ResolvedSpanMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const config = readSpanModeConfig(cwd, onWarn);
  if (config.project !== undefined) return { value: config.project, source: "project" };
  if (config.global !== undefined) return { value: config.global, source: "global" };
  return { value: SPAN_MODE_DEFAULT, source: "default" };
}

/** Effective mode: env override, then project, then global, then `"hint"`. Never throws. */
export function resolveSpanMode(cwd: string, onWarn?: ConfigOnWarn): SpanMode {
  return resolveSpanModeWithSource(cwd, onWarn).value;
}
