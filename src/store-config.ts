/**
 * Store janitor settings — the `store.*` keys of the shared config file, resolved per key
 * through the shared ladder: env override, then project file, then global file, then the default.
 *
 * WHY the janitor is configurable at all: the sweep it guards is a PERIODIC store item rather than a
 * per-open one (the store DDL's own comment in `src/hash-store.ts` owns that design), and its cost
 * belongs to the operator who owns the store — an enable/disable for a store they would rather leave
 * untouched, a throttle interval for how often it may run, and a batch size for how many rows one
 * delete round takes.
 *
 * WHY there is deliberately NO store-directory key, read or written: the store PATH is an
 * operator/security decision owned by `PI_BETTER_EDIT_CONFIG_DIR` alone (`configDir` in
 * `src/hash-store.ts`), so a config file must not be able to move it. A `dir` key in the file is an
 * unknown key like any other — preserved on write, ignored on read — and `store.dir` in particular
 * resolves to nothing.
 *
 * WHY a warning is part of the contract here: a dropped store setting changes what the store does,
 * so an existing-but-unusable file is reported through `onWarn` while the values fall through the
 * ladder. A missing file warns about nothing, and a value outside an accepted shape is ignored
 * exactly as the `lens.bridge` ladder ignores one. Nothing here throws on the read side.
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

export type StoreJanitorMode = "on" | "off";

/** Environment overrides; each wins over both files for its OWN key. */
export const STORE_JANITOR_ENV_VAR = "PI_BETTER_EDIT_STORE_JANITOR";
export const STORE_JANITOR_INTERVAL_ENV_VAR = "PI_BETTER_EDIT_STORE_JANITOR_INTERVAL_MS";
export const STORE_JANITOR_BATCH_ENV_VAR = "PI_BETTER_EDIT_STORE_JANITOR_BATCH_SIZE";

/**
 * WHY a day: the committed design in `src/hash-store.ts` bounds the sweep at about once a day, and
 * this interval is the only thing that decides how often an open may pay for it.
 */
export const STORE_JANITOR_INTERVAL_DEFAULT_MS = 24 * 60 * 60 * 1000;

/** WHY 64: the snapshot store already deletes in statement batches of that width (`STAT_BATCH`). */
export const STORE_JANITOR_BATCH_DEFAULT = 64;

/**
 * One resolved setting: the value the store will use, and the rung of the ladder that supplied it.
 * NOT exported on its own — the keyed shape below is the interface a caller reads, and a bare pair
 * of fields has nothing to say without the key it belongs to.
 */
interface ResolvedStoreJanitorSetting<T> {
  readonly value: T;
  readonly source: ConfigRung;
}

/**
 * Every janitor setting with its rung, keyed by the same three names `StoreJanitorSettings` uses, so
 * a caller that needs to say WHERE a value came from reads the ladder's answer instead of guessing
 * it from the two files (“the project file does not have the key, so the global one must have won”
 * is a second ladder, and a wrong one as soon as a value is outside its accepted shape).
 */
export interface ResolvedStoreJanitorSettings {
  readonly mode: ResolvedStoreJanitorSetting<StoreJanitorMode>;
  readonly intervalMs: ResolvedStoreJanitorSetting<number>;
  readonly batchSize: ResolvedStoreJanitorSetting<number>;
}

export interface StoreJanitorSettings {
  readonly mode: StoreJanitorMode;
  readonly intervalMs: number;
  readonly batchSize: number;
}

/** The settings ONE scope's file carries — every key optional, because the ladder resolves per key. */
export type StoreJanitorScopeSettings = Partial<StoreJanitorSettings>;

/** The values an unconfigured store gets. */
export const STORE_JANITOR_DEFAULTS: StoreJanitorSettings = {
  mode: "on",
  intervalMs: STORE_JANITOR_INTERVAL_DEFAULT_MS,
  batchSize: STORE_JANITOR_BATCH_DEFAULT,
};

