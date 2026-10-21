/**
 * SAFETY: store-kernel — the store's open-gate infrastructure, one surface.
 *
 * WHY: the gate, the contention budget, the periodic-item cadence and the janitor-settings ladder never
 * WHY: met: they were spread over `hash-store.ts`, `store-config.ts` and `constants.ts`, and a change to
 * WHY: one could silently disagree with the others (a retry model that does not match its constants, a
 * WHY: cadence read from a second ladder). This directory owns them; `hash-store.ts` keeps the open, the
 * WHY: DDL and the heal, `store-janitor.ts` keeps the GC policy, and `store-config.ts` keeps the writer.
 */
export { cachedOpenStore, getCached, setCachedOpenStore, withStore } from "./open-gate.js";
export type { BusyBudget } from "./busy.js";
export {
  busyBackoffMs,
  busyBudgetMs,
  isBusyError,
  resolveBusyBudget,
  withBusyRetry,
} from "./busy.js";
export { due, markRun } from "./periodic.js";
export { HASH_STORE_BUSY_TIMEOUT, HASH_STORE_VERSION } from "./constants.js";
