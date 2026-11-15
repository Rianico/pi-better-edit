/**
 * SAFETY: store-kernel/constants — the store's contention and schema knobs, one owner.
 *
 * WHY: these numbers are the open gate's contract: the per-attempt busy wait, the retry shape, and the
 * WHY: schema version the open stamp is derived from. They move with the kernel rather than staying
 * WHY: beside the DDL, so the retry model and the stamp cannot be read from two modules that drift.
 */
// WHY: (#87b) the per-attempt wait inside SQLite, passed as the `timeout` constructor option — in
// WHY: node:sqlite that option IS the busy handler, so `PRAGMA busy_timeout` reports this value back;
// WHY: 250ms rather than 1000ms because the contended section is one short WAL write transaction.
export const HASH_STORE_BUSY_TIMEOUT = 250;
// WHY: v9 renames the persisted anchor-generation column (`canon_version` → `anchor_generation`) on
// WHY: `file_snapshots` and `file_undo`, a guarded rename preserving stamped values — so pre-generation
// WHY: rows (0) are never current. A concurrently open pre-rename process naming `canon_version` breaks
// WHY: fail-closed, and the DROP fallback may leave both columns, inert (`renameGenerationColumn`).
// WHY: Record-only marker; schema evolution itself is additive or rename-preserving, never a drop.
// Ref: docs/.archive_adrs/0031-file-scoped-anchors-residual-and-generation-discipline.md
// WHY: (#87c) BUMP THIS CONSTANT whenever any owner's schema-ensure or gated open work changes — a new
// WHY: table, column, index, a changed ensure, or a changed gate. It is the schema half of the open stamp
// WHY: (`storeGenerationStamp` in `src/hash-store.ts`), so bumping it invalidates every stamp already on
// WHY: disk BY CONSTRUCTION and forces the next open down the slow path, which runs the ensure and
// WHY: re-stamps. A change that does NOT bump it is invisible to a running build — exactly how a store
// WHY: ends up stamped current while missing the object the change added. `STAMP_FORMAT_VERSION` (there
// WHY: too) owns a FIELD LIST change; the stamp's hook count covers an ADDITIONAL open hook.
// WHY: v10 adds `idx_leases_file_snapshot`, the (path, snapshot_hash) index the vacuum's pin probe needs:
// WHY: without it every materialization re-scanned each path's lease set. v11 adds
// WHY: `file_snapshots.stat_key` plus `idx_snapshots_path_stat` — the stat identity the read
// WHY: materialization saw, so an unchanged file's next read adopts on `stat(2)` alone.
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
export const HASH_STORE_VERSION = 11;

const BUSY_MAX_ATTEMPTS = 8;
const BUSY_BACKOFF_BASE_MS = 50;
const BUSY_BACKOFF_CAP_MS = 400;
const BUSY_BACKOFF_JITTER_MS = 50;

export { BUSY_MAX_ATTEMPTS, BUSY_BACKOFF_BASE_MS, BUSY_BACKOFF_CAP_MS, BUSY_BACKOFF_JITTER_MS };