// WHY: one place maps a setting to its file key, so the read path and the write path cannot spell a
// WHY: key differently — the failure a second hand-written literal would introduce.
const STORE_JANITOR_KEYS = {
  mode: "janitor",
  intervalMs: "janitorIntervalMs",
  batchSize: "janitorBatchSize",
} as const satisfies Record<keyof StoreJanitorSettings, string>;

/**
 * The key each setting is read from and written to under `store`, for a caller that has to NAME one
 * — the `/pi-better-edit` status text labels a key with the same spelling the ladder reads it by,
 * instead of a second copy of the literal that can drift from this one.
 */
export const STORE_JANITOR_KEY_NAMES: Readonly<Record<keyof StoreJanitorSettings, string>> =
  STORE_JANITOR_KEYS;

function isStoreJanitorMode(value: unknown): value is StoreJanitorMode {
  return value === "on" || value === "off";
}

/**
 * A whole number of milliseconds at least 1: a fractional, non-finite, zero or negative interval
 * cannot express a cadence, and admitting one would silently turn every open into a sweep.
 */
function isIntervalMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A whole number of rows at least 1: a batch of zero rows deletes nothing and reports success. */
function isBatchSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A trimmed environment value, or `undefined` when the variable is unset. */
function envText(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined ? undefined : raw.trim();
}

function readEnvMode(): StoreJanitorMode | undefined {
  const mode = envText(STORE_JANITOR_ENV_VAR)?.toLowerCase();
  return mode !== undefined && isStoreJanitorMode(mode) ? mode : undefined;
}

function readEnvIntervalMs(): number | undefined {
  const raw = envText(STORE_JANITOR_INTERVAL_ENV_VAR);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return isIntervalMs(value) ? value : undefined;
}

function readEnvBatchSize(): number | undefined {
  const raw = envText(STORE_JANITOR_BATCH_ENV_VAR);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return isBatchSize(value) ? value : undefined;
}

/** The keys one scope's file actually carries, read once so a bad file warns once per scope. */
function readScopeSettings(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): StoreJanitorScopeSettings {
  const config = readScopeConfig(scope, cwd, onWarn);
  if (config === undefined) return {};
  const store = config.store;
  if (!isRecord(store)) return {};
  const mode = store[STORE_JANITOR_KEYS.mode];
  const intervalMs = store[STORE_JANITOR_KEYS.intervalMs];
  const batchSize = store[STORE_JANITOR_KEYS.batchSize];
  // WHY: with `exactOptionalPropertyTypes` an unusable key is OMITTED rather than present as
  // WHY: `undefined`, so "this scope said nothing about it" is one state, not two.
  return {
    ...(isStoreJanitorMode(mode) ? { mode } : {}),
    ...(isIntervalMs(intervalMs) ? { intervalMs } : {}),
    ...(isBatchSize(batchSize) ? { batchSize } : {}),
  };
}

/**
 * Both scopes' raw settings, each scope present only when its file carries at least one accepted
 * key. Pure read: never creates the directory or the file, never throws. A warning names each file
 * that exists but could not be used.
 */
export function readStoreJanitorConfig(
  cwd: string,
  onWarn?: ConfigOnWarn,
): { project?: StoreJanitorScopeSettings; global?: StoreJanitorScopeSettings } {
  const project = readScopeSettings("project", cwd, onWarn);
  const global = readScopeSettings("global", cwd, onWarn);
  return {
    ...(Object.keys(project).length > 0 ? { project } : {}),
    ...(Object.keys(global).length > 0 ? { global } : {}),
  };
}

/**
 * The first rung that answered, with its own name: the ladder's three ORDERS are one comparison made
 * three times, so the rung labels and the precedence order cannot drift apart as two literals.
 */
