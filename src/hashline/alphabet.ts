export const HASH_LEN = 4;

export const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// WHY: 62 = A-Z, a-z, 0-9, and "-" is ALPHA's only regex meta — one escape yields a bounded class; neither pattern below takes user text, so both match in linear time.
const ALPHA_SAFE = ALPHA.replace(/-/g, "\\-");

export const ALPHA_RE = new RegExp(`^[${ALPHA_SAFE}]+$`);

export const HASH_CLASS = `[${ALPHA_SAFE}]{${HASH_LEN}}`;

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
