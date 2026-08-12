export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 6;
export const SERVED_ECHO_CAP = 150;
export const NEW_CONTENT_NOT_STRING_MSG =
  `[E_BAD_SHAPE] "replacement_text" must be a string with \\n line separators, not an array.`
  + ` Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range.`;