function fromRung<T>(
  env: T | undefined,
  project: T | undefined,
  global: T | undefined,
  fallback: T,
): ResolvedStoreJanitorSetting<T> {
  if (env !== undefined) return { value: env, source: "env" };
  if (project !== undefined) return { value: project, source: "project" };
  if (global !== undefined) return { value: global, source: "global" };
  return { value: fallback, source: "default" };
}

/**
 * The effective janitor settings WITH the rung each one came from. Precedence is PER KEY — env, then
 * project, then global, then the default — so a file that tunes one knob does not have to restate the
 * others, and a caller that reports the settings can name the rung it should blame for each one.
 * Never throws. This is the ladder itself; `resolveStoreJanitorSettings` is its value half.
 */
export function resolveStoreJanitorSettingsWithSources(
  cwd: string,
  onWarn?: ConfigOnWarn,
): ResolvedStoreJanitorSettings {
  const config = readStoreJanitorConfig(cwd, onWarn);
  return {
    mode: fromRung(
      readEnvMode(),
      config.project?.mode,
      config.global?.mode,
      STORE_JANITOR_DEFAULTS.mode,
    ),
    intervalMs: fromRung(
      readEnvIntervalMs(),
      config.project?.intervalMs,
      config.global?.intervalMs,
      STORE_JANITOR_DEFAULTS.intervalMs,
    ),
    batchSize: fromRung(
      readEnvBatchSize(),
      config.project?.batchSize,
      config.global?.batchSize,
      STORE_JANITOR_DEFAULTS.batchSize,
    ),
  };
}

/**
 * The effective janitor settings, without their provenance. Precedence is PER KEY — env, then
 * project, then global, then the default. Never throws.
 */
export function resolveStoreJanitorSettings(
  cwd: string,
  onWarn?: ConfigOnWarn,
): StoreJanitorSettings {
  const resolved = resolveStoreJanitorSettingsWithSources(cwd, onWarn);
  return {
    mode: resolved.mode.value,
    intervalMs: resolved.intervalMs.value,
    batchSize: resolved.batchSize.value,
  };
}

/**
 * Persist the keys in `settings` for `scope`, preserving every other top-level key, other `store.*`
 * keys and other owners' keys already in the file. Creates the directory as needed and replaces the
 * file atomically. Throws `E_INTERNAL_INVARIANT` — and writes nothing — for a value outside its
 * accepted shape or a scope outside the enum: a defensive guard, unreachable from the command
 * and the overlay, because a silently dropped value would read back as a default.
 */
export function saveStoreJanitorConfig(
  settings: StoreJanitorScopeSettings,
  scope: ConfigScope,
  cwd: string,
): { path: string } {
  if (!isConfigScope(scope)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown config scope "${String(scope)}".`,
    });
  }
  if (settings.mode !== undefined && !isStoreJanitorMode(settings.mode)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown store janitor mode "${String(settings.mode)}".`,
    });
  }
  if (settings.intervalMs !== undefined && !isIntervalMs(settings.intervalMs)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown store janitor interval "${String(settings.intervalMs)}".`,
    });
  }
  if (settings.batchSize !== undefined && !isBatchSize(settings.batchSize)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Unknown store janitor batch size "${String(settings.batchSize)}".`,
    });
  }

  const patch: Record<string, unknown> = {};
  if (settings.mode !== undefined) patch[STORE_JANITOR_KEYS.mode] = settings.mode;
  if (settings.intervalMs !== undefined) patch[STORE_JANITOR_KEYS.intervalMs] = settings.intervalMs;
  if (settings.batchSize !== undefined) patch[STORE_JANITOR_KEYS.batchSize] = settings.batchSize;

  const path = configFilePath(scope, cwd);
  // WHY: only the keys named in `patch` are ours to set — the rest of `store` and every other
  // WHY: top-level key belong to the user, so all of them survive the spread.
  updateConfigFile(path, (existing) => ({
    ...existing,
    store: { ...(isRecord(existing.store) ? existing.store : {}), ...patch },
  }));

  return { path };
}
