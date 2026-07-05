export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Hard ceiling on the number of lines the edit/hash path will process. Guards
 * `lineHashes` (which holds a per-line array plus a Set of every hash) and the
 * host diff against pathological inputs such as a multi-tens-of-MB generated
 * bundle or data dump. Only the `replace` path enforces it (`readNormFile` is
 * called with this limit only from `replace.ts`); `read` keeps its
 * truncate-and-preview behavior. ~1M lines is well above any realistic source
 * file, so this only fires on genuine pathologies. Tunable: lower it to bound
 * hashing cost more tightly.
 */
export const MAX_HASH_LINES = 1_000_000;
