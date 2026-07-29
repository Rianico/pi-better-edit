import { MAX_HASH_RETRIES } from "../constants";
import { splitLines } from "../utils";
import {
  loadHashStore,
  type HashStore,
  getSnapshot,
  upsertSnapshot,
} from "../hash-store";
import { xxh32, contentChecksum, initHasher } from "./hasher";
export { initHasher };

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
	const n = h >>> shift;
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


function canon(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

function nextUniqueHash(content: string, used: Set<string>): string {
	let retry = 0;
	let hash = h2s(xxh32(content));
	while (used.has(hash)) {
		retry++;
		if (retry > MAX_HASH_RETRIES) throw new Error("Hash space exhausted");
		hash = h2s(xxh32(`${content}:R${retry}`));
	}
	used.add(hash);
	return hash;
}

export function _lineHashesPure(content: string): string[] {
  const lines = splitLines(content);
  const hashes = new Array<string>(lines.length);
  const assigned = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const c = canon(lines[i]!);
    const hash = nextUniqueHash(c, assigned);
    hashes[i] = hash;
  }
  return hashes;
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  store?: HashStore,
  persist?: boolean,
): Promise<string[]> {
  if (!path) {
    return _lineHashesPure(content);
  }

  const hashStore = store ?? await loadHashStore();

  if (previous) {
    const newHashes = mapStableHashes(
      previous.content, previous.hashes,
      content,
      previous.removedHashes,
    );
    if (persist !== false) {
      upsertSnapshot(hashStore, path, contentChecksum(content), splitLines(content).length, newHashes);
    }
    return newHashes;
  }

  const cached = getSnapshot(hashStore, path, content);
  if (cached) {
    return cached;
  }

  const newHashes = _lineHashesPure(content);
  if (persist !== false) {
    upsertSnapshot(hashStore, path, contentChecksum(content), splitLines(content).length, newHashes);
  }
  return newHashes;
}

function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
): string[] {
  const newLines = splitLines(newContent);
  const newHashes = new Array<string>(newLines.length);
  const used = new Set<string>();

  const contentMap = new Map<string, { index: number; hash: string }[]>();
  const oldLines = splitLines(oldContent);
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
    let bestDist = Infinity;
    for (let j = 0; j < candidates.length; j++) {
      if (removedHashes?.has(candidates[j]!.hash)) continue;
      const dist = Math.abs(candidates[j]!.index - i);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }

    if (removedHashes?.has(candidates[bestIdx]!.hash)) continue;
    const match = candidates.splice(bestIdx, 1)[0]!;
    newHashes[i] = match.hash;
    used.add(match.hash);
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue;
    const c = canon(newLines[i]!);
    const hash = nextUniqueHash(c, used);
    newHashes[i] = hash;
  }
  return newHashes;
}

export { ALPH_RE };
