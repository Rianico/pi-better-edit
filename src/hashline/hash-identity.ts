import { isAbsolute, resolve } from "node:path";
import { splitLines } from "../utils.js";
import { DomainError } from "../domain-errors.js";
import { SERVED_MAX_LINES } from "../constants.js";
import type { HashSnapshotIO, HashSnapshotUpsertOptions } from "../snapshot-store";
import { xxh32, contentChecksum, initHasher } from "./hasher.js";
import { HASH_LEN, ALPHA, ALPHA_RE, HASH_CLASS } from "./alphabet.js";
import { reportDiagnostic } from "../diagnostics.js";

export { initHasher, HASH_LEN, ALPHA_RE, HASH_CLASS };

type HashPrior = {
  content: string;
  hashes: string[];
  removedHashes?: Set<string>;
};

export interface HashOptions {
  path: string;
  prior?: HashPrior;
  persist?: boolean;
  /**
   * The store-backed IO this call reads its cache from and persists through — the ONLY persistence
   * path (arch-03 rework). Absent means derive and return with no cache read and no write; there is
   * no ambient fallback, so a call that omits it cannot touch a store.
   */
  snapshotIO?: HashSnapshotIO;
  blockedHashes?: ReadonlySet<string>;
  /** Passed to `HashSnapshotIO.upsert`; see `HashSnapshotUpsertOptions`. Defaults to `false`. */
  retireLeases?: boolean;
}

/**
 * The anchor assignment a walk can carry, for a caller that visits every line anyway.
 *
 *
 * A plan is single-use: `assign` carries the bit set of every anchor it has handed out, so replaying one
 * over a second walk keeps assigning from a space the first walk already spent. Ask for a fresh plan
 * instead. Nothing persists through it — the read path passes `noPersist`, and the authoritative
 * snapshot and lease write is `upsertSnapshotFor`, after the page is rendered.
 */
export interface AnchorWalk {
  /**
   * Assigns the next line's anchor, in walk order. Absent when `cached` carries the anchors already:
   * the store holds this content, so the caller still walks, it just skips the assignment.
   */
  assign?: (line: string) => string;
  /** The anchors this content already has in the store, in line order. */
  cached?: string[];
}

export const ANCHOR_LEN = HASH_LEN;
export const HASH_SEP = "│";
export const HASH_SPACE = ALPHA.length ** HASH_LEN;
const BITSET_WORDS = Math.ceil(HASH_SPACE / 32);
// Ref: docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md
const DIGIT_CHARS = ALPHA.split("").filter((c) => c >= "0" && c <= "9");
const RESERVED_HASH_SPELLINGS = DIGIT_CHARS.length ** HASH_LEN;
export const USABLE_HASH_SPACE = HASH_SPACE - RESERVED_HASH_SPELLINGS;
export const DIGIT_ANCHOR_RE = new RegExp(`^[${DIGIT_CHARS.join("")}]{${HASH_LEN}}$`);
const RESERVED_BITS: Uint32Array = (() => {
  const digitIdx = DIGIT_CHARS.map((c) => ALPHA.indexOf(c));
  const radix = digitIdx.length;
  const base = ALPHA.length;
  const bits = new Uint32Array(BITSET_WORDS);
  for (let n = 0; n < RESERVED_HASH_SPELLINGS; n++) {
    let idx = 0;
    let mult = 1;
    let m = n;
    for (let j = 0; j < HASH_LEN; j++) {
      idx += digitIdx[m % radix]! * mult;
      m = Math.floor(m / radix);
      mult *= base;
    }
    bits[idx >>> 5] |= 1 << (idx & 31);
  }
  return bits;
})();
export const MAX_HASH_LINES = USABLE_HASH_SPACE;
export const HASH_SPACE_EXHAUSTED_PAYLOAD = {
  limitKind: "hash-space",
  limit: USABLE_HASH_SPACE,
} as const;

export const HASH_PROBE_STRIDE = ALPHA.length ** 2 + ALPHA.length + 1;

