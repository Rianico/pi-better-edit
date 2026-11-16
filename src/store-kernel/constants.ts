/**
 * SAFETY: store-kernel/constants — the store's contention and schema knobs, one owner.
 *
 */
export const HASH_STORE_BUSY_TIMEOUT = 250;
/**
 * The persisted schema version. Bump it whenever any owner's schema-ensure or gated open work
 * changes — a new table, column, index, a changed ensure, or a changed gate — because it is the
 * schema half of the open stamp (`storeGenerationStamp` in `src/hash-store.ts`): a bump
 * invalidates every stamp already on disk and forces the next open down the slow path, which runs
 * the ensure and re-stamps. A change that does not bump it is invisible to a running build.
 *
 * Schema evolution itself is additive or rename-preserving, never a drop.
 */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
export const HASH_STORE_VERSION = 11;

const BUSY_MAX_ATTEMPTS = 8;
const BUSY_BACKOFF_BASE_MS = 50;
const BUSY_BACKOFF_CAP_MS = 400;
const BUSY_BACKOFF_JITTER_MS = 50;

export { BUSY_MAX_ATTEMPTS, BUSY_BACKOFF_BASE_MS, BUSY_BACKOFF_CAP_MS, BUSY_BACKOFF_JITTER_MS };
