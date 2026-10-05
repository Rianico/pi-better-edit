import { isAbsolute, resolve } from "node:path";
import { splitLines } from "../utils.js";
import { DomainError } from "../domain-errors.js";
import { SERVED_MAX_LINES } from "../constants.js";
import { xxh32, contentChecksum, initHasher } from "./hasher.js";
import { HASH_LEN, ALPHA, ALPHA_RE, HASH_CLASS, HASH_RE } from "./alphabet.js";

export { initHasher, HASH_LEN, ALPHA_RE, HASH_CLASS };

export interface HashSnapshotUpsertOptions {
  /**
   * WHY: retirement is conditional on an authoritative materialization (spec §3.1.3.3 / §3.2.4
   * WHY: step 4): it must be `true` only when `content` is the file's committed truth (read-path
   * WHY: materialization, post-write batch commit, undo revert). In-memory working-buffer hashing
   * WHY: that never reaches disk must leave `retired_at` untouched, or a rejected batch would
   * WHY: retire every anchor the session still validly holds and force a re-read.
   */
  retireLeases?: boolean;
  /**
   * The served rows to lease inside the materialization transaction (spec §3.1.2 step 5 /
   * §3.2.4 step 4): granted with `retired_at = NULL` and `served_snapshot_hash` bound to the
   * snapshot this transaction commits, so snapshot + lineage + leases commit or roll back as
   * one `BEGIN IMMEDIATE` unit. Absent on hashing paths that serve nothing (working buffers).
   */
  leases?: {
    sessionKey: string;
    rows: ReadonlyArray<{ position: number; hash: string | null }>;
  };
  /**
   * CAND-3: the served mirror write for the same rows, committed inside the materialization's
   * own `BEGIN IMMEDIATE` (via `recordServedMirrorInTransaction`), so the `served_leases` grant
   * and the mirror rows commit or roll back as one unit — lease-without-mirror and
   * mirror-without-lease become structurally unreachable on the post-write commit. Absent on
   * paths that write the mirror separately (the read path records serves through its own seam).
   */
  servedMirror?: {
    sessionKey: string;
    rows: ReadonlyArray<{ position: number; hash: string | null }>;
    /** Truncated-serve mirror shape: clamp to `lineCount`, clear from `clearFrom`. */
    shape?: { lineCount: number; clearFrom?: number };
    /** Anchors added to the legacy retired set in this transaction (undo's displaced cleanup). */
    retireAnchors?: readonly string[];
  };
}

export interface HashSnapshotIO {
  get(path: string, content: string, deleteCorrupt: boolean): Promise<string[] | undefined>;
  upsert(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    content: string,
    options?: HashSnapshotUpsertOptions,
  ): Promise<void>;
}

export type HashPrior = {
  content: string;
  hashes: string[];
  removedHashes?: Set<string>;
};

export interface HashOptions {
  // WHY: required — file materialization has no content-only fallback. Tests that
  // WHY: need content-only derivation use the explicit `contentOnlyHashes` instead.
  path: string;
  prior?: HashPrior;
  persist?: boolean;
  snapshotIO?: HashSnapshotIO;
  blockedHashes?: ReadonlySet<string>;
  /** Passed to `HashSnapshotIO.upsert`; see `HashSnapshotUpsertOptions`. Defaults to `false`. */
  retireLeases?: boolean;
}

