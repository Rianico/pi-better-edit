/**
 * `bash.multiFile` — the multi-file view caps (ADR-0049 M6), the sibling of `bash.view`.
 *
 * WHY the caps are settings: they are operator policy over how much one bash result may spend, not
 * a correctness bound (the ADR's safety bound IS the allowed range — a config can only lower a cap,
 * never raise it past the hard maximum). They resolve per KEY through the shared project/global
 * ladder so "the project file is set" never stands in for "this key came from the project file".
 *
 * WHY an out-of-range value warns instead of falling through silently: ADR-0049 M6 requires the
 * warning, and a dropped cap changes how much the session serves — the silent drop this ladder
 * refuses to make at file level is the same drop one level down. A MISSING key still warns about
 * nothing, and a broken file keeps warning exactly once through `readScopeConfig`.
 *
 * This module never touches the filesystem itself: reads go through `readScopeConfig`, writes
 * through `updateConfigFile`, so the config file keeps one owner.
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

/** The two caps, both integers in their allowed range. */
export interface BashMultiFileSettings {
  readonly maxFiles: number;
  readonly maxRows: number;
}

/** One scope file's accepted keys; every key is optional and absent means "not set here". */
export type BashMultiFilePatch = Partial<BashMultiFileSettings>;

/** The key ADR-0049 M6 puts under `bash`. */
const BASH_MULTI_FILE_SUBTREE = "multiFile";

/** The per-key names, in report order. */
const BASH_MULTI_FILE_KEYS = {
  maxFiles: "maxFiles",
  maxRows: "maxRows",
} as const;

/** The declared defaults: an unconfigured session gets both. */
export const BASH_MULTI_FILE_DEFAULTS: BashMultiFileSettings = { maxFiles: 10, maxRows: 2000 };

/**
 * WHY the ranges are closed at the top: ADR-0049 M6 fixes them, and the upper bound is the safety
 * bound (the row cap fits the built-in bash result cap). Lowering is allowed — an operator may want
 * a tighter page — raising is not a supported way to exceed it.
 */
export const BASH_MULTI_FILE_LIMITS = {
  maxFiles: { min: 2, max: 10 },
  maxRows: { min: 1, max: 2000 },
} as const;

type BashMultiFileKey = keyof BashMultiFileSettings;

const KEY_ORDER: readonly BashMultiFileKey[] = [
  BASH_MULTI_FILE_KEYS.maxFiles,
  BASH_MULTI_FILE_KEYS.maxRows,
];

/** One cap's rung: the value the session will use and where it came from. */
interface ResolvedBashMultiFileCap {
  readonly value: number;
  readonly source: ConfigRung;
}

/** Both caps with their rungs — the shape `/pi-better-edit settings` reports. */
export interface ResolvedBashMultiFileSettings {
  readonly maxFiles: ResolvedBashMultiFileCap;
  readonly maxRows: ResolvedBashMultiFileCap;
}

function withinRange(value: unknown, limit: { min: number; max: number }): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= limit.min && value <= limit.max
  );
}

/** Runtime guard for `bash.multiFile.maxFiles` (integer, 2–10). */
export function isBashMultiFileMaxFiles(value: unknown): value is number {
  return withinRange(value, BASH_MULTI_FILE_LIMITS.maxFiles);
}

/** Runtime guard for `bash.multiFile.maxRows` (integer, 1–2000). */
export function isBashMultiFileMaxRows(value: unknown): value is number {
  return withinRange(value, BASH_MULTI_FILE_LIMITS.maxRows);
}

const GUARDS: Readonly<Record<BashMultiFileKey, (value: unknown) => value is number>> = {
  maxFiles: isBashMultiFileMaxFiles,
  maxRows: isBashMultiFileMaxRows,
};

/** Runtime guard for the two config scopes. */
export function isBashMultiFileScope(value: unknown): value is ConfigScope {
  return isConfigScope(value);
}

/** `2-10` / `1-2000`, the range text every warning and guard message uses. */
function rangeText(key: BashMultiFileKey): string {
  const limit = BASH_MULTI_FILE_LIMITS[key];
  return `${limit.min}-${limit.max}`;
}

/**
 * One scope file's accepted caps. Reads only; a key that is present but unusable is dropped WITH a
 * warning naming the file, the key, the value and the allowed range, then falls through the ladder.
 */
