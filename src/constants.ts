export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
// WHY: the served admission budget — the most lines any served read/edit/serve seam will
// WHY: materialize for one file. Post-paging (#47) the page walk retains only its page, but the
// WHY: anchor assignment still retains one entry per hashed line even when only a window is walked:
// WHY: `walkLines` (src/file-content/line-walker.ts) visits every line and `walkPage`
// WHY: (src/file-content/preview.ts) pushes one assigned anchor per visit, and that array is the
// WHY: `fileHashes` the snapshot lineage write persists — so the served path is O(N) in anchors
// WHY: regardless of window size. The retained set is three structures, probe-measured
// WHY: (`node --expose-gc scripts/measure-served-budget.mjs`): the walked anchor array (~6.1 MB
// WHY: for 200,000 distinct anchors at the live width), the spelling memo over the SAME strings
// WHY: (`HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES`, src/hashline/hash-identity.ts — shared
// WHY: references, so no duplicate string bytes; its ~7.0 MB entry overhead at a full budget is the
// WHY: largest single share), plus the fixed ~1.76 MB allocator bitset (`BITSET_WORDS` over the 62^4
// WHY: space) — ~14.9 MB marginal worst case over the loaded text, against the ~15 MB target (200,000
// WHY: lines x the ~77 B/line pre-paging per-line heap basis; the tree never recorded whether that
// WHY: basis included the memo, so this component-wise derivation supersedes it). The budget holds
// WHY: at the target for real source files and stays ~74x below the anchor space (14.7 M lines
// WHY: ≈ 470 MB of anchors) — nearly two orders of magnitude in line count, ~32x in bytes.
// WHY: This is deliberately NOT derived from ALPHA/HASH_LEN/HASH_SPACE — deriving admission from the
// WHY: anchor space was the defect (a width change must never move the memory budget).
export const SERVED_MAX_LINES = 200_000;

// WHY: a multi-window read is still ONE tool result, so the window count is bounded — otherwise
// WHY: `windows` would multiply the auto-read budget by N — and every window draws on the same
// WHY: budget (preview.ts buildWindowedPreview).
export const MAX_READ_WINDOWS = 16;

// WHY: the ONE wording of the window-cap refusal (spec §4.2). Three points enforce the same cap — the
// WHY: registered schema's per-array `maxItems`, `admitReadRequest`'s call-wide total, and the preview's
// WHY: runtime mirror for direct callers — and each naming the limit its own way made the same refusal
// WHY: read three ways. The mirror shares this message with admission rather than holding a fourth
// WHY: spelling of "16 windows".
export const MAX_READ_WINDOWS_MESSAGE = `Read request accepts at most ${MAX_READ_WINDOWS} windows across all files.`;

