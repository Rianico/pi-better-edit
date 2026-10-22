export const HASH_LEN = 4;

export const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const ALPHA_SAFE = ALPHA.replace(/-/g, "\\-");

// SAFETY: ALPHA is a fixed 62-char alphanumeric constant; ALPHA_SAFE escapes the only regex meta ("-") and pattern length is bounded to 62 chars — no user input, no ReDoS, linear character class.
export const ALPHA_RE = new RegExp(`^[${ALPHA_SAFE}]+$`);

export const HASH_CLASS = `[${ALPHA_SAFE}]{${HASH_LEN}}`;

// SAFETY: HASH_CLASS is derived from the trusted alphabet at the configured width, bounded length, no nested quantifiers or backtracking — linear match, no ReDoS; not built from user input.
export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);

/**
 * The anchor-list shape the store persists: every entry must be a current-generation anchor.
 *
 * WHY: lives beside `HASH_RE` — the shape's single owner — rather than beside any one caller, so a
 * WHY: row validated on write and re-validated on read cannot disagree about what an anchor is.
 */
export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}
