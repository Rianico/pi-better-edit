/**
 * pi-lens bridge configuration — the on-disk `lens.bridge` setting and its precedence ladder.
 *
 * WHY a seam: the mode is read on every served-row notification and written only by the
 * `/pi-better-edit` command, so both sides must agree on one ladder — env, then project file,
 * then global file, then the `auto` default. A malformed config is never an error: it degrades
 * to "not configured" so a hand-edited file can never break editing.
 *
 * Shape of the shared config file (`CONFIG_REL`, owned by `src/json-config.ts`):
 * `{ "$schema": <LENS_SCHEMA_ID>, "lens": { "bridge": "auto" | "on" | "off" } }`
 * (documented by `schemas/pi-better-edit.json`). Unknown keys are preserved on write.
 *
 * The FILE, the scopes, the read and the preserving atomic write belong to
 * `src/json-config.ts`, which the store settings use too: one ladder, not one per settings owner.
 * This module owns only the `lens.*` keys.
 */
import { DomainError } from "../../domain-errors.js";
import {
  CONFIG_REL,
  CONFIG_SCHEMA_ID,
  configFilePath,
  isRecord,
  isConfigScope,
  readScopeConfig,
  updateConfigFile,
  type ConfigScope,
  type ConfigRung,
} from "../../json-config.js";

export type LensBridgeMode = "auto" | "on" | "off";
/** The ladder's scopes ARE the config seam's scopes — one enumeration under two names. */
export type LensBridgeScope = ConfigScope;

/** Environment override; wins over both files. Values outside the enum are ignored, not fatal. */
export const LENS_BRIDGE_ENV_VAR = "PI_BETTER_EDIT_LENS_BRIDGE";

/** Config location relative to the project root or to the home directory. */
export const LENS_CONFIG_REL = CONFIG_REL;

/** Published schema id written into config files (see `schemas/pi-better-edit.json`). */
export const LENS_SCHEMA_ID = CONFIG_SCHEMA_ID;

const LENS_BRIDGE_MODES: readonly LensBridgeMode[] = ["auto", "on", "off"];

/** Runtime guard for values arriving from files, env vars and command arguments. */
export function isLensBridgeMode(value: unknown): value is LensBridgeMode {
  return typeof value === "string" && LENS_BRIDGE_MODES.some((mode) => mode === value);
}

/** Runtime guard for the two config scopes. */
export function isLensBridgeScope(value: unknown): value is LensBridgeScope {
  return isConfigScope(value);
}

function readScopeMode(scope: LensBridgeScope, cwd: string): LensBridgeMode | undefined {
  const config = readScopeConfig(scope, cwd);
  if (config === undefined) return undefined;
  const lens = config.lens;
  if (!isRecord(lens)) return undefined;
  return isLensBridgeMode(lens.bridge) ? lens.bridge : undefined;
}

/**
 * Both scopes' configured modes. Pure read: never creates the directory or the file, never
 * throws. A scope is absent (rather than `undefined`-valued) when its file is missing or holds a
 * value outside the enum.
 */
export function readLensBridgeConfig(cwd: string): {
  project?: LensBridgeMode;
  global?: LensBridgeMode;
} {
  const project = readScopeMode("project", cwd);
  const global = readScopeMode("global", cwd);
  return {
    ...(project !== undefined ? { project } : {}),
    ...(global !== undefined ? { global } : {}),
  };
}

function readEnvMode(): LensBridgeMode | undefined {
  const raw = process.env[LENS_BRIDGE_ENV_VAR];
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return isLensBridgeMode(normalized) ? normalized : undefined;
}

/**
 * The effective mode and the rung that supplied it. `default` is the built-in `"auto"`, which is a
 * value of the ladder rather than a rung of the file.
 */
export interface EffectiveLensBridgeMode {
  readonly mode: LensBridgeMode;
  readonly source: ConfigRung;
}

/**
 * Effective mode WITH its rung: env override, then project, then global, then `"auto"`. Never throws.
 * This is the ladder itself, and `resolveEffectiveLensMode` is its value half, so the two cannot
 * disagree about which rung won — a caller that has to NAME the winner (the `/pi-better-edit` status
 * text does) reads it here instead of re-walking the two files.
 */
export function resolveEffectiveLensModeWithSource(cwd: string): EffectiveLensBridgeMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return { mode: fromEnv, source: "env" };
  const config = readLensBridgeConfig(cwd);
  if (config.project !== undefined) return { mode: config.project, source: "project" };
  if (config.global !== undefined) return { mode: config.global, source: "global" };
  return { mode: "auto", source: "default" };
}

/** Effective mode: env override, then project, then global, then `"auto"`. Never throws. */
export function resolveEffectiveLensMode(cwd: string): LensBridgeMode {
  return resolveEffectiveLensModeWithSource(cwd).mode;
}

/**
 * Persist `mode` for `scope`, preserving unknown top-level keys and other `lens.*` keys already
 * in the file. Creates the directory as needed and replaces the file atomically (sibling temp
 * file + rename, same filesystem). Throws `E_INTERNAL_INVARIANT` — and writes nothing — for a
 * mode or scope outside the enum, which no caller can reach: the command and the overlay narrow
 * both to the enum.
 */
export function saveLensBridgeConfig(
  mode: LensBridgeMode,
  scope: LensBridgeScope,
  cwd: string,
): { path: string } {
  if (!isLensBridgeMode(mode)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown lens bridge mode "${String(mode)}".`,
    });
  }
  if (!isLensBridgeScope(scope)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown lens bridge scope "${String(scope)}".`,
    });
  }

  const path = configFilePath(scope, cwd);
  // WHY: only `lens.bridge` is ours to set — an existing `$schema` is a deliberate editor-time
  // WHY: choice and unknown top-level or `lens.*` keys belong to the user, so all of them survive.
  updateConfigFile(path, (existing) => ({
    ...existing,
    lens: { ...(isRecord(existing.lens) ? existing.lens : {}), bridge: mode },
  }));

  return { path };
}