// WHY: a multi-file read is still ONE tool result, so the file fan-out is bounded with the same
// WHY: reasoning as `MAX_READ_WINDOWS`: N files draw on one served anchor budget and one shared
// WHY: `SERVED_MAX_LINES` line budget, so the call must not be able to multiply either without bound.
export const MAX_READ_FILES = 10;
// WHY: the ONE wording of the file-cap refusal (spec §4.2). Two points enforce this cap — the
// WHY: registered schema's `files`-array `maxItems` and `admitReadRequest`'s explicit length guard —
// WHY: and each naming the limit its own way made the same refusal read two ways, so admission now
// WHY: reuses this constant. Unlike the window cap there is no preview mirror to align: the only
// WHY: exported preview entry point (`fmtReadPreview`) renders ONE file's text, so a direct caller
// WHY: cannot express a file fan-out and cannot outrun this cap.
export const MAX_READ_FILES_MESSAGE = `Read request accepts at most ${MAX_READ_FILES} files.`;

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
export const HASH_STORE_VERSION = 9;
export const EDITS_MAX_ITEMS = 32;
// WHY: the served-lease session TTL: an un-retired lease pins its snapshot for this long, and
// WHY: the LRU vacuum's active-pin cutoff (spec §3.6.1) is measured with the same window.
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// WHY: (#87c) the served-mirror TTL prune is a PERIODIC open item, not a per-open one: a `DELETE`
// WHY: takes the store's write lock even when it matches no row, so running it on every open made a
// WHY: healthy, stamp-matching open contend for a store it had nothing to change.
// WHY: WHAT THE TIMER RELAXES, stated rather than implied: retention is now enforced at most four times
// WHY: a day instead of on every open, so an expired mirror row can live up to `SERVED_TTL_MS` +
// WHY: `SERVED_PRUNE_INTERVAL_MS` — the 7-day TTL plus the cadence below — and spec §5.1 item 8's
// WHY: "enforced on every open" no longer holds across the deferred window.
// WHY: WHY THE TIMER IS THE CHEAPER OF THE TWO: the guard it skips is an existence read with NO usable
// WHY: index — `served` is keyed `(session_id, path)` and the predicate is on `updated_at` — so when
// WHY: nothing is expired (the fast path's case) it scans the whole mirror. Measured medians of that
// WHY: read — n=9 batches of 200 calls, 2026-10-11, Apple M1 Pro, macOS 15.1.1, node v26.8.1, loadavg
// WHY: 3.44 4.85 6.04, 2.96 4.64 5.94 and 3.13 4.57 5.88 at the start of the three runs, rows as the
// WHY: mirror holds them (`hashes` `'[]'`, session id and path as the mirror writes them: 73 B/row of
// WHY: store file at the short end, 164 at the long end, the `(session_id, path)` index included) —
// WHY: 0.037ms at 1,000 rows, 0.72ms at 20,000, and 2.1-2.5ms at 50,000, versus 0.0014ms when something
// WHY: IS expired (that scan stops at the first hit). The 50,000 figure is quoted as the RANGE it moves
// WHY: through rather than as a point, because it tracks the row size: the same three runs measured
// WHY: 2.08ms at 73 B/row, 2.34-2.35ms at 132-133 B/row and 2.46-2.52ms at 164 B/row, and the single
// WHY: 2.36ms an earlier version of this comment carried did not reproduce as a value. The statement
// WHY: for every figure is
// WHY: `SELECT 1 AS one FROM served WHERE updated_at < ? LIMIT 1`. The timer bounds that per-open cost
// WHY: however large the mirror grew, which is the property a lock-free open needs.
// WHY: #90 owns the cadence: it is handed this constant as a knob, and its GC design (lifecycle events,
// WHY: throttled, never on the tool-call open path) is where the number should finally be tuned.
export const SERVED_PRUNE_INTERVAL_MS = SERVED_TTL_MS / 28;

// WHY: §3.6.2 post-write failure semantics — the bytes are already on disk when the store commit
// WHY: fails, so the tool reports success and names the deferred synchronization in one wording
// WHY: shared by the edit batch commit and the undo restore transaction.
export const DEFERRED_STORE_SYNC_WARNING =
  "Store synchronization deferred: the file was written to disk, but the post-write snapshot commit failed. The next call re-materializes the file from disk.";

export const SERVED_ROWS_CAP = 150;

// WHY: spec §3.4 match-cap gate — a search that matched more than this many lines is served raw
// WHY: instead of anchored. Anchors add ~7 B/row and a sparse match set can span the whole file,
// WHY: so past this point the anchored rewrite costs more bytes than the plain match list while
// WHY: leasing lines the model would have to re-read anyway; raw output is complete and safer.
// WHY: Pass-through is all-or-nothing: never truncate the anchored set and never lease a partial
// WHY: grant (matching ADR-0033 D3's strictly-slice-accurate-or-pass-through rule).
export const SEARCH_MAX_MATCHES = 50;

// WHY: (item 10) the multi-file / recursive / `--files` DISTINCT-FILE bound: a search that
// WHY: names more files than this passes through raw rather than exploding one bash call into
// WHY: an unbounded anchor budget (mirrors `MAX_READ_FILES`, so one tool result keeps one
// WHY: budget). It fails closed beyond — never silent-truncate (invariant 3).
export const BASH_SEARCH_MAX_FILES = 10;

// WHY: (item 10) the recursive walk's VISIT bound: a tree larger than this passes through raw
// WHY: instead of turning one bash call into an unbounded directory walk. Only files actually
// WHY: visited can ever be leased, so the bound is also the membership set's size.
export const BASH_SEARCH_WALK_MAX_FILES = 200;

// WHY: ADR-0024 (#174 diction) — the applied diff's removed-line cap, the mirror of SERVED_ROWS_CAP
// WHY: on the refusal side: a range deletion renders head + tail with an exact deleted count
// WHY: (` - ... [N lines deleted] ...`) instead of every removed row. The hidden rows still advance
// WHY: the render cursor, so every surviving row keeps its exact old line number and hash.
export const DIFF_REMOVED_CAP = 6;
export const DIFF_REMOVED_EDGE = 2;

// WHY: #174 single-projection contract — the context parameter of the preview projection: the
// WHY: preview pane renders the same `genDiff` text as the applied diff, just with wider context.
// WHY: Owned by the engine's `preview` seam so the display path never re-projects.
export const DIFF_PREVIEW_CONTEXT = 4;

export const NOOP_LOOP_THRESHOLD = 3;
