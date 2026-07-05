import xxhash from "xxhash-wasm";

export const HASH_LEN = 3;
export const ANCHOR_LEN = HASH_LEN;

/**
 * The `│` (U+2502) delimiter between a hash anchor and its line content. This
 * is the wire-format separator in `HASH│content` rows. Kept as a constant so
 * every construction site resolves the same delimiter.
 */
export const HASH_SEP = "│";

const ALPH =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALPH_BITS = 6;
const ALPH_MASK = (1 << ALPH_BITS) - 1;
const ALPH_SAFE = ALPH.replace(/-/g, "\\-");
const ALPH_RE = new RegExp(`^[${ALPH_SAFE}]+$`);
export const HASH_CLASS = `[${ALPH_SAFE}]{${HASH_LEN}}`;

function h2s(h: number): string {
	const totalBits = HASH_LEN * ALPH_BITS;
	const shift = 32 - totalBits;
	let n = h >>> shift;
	let out = "";
	for (let j = 0; j < HASH_LEN; j++) {
		out +=
			ALPH[
				(n >>> ((HASH_LEN - 1 - j) * ALPH_BITS)) &
					ALPH_MASK
			]!;
	}
	return out;
}

export const HL_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*${HASH_CLASS}│`,
);
export const HL_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*${HASH_CLASS}│`,
);
export const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CLASS})│`);

type Hasher = { h32(input: string, seed?: number): number };
let hasherP: Promise<Hasher> | null = null;
let hasher: Hasher | null = null;

function getH(): Hasher {
	if (hasher) return hasher;
	throw new Error("xxhash-wasm not initialized yet. This should not happen.");
}

hasherP = xxhash().then((h) => {
	hasher = h;
	return h;
});

export function initHasher(): Promise<Hasher> {
	return hasherP!
}

function xxh32(input: string, seed = 0): number {
	return getH().h32(input, seed) >>> 0;
}

function canon(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

/**
 * Compute a unique 3-character hash for every line of `content`.
 *
 * Each line is hashed with xxHash32 over its canonical form (trailing
 * whitespace and CR characters stripped). If the base hash collides with a
 * hash already assigned to an earlier line, a retry counter (`:R{retry}`)
 * is appended to the canonical content and the hash is recomputed until a
 * unique anchor is found. This perfect-hashing step guarantees every line
 * in a file receives a distinct anchor, even when multiple lines contain
 * identical text (e.g. repeated `}` or `import` statements).
 */
export function lineHashes(content: string): string[] {
	const lines = content.split("\n");
	const hashes = new Array<string>(lines.length);
	const assigned = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const c = canon(lines[i]!);
		let hash = h2s(xxh32(c));
		let retry = 0;
		while (assigned.has(hash)) {
			retry++;
			hash = h2s(xxh32(`${c}:R${retry}`));
		}
		assigned.add(hash);
		hashes[i] = hash;
	}
	return hashes;
}


export { ALPH_RE };
