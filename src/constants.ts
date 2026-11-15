export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
// WHY: the budget is MEMORY, not a fraction of the anchor space — the served path is O(N) in anchors
// WHY: whatever the window size, because `walkLines` (src/file-content/line-walker.ts) visits every
// WHY: line and `walkPage` (src/file-content/preview.ts) keeps one assigned anchor per visit, and that
// WHY: `fileHashes` array is what the snapshot lineage write persists. Post-paging (#47) bounds the
// WHY: retained TEXT, never the anchor set. Retained structures, probe-measured
// WHY: (`node --expose-gc scripts/measure-served-budget.mjs`): the walked anchor array ~6.1 MB at
// WHY: 200,000 distinct anchors and the live width; the spelling memo over the SAME strings ~7.0 MB of
// WHY: entry overhead at a full budget (`HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES`,
// WHY: src/hashline/hash-identity.ts — shared references, so no duplicate string bytes; the largest
// WHY: single share); the fixed ~1.76 MB allocator bitset (`BITSET_WORDS` over the 62^4 space) —
// WHY: ~14.9 MB marginal worst case over the loaded text against the ~15 MB target (200,000 lines x
// WHY: the ~77 B/line pre-paging heap basis; the tree never recorded whether that basis included the
// WHY: memo, so this component-wise derivation supersedes it). ~74x below the anchor space (14.7 M
// WHY: lines ≈ 470 MB of anchors): two orders of magnitude in line count, ~32x in bytes. Deliberately
// WHY: NOT derived from ALPHA/HASH_LEN/HASH_SPACE — that derivation was the defect, because a width
// WHY: change must never move the memory budget.
export const SERVED_MAX_LINES = 200_000;

// WHY: a multi-window read is still ONE tool result, so an unbounded `windows` would multiply the
// WHY: auto-read budget by N — and every window draws on the same budget (`buildWindowedPreview`).
export const MAX_READ_WINDOWS = 16;

// WHY: the ONE wording of the window-cap refusal (spec §4.2): three points enforce the same cap — the
// WHY: schema's per-array `maxItems`, `admitReadRequest`'s call-wide total and the preview's runtime
// WHY: mirror — and a message per point made one refusal read three ways.
export const MAX_READ_WINDOWS_MESSAGE = `Read request accepts at most ${MAX_READ_WINDOWS} windows.`;

export const EDITS_MAX_ITEMS = 32;
// WHY: the served-lease session TTL: an un-retired lease pins its snapshot for this long, and
// WHY: the LRU vacuum's active-pin cutoff (spec §3.6.1) is measured with the same window.
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// WHY: (#87c) the served-mirror TTL prune is a PERIODIC open item, not a per-open one: a `DELETE`
// WHY: takes the store's write lock even when it matches no row, so running it on every open made a
// WHY: healthy, stamp-matching open contend for a store it had nothing to change.
// WHY: WHAT THE TIMER RELAXES: retention is enforced at most four times a day instead of on every
// WHY: open, so an expired mirror row can live up to `SERVED_TTL_MS` + `SERVED_PRUNE_INTERVAL_MS` — and
// WHY: spec §5.1 item 8's "enforced on every open" no longer holds across the deferred window.
// WHY: THE TIMER IS CHEAPER: the guard it skips is an existence read with NO usable index — `served`
// WHY: is keyed `(session_id, path)` and the predicate is on `updated_at` — so when nothing is expired
// WHY: (the fast path's case) it scans the whole mirror. Measured medians of that read — n=9 batches
// WHY: of 200 calls, 2026-10-11, Apple M1 Pro, macOS 15.1.1, node v26.8.1, loadavg 3.44 4.85 6.04,
// WHY: 2.96 4.64 5.94 and 3.13 4.57 5.88 at the start of the three runs, rows as the mirror holds them
// WHY: (`hashes` `'[]'`, session id and path as it writes them: 73 B/row of store file at the short
// WHY: end, 164 at the long end, the `(session_id, path)` index included) — 0.037ms at 1,000 rows,
// WHY: 0.72ms at 20,000 and 2.1-2.5ms at 50,000, versus 0.0014ms when something IS expired (that scan
// WHY: stops at the first hit). The 50,000 figure is quoted as the RANGE it moves through, because it
// WHY: tracks row size: 2.08ms at 73 B/row, 2.34-2.35ms at 132-133 B/row, 2.46-2.52ms at 164 B/row —
// WHY: the single 2.36ms an earlier version carried did not reproduce. The statement for every figure
// WHY: is `SELECT 1 AS one FROM served WHERE updated_at < ? LIMIT 1`. The timer bounds that per-open
// WHY: cost however large the mirror grew, which is the property a lock-free open needs. #90 owns the
// WHY: cadence: it is handed this constant as a knob, and its GC design (lifecycle events, throttled,
// WHY: never on the tool-call open path) is where the number should finally be tuned.
export const SERVED_PRUNE_INTERVAL_MS = SERVED_TTL_MS / 28;

