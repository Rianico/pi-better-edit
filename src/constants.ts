export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

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
export const NOOP_LOOP_THRESHOLD = 3;
export const NEW_CONTENT_NOT_STRING_MSG =
  `[MODEL] [E_BAD_PAYLOAD] "replace_with" must be a string with \\n line separators, not an array.` +
  ` Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range. Nothing was written.`;