/**
 * CANON_VERSION 3 (issue #22): the frozen 28-code-point whitespace class below replaces the v2 ASCII-only class of
 * docs/.archive_adrs/0005-whitespace-insensitive-anchors.md; the amendment and the migration notes are in
 * docs/.archive_adrs/0029-canon-v3-frozen-whitespace-class.md. Snapshot keys carry the version as their first component
 * (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`), so pre-v3 rows are inert cache misses rebuilt on the next read — no
 * pre-v3 constant is retained.
 */
export const CANON_VERSION = 3;

/**
 * ANCHOR_GENERATION 2 (issue #230, docs/adr/0013-anchor-identity-derives-from-raw-bytes.md): the file-scoped anchor-derivation
 * generation. It covers exactly: (1) the width (`HASH_LEN`, `ALPHA`, `HASH_SPACE`/`USABLE_HASH_SPACE`); (2) the (path, content)
 * seeding (`fileBaseIndex` seeds xxh32 with the canonical absolute path, `contentBaseIndex` the content-only fallback) —
 * generation 2 seeds on RAW line bytes, generation 1 on the canonicalised line, because `canon` folds 28 whitespace code points
 * and a canon-seeded identity cannot tell `const s = "a`+NBSP+`b";` from `const s = "a b";`; (3) the all-digit reservation and
 * (4) the probe stride (`HASH_PROBE_STRIDE`, coprime with both spaces). Bump it whenever any of those change.
 *
 * Single owner of the literal: anchor-bearing artifacts (the undo/snapshot generation gate and the open-time sweep) read this
 * axis only, never `CANON_VERSION`; the snapshot cache key carries both (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`), so a
 * canon-only change misses the cache without invalidating anchor state while a generation change invalidates both.
 */
export const ANCHOR_GENERATION = 2;

/**
 * An explicit code-point list, never a Unicode property escape: \p{White_Space} and \p{Cf}
 * drift with engine versions while a versioned canon must be a frozen function (issue #22).
 * Frozen set, 6 + 3 + 11 + 5 + 3 = 28 code points: TAB, LF, VT, FF, CR, SP; NEL, NBSP, OGHAM
 * SPACE; EN QUAD…HAIR SPACE (U+2000–U+200A); LINE/PARAGRAPH SEPARATOR, NARROW NBSP, MEDIUM
 * MATHEMATICAL SPACE, IDEOGRAPHIC SPACE; LRM, RLM, ZWNBSP/BOM.
 */
const CANON_CODE_POINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000, 0x200e, 0x200f, 0xfeff,
] as const;
const CANON_RE = new RegExp(
  `[${CANON_CODE_POINTS.map((cp) => `\\u${cp.toString(16).padStart(4, "0")}`).join("")}]+`,
  "g",
);

export function canon(line: string): string {
  return line.replace(CANON_RE, "");
}

/**
 * SAFETY: the canon digest — `String(xxh32(canon(line)))`, the exact value `line_lineage.canon_hash`
 * and `served_leases.canon_hash` persist. Canon evidence is compared as digests so no canon text is
 * ever stored twice in the session database (#151): a candidate reproduces a served line iff its
 * digest equals the digest the lease recorded for that anchor.
 */
export function canonDigest(line: string): string {
  return String(xxh32(canon(line)));
}

function hashToIndex(hash: string): number {
  let idx = 0;
  for (let j = 0; j < HASH_LEN; j++) {
    const charIdx = ALPHA.indexOf(hash[j]!);
    if (charIdx < 0) return -1;
    idx = idx * ALPHA.length + charIdx;
  }
  return idx;
}

function nearestNew(candidates: number[], target: number): number {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const left = lo - 1;
  const right = lo;
  if (
    left >= 0 &&
    (right >= candidates.length || target - candidates[left]! <= candidates[right]! - target)
  ) {
    return left;
  }
  return right < candidates.length ? right : -1;
}

