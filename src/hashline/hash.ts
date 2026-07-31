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

export const HASH_SPACE = ALPH.length ** HASH_LEN;
export const MAX_HASH_LINES = HASH_SPACE;

function idxToHash(idx: number): string {
  let out = "";
  for (let j = 0; j < HASH_LEN; j++) {
    out += ALPH[(idx >>> ((HASH_LEN - 1 - j) * ALPH_BITS)) & ALPH_MASK]!;
  }
  return out;
}

const HASH_TABLE: string[] = Array.from(
  { length: HASH_SPACE },
  (_, i) => idxToHash(i),
);

export const HL_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*${HASH_CLASS}│`,
);
export const HL_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*${HASH_CLASS}│`,
);
export const HL_PREFIX_MINUS_RE = new RegExp(
	`^-(?:\\s*${HASH_CLASS}│| {${ANCHOR_LEN}}│)`,
);
export const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CLASS})│`);

function canon(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

const BITSET_WORDS = Math.ceil(HASH_SPACE / 32);

function getBit(bits: Uint32Array, idx: number): boolean {
  return (bits[idx >>> 5] >>> (idx & 31) & 1) !== 0;
}

function setBit(bits: Uint32Array, idx: number): void {
  bits[idx >>> 5] |= 1 << (idx & 31);
}

function nextZeroBit(bits: Uint32Array, start: number): number {
  const totalWords = bits.length;
  const totalBits = totalWords * 32;

  if (start >= totalBits) start = 0;

  const wordIdx = start >>> 5;
  const bitOffset = start & 31;

  let word = bits[wordIdx];
  for (let b = bitOffset; b < 32; b++) {
    if ((word >>> b & 1) === 0) return wordIdx * 32 + b;
  }

  for (let w = wordIdx + 1; w < totalWords; w++) {
    word = bits[w];
    if (~word !== 0) {
      for (let b = 0; b < 32; b++) {
        if ((word >>> b & 1) === 0) return w * 32 + b;
      }
    }
  }

  for (let w = 0; w < wordIdx; w++) {
    word = bits[w];
    if (~word !== 0) {
      for (let b = 0; b < 32; b++) {
        if ((word >>> b & 1) === 0) return w * 32 + b;
      }
    }
  }

  word = bits[wordIdx];
  for (let b = 0; b < bitOffset; b++) {
    if ((word >>> b & 1) === 0) return wordIdx * 32 + b;
  }

  throw new Error(
    `[E_FILE_TOO_LARGE] Cannot allocate a unique hash anchor: the file exceeds the ${HASH_SPACE}-line limit for ${HASH_LEN}-char hashline anchors. For very large files use write or a non-line-based approach.`,
  );
}

function assignHash(used: Uint32Array, baseIdx: number, hint: { value: number }): string {
  if (!getBit(used, baseIdx)) {
    setBit(used, baseIdx);
    hint.value = baseIdx + 1;
    return HASH_TABLE[baseIdx];
  }
  const start = hint.value > baseIdx + 1 ? hint.value : baseIdx + 1;
  const nextIdx = nextZeroBit(used, start);
  setBit(used, nextIdx);
  hint.value = nextIdx + 1;
  return HASH_TABLE[nextIdx];
}

export function _lineHashesPure(content: string): string[] {
  const lines = splitLines(content);
  const hashes = new Array<string>(lines.length);
  const used = new Uint32Array(BITSET_WORDS);
  const hint = { value: 0 };

  for (let i = 0; i < lines.length; i++) {
    const c = canon(lines[i]!);
    const baseIdx = xxh32(c) >>> 14;
    hashes[i] = assignHash(used, baseIdx, hint);
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

function hashToIndex(hash: string): number {
  let idx = 0;
  for (let j = 0; j < HASH_LEN; j++) {
    const charIdx = ALPH.indexOf(hash[j]!);
    if (charIdx < 0) return -1;
    idx = (idx << ALPH_BITS) | charIdx;
  }
  return idx;
}

function findNearestCandidate(
  candidates: { index: number; hash: string }[],
  target: number,
  removedHashes?: Set<string>,
): number {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid]!.index < target) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  while (left >= 0 || right < candidates.length) {
    let bestPos = -1;
    let bestDist = Infinity;
    if (left >= 0) {
      const candidate = candidates[left]!;
      if (!removedHashes?.has(candidate.hash)) {
        bestPos = left;
        bestDist = target - candidate.index;
      }
    }
    if (right < candidates.length) {
      const candidate = candidates[right]!;
      if (!removedHashes?.has(candidate.hash)) {
        const dist = candidate.index - target;
        if (dist < bestDist) {
          bestPos = right;
          bestDist = dist;
        }
      }
    }
    if (bestPos >= 0) return bestPos;
    left--;
    right++;
  }
  return -1;
}

function mapStableHashes(
  oldContent: string,
  oldHashes: string[],
  newContent: string,
  removedHashes?: Set<string>,
): string[] {
  const newLines = splitLines(newContent);
  const newHashes = new Array<string>(newLines.length);
  const used = new Uint32Array(BITSET_WORDS);
  const hint = { value: 0 };

  if (removedHashes) {
    for (const hash of removedHashes) {
      const idx = hashToIndex(hash);
      if (idx >= 0) setBit(used, idx);
    }
  }

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

    const bestIdx = findNearestCandidate(candidates, i, removedHashes);
    if (bestIdx < 0) continue;
    const match = candidates.splice(bestIdx, 1)[0]!;
    newHashes[i] = match.hash;
    const matchIdx = hashToIndex(match.hash);
    if (matchIdx >= 0) {
      setBit(used, matchIdx);
      if (matchIdx + 1 > hint.value) hint.value = matchIdx + 1;
    }
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue;
    const c = canon(newLines[i]!);
    const baseIdx = xxh32(c) >>> 14;
    newHashes[i] = assignHash(used, baseIdx, hint);
  }
  return newHashes;
}

export { ALPH_RE };
