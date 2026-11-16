export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
/**
 * The per-call served budget in LINES: the anchors, text and hashes one call may retain. It is a
 * MEMORY bound, not a fraction of the anchor space — `walkLines` keeps one assigned anchor per
 * visited line, so the anchor array the snapshot lineage write persists is O(N) in this number
 * whatever the window size, and post-paging bounds the retained TEXT only.
 *
 * Deliberately NOT derived from the alphabet or `HASH_LEN`: an anchor-width change must never move
 * the memory budget.
 */
export const SERVED_MAX_LINES = 200_000;

/**
 * One tool result's window cap: a multi-window read is still ONE result, and every window draws
 * on the same served budget, so an unbounded `windows` would multiply that budget by N.
 */
export const MAX_READ_WINDOWS = 16;

/**
 * The ONE wording of the window-cap refusal (spec §4.2). Three points enforce the same cap — the
 * schema's per-array `maxItems`, `admitReadRequest`'s call-wide total and the preview's runtime
 * mirror — and a message per point made one refusal read three ways.
 */
export const MAX_READ_WINDOWS_MESSAGE = `Read request accepts at most ${MAX_READ_WINDOWS} windows.`;

export const EDITS_MAX_ITEMS = 32;
/**
 * The served-lease session TTL: an un-retired lease pins its snapshot for this long, and the LRU
 * vacuum's active-pin cutoff is measured with the same window.
 */
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The served-mirror TTL prune is a PERIODIC open item, not a per-open one (#87c): a `DELETE` takes
 * the store's write lock even when it matches no row, so a healthy, stamp-matching open would
 * contend for a store it had nothing to change. Retention is therefore enforced at most four times
 * a day, so an expired mirror row can live up to `SERVED_TTL_MS + SERVED_PRUNE_INTERVAL_MS`.
 *
 * The skipped guard is an existence read with NO usable index — `served` is keyed
 * `(session_id, path)` while the predicate is on `updated_at` — so when nothing is expired it scans
 * the whole mirror. The interval bounds that per-open cost however large the mirror grows, which is
 * the property a lock-free open needs.
 */
export const SERVED_PRUNE_INTERVAL_MS = SERVED_TTL_MS / 28;

// Ref: docs/spec/content-addressed-line-identity-mvcc.md
export const DEFERRED_STORE_SYNC_WARNING =
  "Store synchronization deferred: the file was written to disk, but the post-write snapshot commit failed. The next call re-materializes the file from disk.";

export const SERVED_ROWS_CAP = 150;

/**
 * The match-cap gate: past this many matched lines the search is served raw — anchors add ~7 B/row
 * and a sparse match set can span the whole file, so the anchored rewrite costs more bytes than the
 * plain match list while leasing lines the model would have to re-read anyway. Pass-through is
 * all-or-nothing: never truncate the set, never lease a partial grant (ADR-0033 D3).
 */
export const SEARCH_MAX_MATCHES = 50;

/**
 * The TOTAL anchored-row budget of ONE search, independent of `SEARCH_MAX_MATCHES`: a context search
 * prints the matches AND their surrounding lines, so the match cap no longer bounds what this seam
 * would lease. It is the per-call budget a dense view serve already spends (`SERVED_ROWS_CAP`), so
 * one tool result keeps one budget whatever shape it came from. Over-cap passes the command through
 * raw — a context block cut in half names a window bash never printed (ADR-0048 D3).
 */
export const SEARCH_MAX_TOTAL_ROWS = 150;

/**
 * The multi-file / recursive / `--files` DISTINCT-FILE bound (ADR-0033 D10): more files than this
 * pass through raw rather than exploding one bash call into an unbounded anchor budget. It mirrors
 * the retired per-call read file cap, so one tool result keeps one budget, and it fails closed
 * beyond — never a silent truncation. The `rg --files` list leases nothing, so a repository-wide
 * listing usually passes through raw.
 */
export const BASH_SEARCH_MAX_FILES = 10;

/**
 * The recursive walk's VISIT bound: a larger tree passes through raw rather than turning one bash
 * call into an unbounded walk — only visited files can be leased.
 */
export const BASH_SEARCH_WALK_MAX_FILES = 200;

/**
 * The applied diff's removed-line cap, the refusal-side mirror of `SERVED_ROWS_CAP` (ADR-0024): a
 * range deletion renders head + tail with an exact deleted count instead of every removed row, and
 * the hidden rows still advance the render cursor, so every surviving row keeps its old line number
 * and hash.
 */
export const DIFF_REMOVED_CAP = 6;
export const DIFF_REMOVED_EDGE = 2;

/**
 * The single-projection contract (#174): the preview pane renders the same `genDiff` text as the
 * applied diff with wider context, owned by the engine's `preview` seam so no one re-projects it.
 */
export const DIFF_PREVIEW_CONTEXT = 4;

export const NOOP_LOOP_THRESHOLD = 3;