/**
 * The anchor assignment a walk can carry, for a caller that visits every line anyway.
 *
 * WHY: `hashesFor` returns a finished array, which forces it to split the text to produce one. The
 * WHY: served read walks its lines to select a page, so it takes the assignment step instead and drives
 * WHY: it from that walk — one pass over the text for both.
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
// WHY: an all-digit anchor is structurally confusable with a line number, and a
// WHY: served one pasted back resolves to a legitimate line and verifies —
// WHY: undetectable after the fact. So the digit subcube is reserved at
// WHY: allocation time and never served; the set derives from ALPHA (no new
// WHY: width/size literals) so a width or alphabet change recomputes it.
const DIGIT_CHARS = ALPHA.split("").filter((c) => c >= "0" && c <= "9");
const RESERVED_HASH_SPELLINGS = DIGIT_CHARS.length ** HASH_LEN;
export const USABLE_HASH_SPACE = HASH_SPACE - RESERVED_HASH_SPELLINGS;
// SAFETY: fixed digit set from the trusted alphabet at the configured width, no user input, linear character class, no ReDoS.
export const DIGIT_ANCHOR_RE = new RegExp(`^[${DIGIT_CHARS.join("")}]{${HASH_LEN}}$`);
// WHY: the reservation is a fixed pre-set bit mask, so allocation still derives
// WHY: the base index from content and identical content keeps identical anchors.
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
// WHY: single owner of the space-exhaustion payload — the producer throws it
// WHY: and the capacity tests assert it, so the binding cannot drift.
export const HASH_SPACE_EXHAUSTED_PAYLOAD = {
  limitKind: "hash-space",
  limit: USABLE_HASH_SPACE,
} as const;

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

// WHY: the stride stays coprime with both the raw space and the usable space
// WHY: (see the stride pin) — the probe cycles the raw bitset where reserved
// WHY: indices are just set bits, so exhaustion detection stays exact.
// WHY: (constraint) the stride must stay coprime with `HASH_SPACE` (currently
// WHY: true because 3,907 is prime and does not divide 62^4 = 2^4 × 31^4).
export const HASH_PROBE_STRIDE = ALPHA.length ** 2 + ALPHA.length + 1;

/**
 * CANON_VERSION 3 (issue #22): the frozen 28-code-point whitespace class below replaces the v2
 * ASCII-only class of ADR-0005 — see ADR-0029 for the amendment and the migration notes. Snapshot
 * keys carry the version as their first component (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`),
 * so pre-v3 rows are inert cache misses rebuilt on the next read — no pre-v3 constant is retained.
 */
export const CANON_VERSION = 3;

/**
 * ANCHOR_GENERATION 1 (issue #20, ADR-0031): the file-scoped anchor-derivation generation.
 * It covers exactly: (1) the width (`HASH_LEN`, `ALPHA`, `HASH_SPACE`/`USABLE_HASH_SPACE`);
 * (2) the (path, content) seeding (`fileBaseIndex` seeds xxh32 with the canonical absolute path,
 * `contentBaseIndex` is the explicit content-only fallback); (3) the all-digit reservation
 * (`DIGIT_CHARS`/`RESERVED_HASH_SPELLINGS`/`RESERVED_BITS` pre-marked in allocation); (4) the probe
 * stride (`HASH_PROBE_STRIDE`, coprime with both spaces). Bump it whenever any of those change.
 *
 * WHY: single owner of the anchor-generation literal — anchor-bearing artifacts (the undo/snapshot
 * generation gate and the open-time sweep) read this axis only, never `CANON_VERSION`; the snapshot
 * cache key carries both (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`), so a canon-only change
 * misses the cache without invalidating anchor state while a generation change invalidates both.
 */
export const ANCHOR_GENERATION = 1;

