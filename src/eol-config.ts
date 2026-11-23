/**
 * Effective EOL setting — the top-level `eol` key, resolved through the shared ladder: env
 * override, then project file, then global file, then `AUTO`.
 * A forced setting names its terminator; `AUTO` takes the file's most frequent terminator and
 * falls back to the system one, so one resolved value drives every write decision.
 * Mirrors `bash.view`: a missing file is silent, an existing-but-unusable file warns and falls
 * through, a value outside the enum is ignored at its rung, and the read side never throws.
 */
import { countLineEndings, type LineEnding } from "./edit-diff.js";
import {
  readScopeConfig,
  type ConfigOnWarn,
  type ConfigRung,
  type ConfigScope,
} from "./json-config.js";

export type EolSetting = "AUTO" | "LF" | "CRLF" | "CR";

/** Environment override; wins over both files. Values outside the enum are ignored, not fatal. */
export const EOL_ENV_VAR = "PI_BETTER_EDIT_EOL";

/** The setting an unconfigured session gets: keep the file's own dominant terminator. */
export const EOL_DEFAULT: EolSetting = "AUTO";

const EOL_SETTINGS: readonly EolSetting[] = ["AUTO", "LF", "CRLF", "CR"];

/** The one TOP-LEVEL key this owner reads: `eol` is not nested under any other owner's block. */
const EOL_KEY = "eol";

/** The terminator each forced setting names; `AUTO` is absent and leaves the choice to the file. */
const FORCED_ENDINGS: Readonly<Record<Exclude<EolSetting, "AUTO">, LineEnding>> = {
  LF: "\n",
  CRLF: "\r\n",
  CR: "\r",
};

/** Runtime guard for values arriving from files and env vars. */
export function isEolSetting(value: unknown): value is EolSetting {
  return typeof value === "string" && EOL_SETTINGS.some((setting) => setting === value);
}

/**
 * One scope file's setting, or `undefined` when it carries no accepted value.
 * The key is read VERBATIM: a lowercase `lf` is outside the enum and is ignored, exactly as the
 * sibling ladders ignore a value outside theirs, so a hand-edited file cannot silently force a
 * terminator with a spelling this module never writes.
 */
function readScopeSetting(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): EolSetting | undefined {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return undefined;
  const setting = config[EOL_KEY];
  return isEolSetting(setting) ? setting : undefined;
}

/**
 * Both scopes' configured settings. Pure read: never creates the directory or the file, never
 * throws. A scope is absent (rather than `undefined`-valued) when its file is missing or holds a
 * value outside the enum.
 */
export function readEolConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: EolSetting; global?: EolSetting } {
  const project = readScopeSetting("project", cwd, onWarn);
  const global = readScopeSetting("global", cwd, onWarn);
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

function readEnvSetting(): EolSetting | undefined {
  const setting = envText(EOL_ENV_VAR)?.toUpperCase();
  return setting !== undefined && isEolSetting(setting) ? setting : undefined;
}

/** One resolved setting: the value the session will use, and the rung that supplied it. */
export interface ResolvedEolSetting {
  readonly value: EolSetting;
  readonly source: ConfigRung;
}

/**
 * True when the setting names its own terminator, which also means an explicit rung supplied it:
 * `AUTO` is the only value the `default` rung ever produces, so a forced setting is never `default`.
 */
function isForcedSetting(setting: ResolvedEolSetting): setting is {
  readonly value: Exclude<EolSetting, "AUTO">;
  readonly source: Exclude<ConfigRung, "default">;
} {
  return setting.value !== "AUTO";
}

/** The effective setting WITH its rung: env override, then project, then global, then `AUTO`. */
export function resolveEolSettingWithSource(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedEolSetting {
  const fromEnv = readEnvSetting();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const config = readEolConfig(cwd, onWarn);
  if (config.project !== undefined) return { value: config.project, source: "project" };
  if (config.global !== undefined) return { value: config.global, source: "global" };
  return { value: EOL_DEFAULT, source: "default" };
}

/**
 * Every rung that can decide a terminator: the ladder's forced three, plus the file and the OS.
 * `default` is absent because `AUTO` always names a terminator, so a consumer switch stays
 * exhaustive.
 */
export type EolSource = Exclude<ConfigRung, "default"> | "file" | "system";

/** One resolved terminator: the bytes a write uses, and what decided them. */
export interface ResolvedEffectiveEol {
  readonly value: LineEnding;
  readonly source: EolSource;
}

/**
 * The most frequent terminator kind: a CRLF pair counts once, ties prefer LF, then CRLF, then CR.
 * `undefined` means the content carries no terminator at all, so the caller falls back to the OS.
 */
export function dominantEnding(content: string): LineEnding | undefined {
  const counts = countLineEndings(content);
  const best = Math.max(counts.crlf, counts.lf, counts.cr);
  if (best === 0) return undefined;
  if (counts.lf === best) return "\n";
  if (counts.crlf === best) return "\r\n";
  return "\r";
}

/** The terminator a file with no terminator of its own gets on this platform. */
function systemEnding(): LineEnding {
  return process.platform === "win32" ? "\r\n" : "\n";
}

/**
 * The EOL one write uses, with what decided it: a forced setting names its own ladder rung,
 * `AUTO` names `"file"` for the file's dominant terminator, and `"system"` when it has none.
 */
export function resolveEffectiveEol(
  content: string,
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedEffectiveEol {
  const setting = resolveEolSettingWithSource(cwd, onWarn);
  if (isForcedSetting(setting)) {
    return { value: FORCED_ENDINGS[setting.value], source: setting.source };
  }
  const dominant = dominantEnding(content);
  if (dominant !== undefined) return { value: dominant, source: "file" };
  return { value: systemEnding(), source: "system" };
}
