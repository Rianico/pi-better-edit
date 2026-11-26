/**
 * SAFETY: store-kernel — the store's open-gate infrastructure, one surface.
 *
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
export { StoreLifecycleSlot } from "./lifecycle-slot.js";
export type { StoreLifecycleSlotOptions } from "./lifecycle-slot.js";
export { due, markRun } from "./periodic.js";
export { HASH_STORE_BUSY_TIMEOUT, HASH_STORE_VERSION } from "./constants.js";
