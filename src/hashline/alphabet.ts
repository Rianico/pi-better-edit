export const HASH_LEN = 4;

export const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const ALPHA_SAFE = ALPHA.replace(/-/g, "\\-");

// SAFETY: ALPHA is a fixed 62-char alphanumeric constant; ALPHA_SAFE escapes the only regex meta ("-") and pattern length is bounded to 62 chars — no user input, no ReDoS, linear character class.
export const ALPHA_RE = new RegExp(`^[${ALPHA_SAFE}]+$`);

export const HASH_CLASS = `[${ALPHA_SAFE}]{${HASH_LEN}}`;

// SAFETY: HASH_CLASS is derived from the trusted alphabet at the configured width, bounded length, no nested quantifiers or backtracking — linear match, no ReDoS; not built from user input.
export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);
