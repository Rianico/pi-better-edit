export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
// WHY: the served admission budget — the most lines any served read/edit/serve seam will
// WHY: materialize for one file. Post-paging (#47) the page walk retains only its page, but the
// WHY: anchor assignment still retains one entry per hashed line even when only a window is walked:
// WHY: `walkLines` (src/file-content/line-walker.ts) visits every line and `walkPage`
// WHY: (src/file-content/preview.ts) pushes one assigned anchor per visit, and that array is the
// WHY: `fileHashes` the snapshot lineage write persists — so the served path is O(N) in anchors
// WHY: regardless of window size. Measured ~32 B/line for distinct anchors at the live width plus array slots
// WHY: (`node --expose-gc` probe: 200,000 distinct anchors hold ~6.1 MB), plus the fixed ~1.85 MB
// WHY: allocator bitset (`BITSET_WORDS` over the 62^4 space) — 200,000 lines cost ~8-9 MB marginal
// WHY: over the loaded text against the same ~15 MB target, generous for real source files and two
// WHY: orders of magnitude below what the anchor space would admit (14.7 M lines ≈ 470 MB of anchors).
// WHY: This is deliberately NOT derived from ALPHA/HASH_LEN/HASH_SPACE — deriving admission from the
// WHY: anchor space was the defect (a width change must never move the memory budget).
export const SERVED_MAX_LINES = 200_000;

// WHY: a multi-window read is still ONE tool result, so the window count is bounded — otherwise
// WHY: `windows` would multiply the auto-read budget by N — and every window draws on the same
// WHY: budget (preview.ts buildWindowedPreview).
export const MAX_READ_WINDOWS = 16;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
// WHY: v9 renames the persisted anchor-generation column (`canon_version` → `anchor_generation`
// WHY: on `file_snapshots` and `file_undo`, guarded rename preserving stamped values) — pre-generation
// WHY: rows (0) are never current. Record-only marker; schema evolution itself is additive or
// WHY: rename-preserving, never a drop.
export const HASH_STORE_VERSION = 9;
export const EDITS_MAX_ITEMS = 32;
// WHY: the served-lease session TTL: an un-retired lease pins its snapshot for this long, and
// WHY: the LRU vacuum's active-pin cutoff (spec §3.6.1) is measured with the same window.
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// WHY: §3.6.2 post-write failure semantics — the bytes are already on disk when the store commit
// WHY: fails, so the tool reports success and names the deferred synchronization in one wording
// WHY: shared by the edit batch commit and the undo restore transaction.
export const DEFERRED_STORE_SYNC_WARNING =
  "Store synchronization deferred: the file was written to disk, but the post-write snapshot commit failed. The next call re-materializes the file from disk.";

export const SERVED_ROWS_CAP = 150;

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