function readScopeSettings(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): BashMultiFilePatch {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return {};
  const bash = config.bash;
  if (!isRecord(bash)) return {};
  const subtree = bash[BASH_MULTI_FILE_SUBTREE];
  if (subtree === undefined) return {};
  const path = configFilePath(scope, cwd);
  if (!isRecord(subtree)) {
    onWarn?.(`config ${path}: ignoring bash.${BASH_MULTI_FILE_SUBTREE} (not an object)`);
    return {};
  }
  const accepted: Record<string, number> = {};
  for (const key of KEY_ORDER) {
    const raw = subtree[key];
    if (raw === undefined) continue;
    if (!GUARDS[key](raw)) {
      onWarn?.(
        `config ${path}: ignoring bash.${BASH_MULTI_FILE_SUBTREE}.${key} ${JSON.stringify(
          raw,
        )} (allowed ${rangeText(key)})`,
      );
      continue;
    }
    accepted[key] = raw;
  }
  return accepted;
}

/**
 * Both scopes' accepted caps. A scope is absent (rather than an empty object) when its file is
 * missing, carries no `bash.multiFile` object, or holds no accepted key.
 */
export function readBashMultiFileConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: BashMultiFilePatch; global?: BashMultiFilePatch } {
  const project = readScopeSettings("project", cwd, onWarn);
  const global = readScopeSettings("global", cwd, onWarn);
  return {
    ...(Object.keys(project).length > 0 ? { project } : {}),
    ...(Object.keys(global).length > 0 ? { global } : {}),
  };
}

/**
 * The effective caps WITH their rungs: project, then global, then the declared default — per key, so
 * one key can come from a different rung than its sibling. Never throws.
 */
export function resolveBashMultiFileSettingsWithSources(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedBashMultiFileSettings {
  const config = readBashMultiFileConfig(cwd, onWarn);
  const pick = (key: BashMultiFileKey): ResolvedBashMultiFileCap => {
    const fromProject = config.project?.[key];
    if (fromProject !== undefined) return { value: fromProject, source: "project" };
    const fromGlobal = config.global?.[key];
    if (fromGlobal !== undefined) return { value: fromGlobal, source: "global" };
    return { value: BASH_MULTI_FILE_DEFAULTS[key], source: "default" };
  };
  return { maxFiles: pick("maxFiles"), maxRows: pick("maxRows") };
}

/** Effective caps only — the ladder's value half. Never throws. */
export function resolveBashMultiFileSettings(
  cwd: string,
  onWarn?: ConfigOnWarn,
): BashMultiFileSettings {
  const resolved = resolveBashMultiFileSettingsWithSources(cwd, onWarn);
  return { maxFiles: resolved.maxFiles.value, maxRows: resolved.maxRows.value };
}

/**
 * Persist the given caps for `scope`, preserving `$schema`, unknown top-level keys, every other
 * `bash.*` key (including `view`) and every `multiFile` key not being written. Throws
 * `E_INTERNAL_INVARIANT` — and writes nothing — for an out-of-range value or an unknown scope: a
 * defensive guard, unreachable from the command, because a silently dropped cap would read back as
 * the default.
 */
export function saveBashMultiFileConfig(
  patch: BashMultiFilePatch,
  scope: ConfigScope,
  cwd: string,
): { path: string } {
  const keys = KEY_ORDER.filter((key) => patch[key] !== undefined);
  if (keys.length === 0) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Missing bash.${BASH_MULTI_FILE_SUBTREE} setting to write.`,
    });
  }
  for (const key of keys) {
    const value = patch[key];
    if (!GUARDS[key](value)) {
      throw new DomainError("E_INTERNAL_INVARIANT", {
        message: `Unknown bash.${BASH_MULTI_FILE_SUBTREE}.${key} "${String(value)}" (allowed ${rangeText(
          key,
        )}).`,
      });
    }
  }
  if (!isBashMultiFileScope(scope)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown bash.${BASH_MULTI_FILE_SUBTREE} scope "${String(scope)}".`,
    });
  }

  const path = configFilePath(scope, cwd);
  updateConfigFile(path, (existing) => {
    const bash = isRecord(existing.bash) ? existing.bash : {};
    const subtree = isRecord(bash[BASH_MULTI_FILE_SUBTREE]) ? bash[BASH_MULTI_FILE_SUBTREE] : {};
    return {
      ...existing,
      bash: {
        ...bash,
        [BASH_MULTI_FILE_SUBTREE]: { ...subtree, ...patch },
      },
    };
  });
  return { path };
}
