/**
 * SAFETY: store-kernel/open-gate — the one cached open handle and the transaction frame over it.
 *
 * WHY: the store's open gate is a single published handle: `loadHashStore` shares it, `withStore` frames
 * WHY: `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` on it, and the statement caches memoize against its identity
 * WHY: (`getCached`). Keeping the slot here — with an explicit publish/read pair — is what lets the
 * WHY: contention loop and the frame live beside the budget while the DDL and heal stay in `hash-store`.
 */
import { DatabaseSync } from "node:sqlite";
import { withBusyRetry } from "./busy.js";

export interface CachedOpenStore {
  readonly path: string;
  readonly db: DatabaseSync;
}

let cachedStoreRef: CachedOpenStore | null = null;

/** The handle the open path published, or `null` when no store is open. */
export function cachedOpenStore(): CachedOpenStore | null {
  return cachedStoreRef;
}

/** Publishes (or clears, with `null`) the one open handle. Written only by the open/teardown path. */
export function setCachedOpenStore(entry: CachedOpenStore | null): void {
  cachedStoreRef = entry;
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE ... COMMIT` on the cached handle, under the contention budget.
 * Exhaustion rethrows the original error unchanged, so every caller classifies busy as it did before.
 */
export function withStore(fn: () => void): void {
  const store = cachedStoreRef;
  if (!store || !store.db.isOpen) {
    throw new Error(
      "withStore requires an open SQLite store — call loadHashStore() first or use a MemoryStore in tests",
    );
  }
  withBusyRetry(() => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      store.db.exec("COMMIT");
    } catch (e) {
      try {
        store.db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        console.error("[hash-store] failed to rollback transaction:", rollbackError);
      }
      throw e;
    }
  });
}

/** A per-handle memo: build once per `db` and reuse, keyed by the handle's identity. */
export function getCached<T>(
  db: DatabaseSync,
  cache: WeakMap<DatabaseSync, T>,
  build: (db: DatabaseSync) => T,
): T {
  let v = cache.get(db);
  if (v) return v;
  v = build(db);
  cache.set(db, v);
  return v;
}
