import xxhash from "xxhash-wasm";
import * as Diff from "diff";
import { loadHashStore, saveHashStore } from "../hash-store";

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
}).catch((err) => {
	console.error("xxhash-wasm initialization failed:", err);
	throw err;
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
 * Pure hash computation — no I/O, no persistence. Used internally by the
 * stable path and as a fallback when no file path is available.
 * Each line is hashed with xxHash32 over its canonical form (trailing
 * whitespace and CR characters stripped). If the base hash collides with a
 * hash already assigned to an earlier line, a retry counter (`:R{retry}`)
 * is appended to the canonical content and the hash is recomputed until a
 * unique anchor is found. This perfect-hashing step guarantees every line
 * in a file receives a distinct anchor, even when multiple lines contain
 * identical text (e.g. repeated `}` or `import` statements).
 */
export function _lineHashesPure(content: string): string[] {
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

/**
 * Stable, persistent-aware hash computation.
 *
 * When `path` is provided, uses the persistent hash store to preserve
 * hashes for unchanged lines across edits. When `previous` is also
 * provided (called from the replace pipeline), diffs the previous content
 * against the new content and copies hashes for unchanged lines to their
 * new positions. New/changed lines allocate fresh hashes with collision
 * avoidance against the preserved set.
 *
 * When `path` is provided without `previous` (called from read), loads
 * the stored snapshot for that path. If the content matches, returns the
 * saved hashes. Otherwise computes fresh hashes via `_lineHashesPure` and
 * saves a new snapshot.
 *
 * When `path` is not provided, falls back to `_lineHashesPure` (for
 * backward compatibility and tests that don't need persistence).
 */
export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
): Promise<string[]> {
  if (!path) {
    return _lineHashesPure(content);
  }

  const store = await loadHashStore();

  // Case 1: previous content provided (replace pipeline) — diff and preserve
  if (previous) {
    const newHashes = mapStableHashes(
      previous.content, previous.hashes,
      content,
      previous.removedHashes,
    );
    store.snapshots[path] = { content, hashes: newHashes };
    await saveHashStore(store);
    return newHashes;
  }

  // Case 2: no previous — check snapshot or compute fresh
  const snapshot = store.snapshots[path];
  if (snapshot && snapshot.content === content) {
    return snapshot.hashes;
  }

  // Compute fresh hashes
  const newHashes = _lineHashesPure(content);
  store.snapshots[path] = { content, hashes: newHashes };
  await saveHashStore(store);
  return newHashes;
}

/**
 * Maps old hashes to new positions using hash-aware content matching.
 * Unlike Diff.diffLines (which is content-only and cannot distinguish
 * identical lines at different positions), this algorithm uses the
 * removedHashes set to disambiguate: when a line appears multiple times
 * in the old content and one occurrence was targeted by the edit,
 * the surviving occurrence is matched to the non-removed hash.
 * New/changed lines allocate fresh hashes with collision avoidance.
 */
function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
): string[] {
  const newLines = newContent.split("\n");
  const newHashes = new Array<string>(newLines.length);
  const used = new Set<string>();

  // Build a map from line content to list of (index, hash) for the old content.
  // We process occurrences left-to-right so that matching preserves order.
  const contentMap = new Map<string, { index: number; hash: string }[]>();
  const oldLines = oldContent.split("\n");
  for (let i = 0; i < oldLines.length; i++) {
    const line = oldLines[i]!;
    const entry = { index: i, hash: oldHashes[i]! };
    const list = contentMap.get(line);
    if (list) {
      list.push(entry);
    } else {
      contentMap.set(line, [entry]);
    }
  }

  // Match each new line to an old occurrence by content.
  // For lines with duplicate content, prefer occurrences whose hash
  // was NOT targeted by the edit (those are the survivors).
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i]!;
    const candidates = contentMap.get(line);
    if (!candidates || candidates.length === 0) continue;

    // Find the best match: prefer a non-removed occurrence.
    // If all remaining occurrences are removed, use the first one anyway
    // (it will get a fresh hash in the fill step since its hash is in used+removed).
    let bestIdx = 0;
    if (removedHashes && removedHashes.size > 0) {
      for (let j = 0; j < candidates.length; j++) {
        if (!removedHashes.has(candidates[j]!.hash)) {
          bestIdx = j;
          break;
        }
      }
    }

    const match = candidates.splice(bestIdx, 1)[0]!;
    newHashes[i] = match.hash;
    used.add(match.hash);
  }

  // Fill remaining (new/changed) lines with fresh hashes
  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue;
    const c = canon(newLines[i]!);
    let retry = 0;
    let hash = h2s(xxh32(c));
    while (used.has(hash)) {
      retry++;
      hash = h2s(xxh32(`${c}:R${retry}`));
    }
    used.add(hash);
    newHashes[i] = hash;
  }

  return newHashes;
}

export { ALPH_RE };
