/**
 * SAFETY: store-kernel/constants — the store's contention and schema knobs, one owner.
 *
 * WHY: these numbers are the open gate's contract: the per-attempt busy wait, the retry shape, and the
 * WHY: schema version the open stamp is derived from. They move with the kernel rather than staying
 * WHY: beside the DDL, so the retry model and the stamp cannot be read from two modules that drift.
 */
// WHY: (#87b) the per-attempt wait inside SQLite, passed as the `timeout` constructor option — in
// WHY: node:sqlite that option IS the busy handler, so `PRAGMA busy_timeout` reports this value back.
// WHY: 250ms rather than 1000ms because the contended section is one short WAL write: the budget,
// WHY: its arithmetic and the deadline that enforces it live beside the retry loop in
// WHY: `src/hash-store.ts` (`BUSY_MAX_ATTEMPTS` and its WHY block).
export const HASH_STORE_BUSY_TIMEOUT = 250;
// WHY: v9 renames the persisted anchor-generation column (`canon_version` → `anchor_generation`
// WHY: on `file_snapshots` and `file_undo`, guarded rename preserving stamped values) — pre-generation
// WHY: rows (0) are never current. Mixed-version note: a concurrently open pre-rename process naming
// WHY: `canon_version` breaks fail-closed, and the DROP fallback may leave both columns, inert
// WHY: (see ADR-0031 §4 and `renameGenerationColumn`). Record-only marker; schema evolution itself
// WHY: is additive or rename-preserving, never a drop.
// WHY: (#87c) BUMP THIS CONSTANT whenever any owner's schema-ensure or gated open work changes — a
// WHY: new table, column or index, a changed ensure, or a changed gate. It is the schema half of the
// WHY: open stamp (`storeGenerationStamp` in `src/hash-store.ts`), so bumping it invalidates every
// WHY: stamp already on disk BY CONSTRUCTION and forces the next open down the slow path, which runs the
// WHY: ensure and re-stamps. A change that does NOT bump it is invisible to a running build — which is
// WHY: exactly how a store ends up stamped current while missing the object the change added.
// WHY: A change to the stamp's FIELD LIST instead of its content is `STAMP_FORMAT_VERSION`'s business
// WHY: (also in `src/hash-store.ts`); an ADDITIONAL open hook is covered by the hook count in the stamp.
// WHY: v10 adds `idx_leases_file_snapshot`, the (path, snapshot_hash) index the vacuum's pin probe
// WHY: needs to stay covered. Without it every materialization re-scanned each path's lease set.
// WHY: v11 adds `file_snapshots.stat_key` plus `idx_snapshots_path_stat` — the stat identity a read
// WHY: materialization saw, so an unchanged file's next read adopts on `stat(2)` alone (ADR-0043).
export const HASH_STORE_VERSION = 11;

const BUSY_MAX_ATTEMPTS = 8;
const BUSY_BACKOFF_BASE_MS = 50;
const BUSY_BACKOFF_CAP_MS = 400;
const BUSY_BACKOFF_JITTER_MS = 50;

export { BUSY_MAX_ATTEMPTS, BUSY_BACKOFF_BASE_MS, BUSY_BACKOFF_CAP_MS, BUSY_BACKOFF_JITTER_MS };