// WHY: §3.6.2 post-write failure semantics — the bytes are already on disk when the store commit
// WHY: fails, so one wording reports success and names the deferred sync for both writers.
export const DEFERRED_STORE_SYNC_WARNING =
  "Store synchronization deferred: the file was written to disk, but the post-write snapshot commit failed. The next call re-materializes the file from disk.";

export const SERVED_ROWS_CAP = 150;

// WHY: spec §3.4 match-cap gate — past this many matched lines the search is served raw: anchors add
// WHY: ~7 B/row and a sparse match set can span the whole file, so the anchored rewrite costs more
// WHY: bytes than the plain match list while leasing lines the model would have to re-read anyway.
// WHY: Pass-through is all-or-nothing — never truncate the set, never lease a partial grant
// WHY: (docs/.archive_adrs/0033-bash-view-interception.md D3: slice-accurate or pass-through).
export const SEARCH_MAX_MATCHES = 50;

// WHY: (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3 — context
// WHY: searches) the TOTAL anchored-row budget of ONE search, independent of `SEARCH_MAX_MATCHES`: a
// WHY: context search prints the matches AND their surrounding lines, so the match cap no longer
// WHY: bounds what this seam would lease. It is the per-call budget a dense view serve already spends
// WHY: (`SERVED_ROWS_CAP`), so one tool result keeps one budget whatever shape it came from. Over-cap
// WHY: passes the command through raw — a context block cut in half names a window bash never printed.
export const SEARCH_MAX_TOTAL_ROWS = 150;

// WHY: (item 10) the multi-file / recursive / `--files` DISTINCT-FILE bound: more files than this
// WHY: pass through raw rather than exploding one bash call into an unbounded anchor budget (it
// WHY: mirrors the retired per-call read file cap, so one tool result keeps one budget). It fails
// WHY: closed beyond — never silent-truncate (invariant 3). The `rg --files` list leases nothing, so
// WHY: its share of this bound is the brief's "same count cap", and a repository-wide listing usually
// WHY: passes through raw (docs/.archive_adrs/0033-bash-view-interception.md D10).
export const BASH_SEARCH_MAX_FILES = 10;

// WHY: (item 10) the recursive walk's VISIT bound: a larger tree passes through raw rather than
// WHY: turning one bash call into an unbounded walk — only visited files can be leased.
export const BASH_SEARCH_WALK_MAX_FILES = 200;

// WHY: (docs/.archive_adrs/0024-narrow-p2-interior-exposure-cap-removed-diffs.md, #174 diction) the
// WHY: applied diff's removed-line cap, the refusal-side mirror of `SERVED_ROWS_CAP`: a range deletion
// WHY: renders head + tail with an exact deleted count instead of every removed row, and the hidden
// WHY: rows still advance the render cursor, so every surviving row keeps its old line number and hash.
export const DIFF_REMOVED_CAP = 6;
export const DIFF_REMOVED_EDGE = 2;

// WHY: #174 single-projection contract — the preview pane renders the same `genDiff` text as the
// WHY: applied diff with wider context, owned by the engine's `preview` seam so no one re-projects.
export const DIFF_PREVIEW_CONTEXT = 4;

export const NOOP_LOOP_THRESHOLD = 3;
