export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

// WHY: a multi-window read is still ONE tool result, so the window count is bounded — otherwise
// WHY: `windows` would multiply the auto-read budget by N — and every window draws on the same
// WHY: budget (preview.ts buildWindowedPreview).
export const MAX_READ_WINDOWS = 16;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 7;
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

// WHY: ADR-0024 — the applied diff's removed-line cap, the mirror of SERVED_ROWS_CAP on the refusal
// WHY: side: a range deletion renders head + tail with an exact omitted count instead of every removed
// WHY: row. The omitted rows still advance the render cursor, so every surviving row keeps its exact
// WHY: old line number and hash.
export const DIFF_REMOVED_CAP = 6;
export const DIFF_REMOVED_EDGE = 2;

export const NOOP_LOOP_THRESHOLD = 3;