export function canonicalAnchorPath(path: string): string {
  if (!isAbsolute(path)) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message: `Anchor derivation requires an absolute file path, got ${JSON.stringify(path)}.`,
    });
  }
  return resolve(path);
}
// Ref: docs/adr/0013-anchor-identity-derives-from-raw-bytes.md
function contentBaseIndex(line: string): number {
  return (xxh32(line) >>> 14) % HASH_SPACE;
}
export function fileBaseIndex(line: string, pathSeed: number): number {
  return (xxh32(line, pathSeed) >>> 0) % HASH_SPACE;
}
/**
 * Cache bound for `hashCache`: the served admission budget (`SERVED_MAX_LINES`), so a product
 * materialization never clears it in-budget and it sits ~40x below V8's smallest per-Map cap
 * (~2^23 on Node 24.0.0). Unbounded it would take one entry per allocated anchor (~14.77M on
 * the exhaustion path at HASH_LEN=4, ~916M allocatable at HASH_LEN=5), so a RangeError would
 * pre-empt E_LARGE_FILE. Eviction is clear-on-full (amortized O(1); FIFO via `keys().next()`
 * measured ~1400x slower, `scripts/bench-evict.mjs`) and behaviour-preserving: `idxToHash` is
 * pure. `buildNewByContent` stays uncleared — per-call pairing state bounded by the input.
 */
export const HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES;
export class HashIdentity {
  private hashCache = new Map<number, string>();

  private idxToHash(idx: number): string {
    let out = "";
    for (let j = 0; j < HASH_LEN; j++) {
      out = ALPHA[idx % ALPHA.length]! + out;
      idx = Math.floor(idx / ALPHA.length);
    }
    return out;
  }

  private hashAt(idx: number): string {
    let hash = this.hashCache.get(idx);
    if (hash === undefined) {
      hash = this.idxToHash(idx);
      if (this.hashCache.size >= HASH_CACHE_MAX_ENTRIES) {
        this.hashCache.clear();
      }
      this.hashCache.set(idx, hash);
    }
    return hash;
  }

  private getBit(bits: Uint32Array, idx: number): boolean {
    return ((bits[idx >>> 5] >>> (idx & 31)) & 1) !== 0;
  }

  private setBit(bits: Uint32Array, idx: number): void {
    bits[idx >>> 5] |= 1 << (idx & 31);
  }

  private nextZeroBit(bits: Uint32Array, start: number): number {
    const totalBits = HASH_SPACE;
    let idx = start % totalBits;
    for (let i = 0; i < totalBits; i++) {
      if (!this.getBit(bits, idx)) return idx;
      idx += HASH_PROBE_STRIDE;
      if (idx >= totalBits) idx -= totalBits;
    }
    throw new DomainError("E_LARGE_FILE", HASH_SPACE_EXHAUSTED_PAYLOAD);
  }

  private assignHash(used: Uint32Array, baseIdx: number, hint: { value: number }): string {
    if (!this.getBit(used, baseIdx)) {
      this.setBit(used, baseIdx);
      hint.value = baseIdx + HASH_PROBE_STRIDE;
      return this.hashAt(baseIdx);
    }
    const nextIdx = this.nextZeroBit(used, hint.value);
    this.setBit(used, nextIdx);
    hint.value = nextIdx + HASH_PROBE_STRIDE;
    return this.hashAt(nextIdx);
  }

  contentOnlyHashes(content: string, blockedHashes?: ReadonlySet<string>): string[] {
    return this.lineHashesPure(content, blockedHashes);
  }

  /**
   * The per-line step of `lineHashesPure`, split out so the served read can run it inside its
   * own walk over the text instead of calling back for a whole-content array. The walk carries
   * the file's path seed when the caller knows the file, so the served read's anchors agree with
   * `hashesFor`'s file-scoped ones; pathless callers stay content-only (`contentBaseIndex`, the
   * single owner beside `fileBaseIndex`).
   */
  private newLineAssigner(
    blockedHashes?: ReadonlySet<string>,
    pathSeed?: number,
  ): (line: string) => string {
    const used = new Uint32Array(BITSET_WORDS);
    used.set(RESERVED_BITS);
    const hint = { value: 0 };
    if (blockedHashes) {
      for (const h of blockedHashes) this.markHashUsed(h, used, hint);
    }
    return (line: string): string => {
      const baseIdx =
        pathSeed === undefined ? contentBaseIndex(line) : fileBaseIndex(line, pathSeed);
      return this.assignHash(used, baseIdx, hint);
    };
  }