/**
 * WHY: an explicit code-point list, never a Unicode property escape — \p{White_Space} and \p{Cf}
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

function getCanon(cache: Map<string, string>, line: string): string {
  let v = cache.get(line);
  if (v !== undefined) return v;
  v = canon(line);
  cache.set(line, v);
  return v;
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

// WHY: single owner of anchor derivation — every allocation base index flows
// WHY: through `contentBaseIndex` (content-only) or `fileBaseIndex` (file-scoped).
// WHY: The file-scoped path uses the full 32 bits while the content-only path
// WHY: keeps `>>> 14`: the 18-bit confinement makes same-spelling-different-file collisions
// WHY: likely (`n²/2^18`), and the pre-set `RESERVED_BITS` mask makes `assignHash`
// WHY: refuse a reserved fast-path index, so the reservation is safe in the full space.
export function canonicalAnchorPath(path: string): string {
  if (!isAbsolute(path)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Anchor derivation requires an absolute file path, got ${JSON.stringify(path)}.`,
    });
  }
  // WHY: `resolve` (lexical on absolute inputs — no realpath, no cwd) strips a
  // WHY: trailing separator, so `/x/a.ts/` and `/x/a.ts` seed identically.
  return resolve(path);
}
export function contentBaseIndex(canonText: string): number {
  return (xxh32(canonText) >>> 14) % HASH_SPACE;
}
export function fileBaseIndex(canonText: string, pathSeed: number): number {
  return (xxh32(canonText, pathSeed) >>> 0) % HASH_SPACE;
}
// SAFETY: large-class — HashIdentity owns hash allocation, canon cache, and snapshot IO as a cohesive single-owner state; splitting would scatter the stable-hash invariant.
// WHY: the hashCache bound is the served admission budget (SERVED_MAX_LINES),
// WHY: not an arbitrary number: every product materialization is hard-capped at one
// WHY: budget per call by the throwing lines clamp (src/file-content/loader.ts:91-100,
// WHY: reached with maxLines: SERVED_MAX_LINES from src/read.ts:83,
// WHY: src/mutation-engine/edit-source.ts:51,117 and src/lifecycle-hooks/index.ts:153,161,
// WHY: defaulted at src/file-content/index.ts:82,128), so the memo never clears inside an
// WHY: in-budget call and no product path can approach the cap — it sits ~40x below V8's
// WHY: smallest per-Map cap (~2^23 entries on Node 24.0.0). An unbounded memo is unsafe
// WHY: because it grows one entry per allocated anchor (~14.77M entries on the
// WHY: allocator-exhaustion path at HASH_LEN=4, ~916M allocatable at HASH_LEN=5), so the
// WHY: RangeError pre-empts E_LARGE_FILE on a small-cap runtime once the memo alone passes
// WHY: that ceiling. The pure-API exhaustion path is therefore RangeError-free only for
// WHY: inputs with at most ~2^23 distinct line contents: the sibling per-call maps
// WHY: (canonCache, and the pairing index built by buildNewByContent) stay bounded by the
// WHY: input rather than by this bound, so no claim is made above that ceiling.
// WHY: buildNewByContent is deliberately not cleared — it is per-call structural state for
// WHY: survivor pairing, not a recomputable memo. Eviction is clear-on-full (amortized O(1),
// WHY: no per-line iterator — FIFO via keys().next() measured ~1400x slower,
// WHY: scripts/bench-evict.mjs) and behaviour-preserving: idxToHash is a pure function of
// WHY: idx, so a dropped spelling recomputes identically.
export const HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES;
export class HashIdentity {
  private hashCache = new Map<number, string>();
  private snapshotIO?: HashSnapshotIO;

  constructor(options?: { snapshotIO?: HashSnapshotIO }) {
    this.snapshotIO = options?.snapshotIO;
  }

  setSnapshotIO(io: HashSnapshotIO | undefined): void {
    this.snapshotIO = io;
  }

  getSnapshotIO(): HashSnapshotIO | undefined {
    return this.snapshotIO;
  }
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

  // WHY: content-only derivation — never a file's served rows. File materialization
  // WHY: goes through `fileScopedHashes`/the `hashesFor` path branch instead.
  contentOnlyHashes(content: string, blockedHashes?: ReadonlySet<string>): string[] {
    return this.lineHashesPure(content, blockedHashes);
  }

  /**
   * WHY: the per-line step of `lineHashesPure`, split out so the served read can run it inside its
   * WHY: own walk over the text instead of calling back for a whole-content array.
   * WHY: (merge) the walk carries the file's path seed when the caller knows the file, so the
   * WHY: served read's anchors agree with `hashesFor`'s file-scoped ones; pathless callers stay
   * WHY: content-only (`contentBaseIndex`, the single owner beside `fileBaseIndex`).
   */
  private newLineAssigner(
    blockedHashes?: ReadonlySet<string>,
    pathSeed?: number,
  ): (line: string) => string {
    const used = new Uint32Array(BITSET_WORDS);
    // WHY: the digit subcube is pre-marked so neither the fast path nor the
    // WHY: probe in `assignHash` can ever return a reserved index.
    used.set(RESERVED_BITS);
    const hint = { value: 0 };
    const canonCache = new Map<string, string>();
    if (blockedHashes) {
      for (const h of blockedHashes) this.markHashUsed(h, used, hint);
    }
    return (line: string): string => {
      const c = getCanon(canonCache, line);
      const baseIdx = pathSeed === undefined ? contentBaseIndex(c) : fileBaseIndex(c, pathSeed);
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
    const canonCache = new Map<string, string>();
    if (blockedHashes) {
      for (const h of blockedHashes) this.markHashUsed(h, used, hint);
    }
    for (let i = 0; i < lines.length; i++) {
      const c = getCanon(canonCache, lines[i]!);
      const h = this.assignHash(used, fileBaseIndex(c, pathSeed), hint);
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
  private buildNewByContent(
    newLines: string[],
    canonCache: Map<string, string>,
  ): Map<string, number[]> {
    const newByContent = new Map<string, number[]>();
    for (let i = 0; i < newLines.length; i++) {
      const key = getCanon(canonCache, newLines[i]!);
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
    canonCache: Map<string, string>,
    spanEnd: number,
    shiftAfterSpan: number,
  ): void {
    for (const entry of survivors) {
      const candidates = newByContent.get(getCanon(canonCache, oldLines[entry.index]!));
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
    canonCache: Map<string, string>,
    used: Uint32Array,
    hint: { value: number },
    pathSeed: number,
  ): void {
    for (let i = 0; i < newLines.length; i++) {
      if (newHashes[i]) continue;
      const c = getCanon(canonCache, newLines[i]!);
      const baseIdx = fileBaseIndex(c, pathSeed);
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
    const canonCache = new Map<string, string>();
    const newHashes = new Array<string>(newLines.length);
    const used = new Uint32Array(BITSET_WORDS);
    // WHY: pre-marked before old/blocked hashes — survivor reuse is spelling
    // WHY: reuse (faithful copy), not allocation, so only fresh assignment is gated.
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
    const newByContent = this.buildNewByContent(newLines, canonCache);
    this.reuseSurvivorHashes(
      survivors,
      oldLines,
      newByContent,
      newHashes,
      used,
      hint,
      canonCache,
      spanEnd,
      shiftAfterSpan,
    );
    this.allocateFreshHashes(newLines, newHashes, canonCache, used, hint, pathSeed);
    return newHashes;
  }

  /**
   * The anchor assignment for a content whose lines the caller is about to walk themselves.
   *
   * WHY: the served read walks the text once — assigning an anchor AND keeping the page — which a
   * WHY: `hashesFor` call cannot drive because it must finish the whole array first. Everything else is
   * WHY: `hashesFor`'s behaviour: the same snapshot cache and the same `blockedHashes` handling.
   *
   * `prior` (the stable remap) needs the old AND new line arrays, and pathless hashing has no store
   * to hand a walk to, so both stay whole-content calls here.
   */
  async anchorsForWalk(content: string, options?: HashOptions): Promise<AnchorWalk> {
    await initHasher();
    const path = options?.path;
    const persist = options?.persist ?? true;
    const snapshotIO = options?.snapshotIO ?? this.snapshotIO;
    if (!path || options?.prior) {
      return { cached: await this.hashesFor(content, options) };
    }

    let cached: string[] | undefined;
    if (snapshotIO) {
      try {
        cached = await snapshotIO.get(path, content, persist);
      } catch (error) {
        // SAFETY: best-effort cache read — snapshot read failures are ignored; fallback to recomputing hashes preserves correctness, only loses caching benefit.
        console.error("Failed to read hash store snapshot:", error);
      }
    }
    if (cached) return { cached };
    // WHY: the plan assigns one line at a time and writes nothing: the read path persists its snapshot
    // WHY: and leases through `upsertSnapshotFor`, once the page has been rendered.
    // WHY: (merge) the walk seeds from the file when known — a content-only walk would serve anchors
    // WHY: the file-scoped edit pipeline refuses as foreign, so both halves must derive identically.
    return {
      assign: this.newLineAssigner(options?.blockedHashes, xxh32(canonicalAnchorPath(path))),
    };
  }

  async hashesFor(content: string, options?: HashOptions): Promise<string[]> {
    await initHasher();
    const path = options?.path ?? "";
    // WHY: computed once per materialization and threaded into the allocator —
    // WHY: per-line reseeding would cost an xxh32 per line for no benefit.
    const pathSeed = xxh32(canonicalAnchorPath(path));
    const prior = options?.prior;
    const persist = options?.persist ?? true;
    const snapshotIO = options?.snapshotIO ?? this.snapshotIO;
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
          // SAFETY: best-effort cache persist — hash snapshot write failures are ignored; hashes are already computed and returned, next read will recompute and retry persist, no data loss.
          console.error("Failed to persist hash snapshot:", error);
        }
      }
      return newHashes;
    }

    let cached: string[] | undefined;
    if (snapshotIO) {
      try {
        cached = await snapshotIO.get(path, content, persist);
      } catch (error) {
        // SAFETY: best-effort cache read — snapshot read failures are ignored; fallback to recomputing hashes preserves correctness, only loses caching benefit.
        console.error("Failed to read hash store snapshot:", error);
      }
    }
    if (cached) {
      // WHY: a snapshot cache HIT is still a materialization (spec §3.1.3 / §3.2.4 step 3): the
      // WHY: reversion / undo-revert flows re-adopt an OLDER canonical snapshot, so the
      // WHY: authoritative `retired_at` writer must run for the adopted lineage too. Skipping the
      // WHY: upsert here left leases from the newer version active forever (fail-closed loop).
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
          // SAFETY: best-effort cache re-adopt — snapshot/lease update failures are ignored; the hashes are already authoritative and the next materialization retries.
          console.error("Failed to re-adopt hash snapshot:", error);
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
        // SAFETY: best-effort cache persist — hash snapshot write failures are ignored; hashes are already computed and returned, next read will recompute and retry persist, no data loss.
        console.error("Failed to persist hash snapshot:", error);
      }
    }
    return newHashes;
  }

  hashesForSync(content: string, path: string, blockedHashes?: ReadonlySet<string>): string[] {
    return this.fileScopedHashes(content, xxh32(canonicalAnchorPath(path)), blockedHashes);
  }

  static create(snapshotIO?: HashSnapshotIO): HashIdentity {
    return new HashIdentity(snapshotIO ? { snapshotIO } : undefined);
  }
}

export const defaultHashIdentity = new HashIdentity();

// SAFETY: retained pass-through for test/back-compat — delegates to defaultHashIdentity; kept as small wrapper, not inlined to preserve import surface.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- SAFETY: retained wrapper for import surface
function setDefaultHashSnapshotIO(io: HashSnapshotIO | undefined): void {
  defaultHashIdentity.setSnapshotIO(io);
}

export function contentOnlyHashes(content: string, blockedHashes?: ReadonlySet<string>): string[] {
  return defaultHashIdentity.contentOnlyHashes(content, blockedHashes);
}

// WHY: main #47's walk-identity tests import the pure content-only surface by this name;
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
  // WHY: main's served preview falls back to a pathless call when it holds no path —
  if (path === undefined) return contentOnlyHashes(content, blockedHashes);
  return defaultHashIdentity.hashesFor(content, {
    path,
    prior: previous,
    persist: persist ?? true,
    snapshotIO: io,
    blockedHashes,
  });
}
