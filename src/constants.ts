export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;

export const MAX_HASH_LINES = 1_000_000;
export const MAX_HASH_RETRIES = 262_144;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 3;
export const CONTENT_LINES_NOT_STRING_MSG =
  `[E_BAD_SHAPE] "content_lines" must be a native JSON array of strings, not a JSON string.`
  + ` Do not serialize the array (e.g. '["line1", "line2"]') — pass it as a proper JSON array: ["line1", "line2"].`;