  private lineHashesPure(content: string, blockedHashes?: ReadonlySet<string>): string[] {
    const assign = this.newLineAssigner(blockedHashes);
    const hashes: string[] = [];
    for (const line of splitLines(content)) hashes.push(assign(line));
    return hashes;
  }
  private fileScopedHashes(
    content: string,
    pathSeed: number,
    blockedHashes?: ReadonlySet<string>,
  ): string[] {
    const lines = splitLines(content);
    const hashes = Array.from<string>({ length: lines.length });
    const used = new Uint32Array(BITSET_WORDS);
    used.set(RESERVED_BITS);
    const hint = { value: 0 };
    if (blockedHashes) {
      for (const h of blockedHashes) this.markHashUsed(h, used, hint);
    }
    for (let i = 0; i < lines.length; i++) {
      const h = this.assignHash(used, fileBaseIndex(lines[i]!, pathSeed), hint);
      hashes[i] = h;
    }
    return hashes;
  }

  private buildOldHashIndex(oldHashes: string[], used: Uint32Array): Map<string, number> {
    const oldHashIndex = new Map<string, number>();
    for (let i = 0; i < oldHashes.length; i++) {
      const hash = oldHashes[i]!;
      oldHashIndex.set(hash, i);
      const idx = hashToIndex(hash);
      if (idx >= 0) this.setBit(used, idx);
    }
    return oldHashIndex;
  }
  private collectRemovedIndexes(
    removed: Set<string>,
    oldHashIndex: Map<string, number>,
  ): Set<number> {
    const removedIndexes = new Set<number>();
    for (const hash of removed) {
      const idx = oldHashIndex.get(hash);
      if (idx !== undefined) removedIndexes.add(idx);
    }
    return removedIndexes;
  }
  private computeSpan(
    removedIndexes: Set<number>,
    oldLen: number,
    newLen: number,
  ): { spanStart: number; spanEnd: number; shiftAfterSpan: number } {
    let spanStart = oldLen;
    let spanEnd = -1;
    for (const idx of removedIndexes) {
      if (idx < spanStart) spanStart = idx;
      if (idx > spanEnd) spanEnd = idx;
    }
    const spanLen = spanEnd >= spanStart ? spanEnd - spanStart + 1 : 0;
    const replacementLen = newLen - oldLen + spanLen;
    const shiftAfterSpan = spanEnd >= spanStart ? replacementLen - spanLen : 0;
    return { spanStart, spanEnd, shiftAfterSpan };
  }
  private partitionEntries(
    oldHashes: string[],
    removedIndexes: Set<number>,
  ): {
    survivors: { index: number; hash: string }[];
    removedEntries: { index: number; hash: string }[];
  } {
    const survivors: { index: number; hash: string }[] = [];
    const removedEntries: { index: number; hash: string }[] = [];
    for (let i = 0; i < oldHashes.length; i++) {
      const entry = { index: i, hash: oldHashes[i]! };
      if (removedIndexes.has(i)) removedEntries.push(entry);
      else survivors.push(entry);
    }
    return { survivors, removedEntries };
  }
  private buildNewByContent(newLines: string[]): Map<string, number[]> {
    const newByContent = new Map<string, number[]>();
    for (let i = 0; i < newLines.length; i++) {
      const key = newLines[i]!;
      const list = newByContent.get(key);
      if (list) list.push(i);
      else newByContent.set(key, [i]);
    }
    return newByContent;
  }
  private markHashUsed(hash: string, used: Uint32Array, hint: { value: number }): void {
    const idx = hashToIndex(hash);
    if (idx < 0) return;
    this.setBit(used, idx);
    if (idx + HASH_PROBE_STRIDE > hint.value) hint.value = idx + HASH_PROBE_STRIDE;
  }
  private reuseSurvivorHashes(
    survivors: { index: number; hash: string }[],
    oldLines: string[],
    newByContent: Map<string, number[]>,
    newHashes: string[],
    used: Uint32Array,
    hint: { value: number },
    spanEnd: number,
    shiftAfterSpan: number,
  ): void {
    for (const entry of survivors) {
      const candidates = newByContent.get(oldLines[entry.index]!);
      if (!candidates || candidates.length === 0) continue;
      const target = entry.index > spanEnd ? entry.index + shiftAfterSpan : entry.index;
      const pos = nearestNew(candidates, target);
      if (pos < 0) continue;
      const newIdx = candidates.splice(pos, 1)[0]!;
      newHashes[newIdx] = entry.hash;
      this.markHashUsed(entry.hash, used, hint);
    }
  }

