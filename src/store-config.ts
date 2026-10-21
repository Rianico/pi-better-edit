/**
 * Store janitor settings — the WRITE half of the `store.*` keys of the shared config file.
 *
 * WHY: the read/resolve ladder lives in `store-kernel/settings.ts` (the kernel owns the maintenance
 * WHY: policy the values feed); what belongs here is the config file's own shape and the atomic,
 * WHY: preserving write. `saveStoreJanitorConfig` is the only writer of these keys.
 */
import { DomainError } from "./domain-errors.js";
import {
  configFilePath,
  isConfigScope,
  isRecord,
  updateConfigFile,
  type ConfigScope,
} from "./json-config.js";
import {
  STORE_JANITOR_KEY_NAMES,
  isIntervalMs,
  isBatchSize,
  isStoreJanitorMode,
  type StoreJanitorScopeSettings,
} from "./store-kernel/settings.js";

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
  if (settings.mode !== undefined) patch[STORE_JANITOR_KEY_NAMES.mode] = settings.mode;
  if (settings.intervalMs !== undefined)
    patch[STORE_JANITOR_KEY_NAMES.intervalMs] = settings.intervalMs;
  if (settings.batchSize !== undefined)
    patch[STORE_JANITOR_KEY_NAMES.batchSize] = settings.batchSize;

  const path = configFilePath(scope, cwd);
  // WHY: only the keys named in `patch` are ours to set — the rest of `store` and every other
  // WHY: top-level key belong to the user, so all of them survive the spread.
  updateConfigFile(path, (existing) => ({
    ...existing,
    store: { ...(isRecord(existing.store) ? existing.store : {}), ...patch },
  }));

  return { path };
}
