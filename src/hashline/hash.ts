import xxhash from "xxhash-wasm";
import * as Diff from "diff";
import { loadHashStore, saveHashStore } from "../hash-store";

export const HASH_LEN = 3;
export const ANCHOR_LEN = HASH_LEN;

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

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
): Promise<string[]> {
  if (!path) {
    return _lineHashesPure(content);
  }

  const store = await loadHashStore();

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

  const snapshot = store.snapshots[path];
  if (snapshot && snapshot.content === content) {
    return snapshot.hashes;
  }

  const newHashes = _lineHashesPure(content);
  store.snapshots[path] = { content, hashes: newHashes };
  await saveHashStore(store);
  return newHashes;
}

function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
): string[] {
  const newLines = newContent.split("\n");
  const newHashes = new Array<string>(newLines.length);
  const used = new Set<string>();

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

  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i]!;
    const candidates = contentMap.get(line);
    if (!candidates || candidates.length === 0) continue;

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