  private allocateFreshHashes(
    newLines: string[],
    newHashes: string[],
    used: Uint32Array,
    hint: { value: number },
    pathSeed: number,
  ): void {
    for (let i = 0; i < newLines.length; i++) {
      if (newHashes[i]) continue;
      const baseIdx = fileBaseIndex(newLines[i]!, pathSeed);
      const h = this.assignHash(used, baseIdx, hint);
      newHashes[i] = h;
    }
  }
  private mapStableHashes(
    oldContent: string,
    oldHashes: string[],
    newContent: string,
    pathSeed: number,
    removedHashes?: Set<string>,
    blockedHashes?: ReadonlySet<string>,
  ): string[] {
    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);
    const newHashes: string[] = [];
    newHashes.length = newLines.length;
    const used = new Uint32Array(BITSET_WORDS);
    used.set(RESERVED_BITS);
    const hint = { value: 0 };
    const removed = removedHashes ?? new Set<string>();
    const oldHashIndex = this.buildOldHashIndex(oldHashes, used);
    if (blockedHashes) {
      for (const h of blockedHashes) this.markHashUsed(h, used, hint);
    }
    const removedIndexes = this.collectRemovedIndexes(removed, oldHashIndex);
    const { spanEnd, shiftAfterSpan } = this.computeSpan(
      removedIndexes,
      oldLines.length,
      newLines.length,
    );
    const { survivors } = this.partitionEntries(oldHashes, removedIndexes);
    const newByContent = this.buildNewByContent(newLines);
    this.reuseSurvivorHashes(
      survivors,
      oldLines,
      newByContent,
      newHashes,
      used,
      hint,
      spanEnd,
      shiftAfterSpan,
    );
    this.allocateFreshHashes(newLines, newHashes, used, hint, pathSeed);
    return newHashes;
  }

  /**
   * The anchor assignment for a content whose lines the caller is about to walk themselves.
   *
   * The served read walks the text once — assigning an anchor AND keeping the page — which a
   * `hashesFor` call cannot drive because it must finish the whole array first. Everything else is
   * `hashesFor`'s behaviour: the same snapshot cache and the same `blockedHashes` handling.
   *
   * `prior` (the stable remap) needs the old AND new line arrays, and pathless hashing has no store
   * to hand a walk to, so both stay whole-content calls here.
   */
  async anchorsForWalk(content: string, options?: HashOptions): Promise<AnchorWalk> {
    await initHasher();
    const path = options?.path;
    const persist = options?.persist ?? true;
    const snapshotIO = options?.snapshotIO;
    if (!path || options?.prior) {
      return { cached: await this.hashesFor(content, options) };
    }

    let cached: string[] | undefined;
    if (snapshotIO) {
      try {
        cached = await snapshotIO.get(path, content, persist);
      } catch (error) {
        reportDiagnostic("hashline", "Failed to read hash store snapshot:", error);
      }
    }
    if (cached) return { cached };
    return {
      assign: this.newLineAssigner(options?.blockedHashes, xxh32(canonicalAnchorPath(path))),
    };
  }

  async hashesFor(content: string, options?: HashOptions): Promise<string[]> {
    await initHasher();
    const path = options?.path ?? "";
    const pathSeed = xxh32(canonicalAnchorPath(path));
    const prior = options?.prior;
    const persist = options?.persist ?? true;
    const snapshotIO = options?.snapshotIO;
    const upsertOptions: HashSnapshotUpsertOptions = {
      retireLeases: options?.retireLeases === true,
    };

    if (prior) {
      const newHashes = this.mapStableHashes(
        prior.content,
        prior.hashes,
        content,
        pathSeed,
        prior.removedHashes,
        options?.blockedHashes,
      );
      if (persist && snapshotIO) {
        try {
          await snapshotIO.upsert(
            path,
            contentChecksum(content),
            splitLines(content).length,
            newHashes,
            content,
            upsertOptions,
          );
        } catch (error) {
          reportDiagnostic("hashline", "Failed to persist hash snapshot:", error);
        }
      }
      return newHashes;
    }

    let cached: string[] | undefined;
    if (snapshotIO) {
      try {
        cached = await snapshotIO.get(path, content, persist);
      } catch (error) {
        reportDiagnostic("hashline", "Failed to read hash store snapshot:", error);
      }
    }
    if (cached) {
      if (persist && snapshotIO) {
        try {
          await snapshotIO.upsert(
            path,
            contentChecksum(content),
            splitLines(content).length,
            cached,
            content,
            upsertOptions,
          );
        } catch (error) {
          reportDiagnostic("hashline", "Failed to re-adopt hash snapshot:", error);
        }
      }
      return cached;
    }

    const newHashes = this.fileScopedHashes(content, pathSeed, options?.blockedHashes);
    if (persist && snapshotIO) {
      try {
        await snapshotIO.upsert(
          path,
          contentChecksum(content),
          splitLines(content).length,
          newHashes,
          content,
          upsertOptions,
        );
      } catch (error) {
        reportDiagnostic("hashline", "Failed to persist hash snapshot:", error);
      }
    }
    return newHashes;
  }

  hashesForSync(content: string, path: string, blockedHashes?: ReadonlySet<string>): string[] {
    return this.fileScopedHashes(content, xxh32(canonicalAnchorPath(path)), blockedHashes);
  }
}

