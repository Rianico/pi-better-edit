/**
 * Bash view setting — the `bash.view` key of the shared config file, resolved
 * through the shared ladder: env override, then project file, then global file,
 * then the default.
 *
 * WHY the interception is configurable at all: the view replacement swaps bash
 * stdout for anchored lines, which is a display decision about the model's own
 * session — an operator who would rather see raw output turns one key off, and
 * every other session keeps the default without restating it.
 *
 * WHY a warning is part of the contract here: a dropped setting changes what the
 * session shows, so an existing-but-unusable file is reported through `onWarn`
 * while the value falls through the ladder. A missing file warns about nothing,
 * and a value outside the accepted shape is ignored exactly as the sibling
 * ladders ignore one. Nothing here throws on the read side.
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

export type BashViewMode = "on" | "off";

/** Environment override; wins over both files. Values outside the enum are ignored, not fatal. */
export const BASH_VIEW_ENV_VAR = "PI_BETTER_EDIT_BASH_VIEW";

/** The mode an unconfigured session gets: interception stays on. */
export const BASH_VIEW_DEFAULT: BashViewMode = "on";

const BASH_VIEW_MODES: readonly BashViewMode[] = ["on", "off"];

/** The single key this owner reads and writes under `bash`. */
const BASH_VIEW_KEY = "view";

/** Runtime guard for values arriving from files, env vars and command arguments. */
export function isBashViewMode(value: unknown): value is BashViewMode {
  return typeof value === "string" && BASH_VIEW_MODES.some((mode) => mode === value);
}

/** Runtime guard for the two config scopes. */
export function isBashViewScope(value: unknown): value is ConfigScope {
  return isConfigScope(value);
}

/** One scope file's mode, or `undefined` when the file carries no accepted value. */
function readScopeMode(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): BashViewMode | undefined {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return undefined;
  const bash = config.bash;
  if (!isRecord(bash)) return undefined;
  const mode = bash[BASH_VIEW_KEY];
  return isBashViewMode(mode) ? mode : undefined;
}

/**
 * Both scopes' configured modes. Pure read: never creates the directory or the file, never
 * throws. A scope is absent (rather than `undefined`-valued) when its file is missing or holds a
 * value outside the enum.
 */
export function readBashViewConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: BashViewMode; global?: BashViewMode } {
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

function readEnvMode(): BashViewMode | undefined {
  const mode = envText(BASH_VIEW_ENV_VAR)?.toLowerCase();
  return mode !== undefined && isBashViewMode(mode) ? mode : undefined;
}

/**
 * One resolved setting: the value the session will use, and the rung of the ladder
 * that supplied it.
 */
export interface ResolvedBashViewMode {
  readonly value: BashViewMode;
  readonly source: ConfigRung;
}

/**
 * The effective mode WITH its rung: env override, then project, then global, then `"on"`.
 * Never throws. This is the ladder itself, and `resolveBashViewMode` is its value half, so the
 * two cannot disagree about which rung won — a caller that has to NAME the winner (the
 * `/pi-better-edit` status text does) reads it here instead of re-walking the two files.
 */
export function resolveBashViewModeWithSource(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedBashViewMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const config = readBashViewConfig(cwd, onWarn);
  if (config.project !== undefined) return { value: config.project, source: "project" };
  if (config.global !== undefined) return { value: config.global, source: "global" };
  return { value: BASH_VIEW_DEFAULT, source: "default" };
}

/** Effective mode: env override, then project, then global, then `"on"`. Never throws. */
export function resolveBashViewMode(cwd: string, onWarn?: ConfigOnWarn): BashViewMode {
  return resolveBashViewModeWithSource(cwd, onWarn).value;
}

/**
 * Persist `mode` for `scope`, preserving unknown top-level keys and other `bash.*` keys already
 * in the file. Creates the directory as needed and replaces the file atomically. Throws
 * `E_INTERNAL_INVARIANT` — and writes nothing — for a value outside its accepted shape or a
 * scope outside the enum: a defensive guard, unreachable from the command and the overlay,
 * because a silently dropped value would read back as the default.
 */
export function saveBashViewConfig(
  mode: BashViewMode,
  scope: ConfigScope,
  cwd: string,
): { path: string } {
  if (!isBashViewMode(mode)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown bash view mode "${String(mode)}".`,
    });
  }
  if (!isBashViewScope(scope)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown bash view scope "${String(scope)}".`,
    });
  }

  const path = configFilePath(scope, cwd);
  // WHY: only `bash.view` is ours to set — an existing `$schema` is a deliberate editor-time
  // WHY: choice and unknown top-level or `bash.*` keys belong to the user, so all of them survive.
  updateConfigFile(path, (existing) => ({
    ...existing,
    bash: { ...(isRecord(existing.bash) ? existing.bash : {}), [BASH_VIEW_KEY]: mode },
  }));

  return { path };
}