/**
 * The stateless-derivation singleton: content-only and sync anchor derivation, nothing else.
 *
 * It owns no IO, so no call through it can persist — a persistence-touching caller passes
 * `snapshotIO: snapshotIOFor(store)` to `hashesFor`/`anchorsForWalk` itself. Keeping the
 * singleton is what lets the pure helpers stay allocation-free; it is not a store seam.
 */
export const defaultHashIdentity = new HashIdentity();

export function contentOnlyHashes(content: string, blockedHashes?: ReadonlySet<string>): string[] {
  return defaultHashIdentity.contentOnlyHashes(content, blockedHashes);
}

export function _lineHashesPure(content: string, blockedHashes?: ReadonlySet<string>): string[] {
  return contentOnlyHashes(content, blockedHashes);
}

export function fileHashesFor(
  path: string,
  content: string,
  blockedHashes?: ReadonlySet<string>,
): string[] {
  return defaultHashIdentity.hashesForSync(content, path, blockedHashes);
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  io?: HashSnapshotIO,
  persist?: boolean,
  blockedHashes?: ReadonlySet<string>,
): Promise<string[]> {
  if (path === undefined) return contentOnlyHashes(content, blockedHashes);
  return defaultHashIdentity.hashesFor(content, {
    path,
    ...(previous !== undefined ? { prior: previous } : {}),
    persist: persist ?? true,
    ...(io !== undefined ? { snapshotIO: io } : {}),
    ...(blockedHashes !== undefined ? { blockedHashes } : {}),
  });
}
