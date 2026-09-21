import { splitLines } from "../utils.js";
import { DomainError } from "../domain-errors.js";
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
  path?: string;
  prior?: HashPrior;
  persist?: boolean;
  snapshotIO?: HashSnapshotIO;
  tombstone?: ReadonlySet<string>;
  /** Passed to `HashSnapshotIO.upsert`; see `HashSnapshotUpsertOptions`. Defaults to `false`. */
  retireLeases?: boolean;
}

export const ANCHOR_LEN = HASH_LEN;
export const HASH_SEP = "│";
export const HASH_SPACE = ALPHA.length ** HASH_LEN;
export const MAX_HASH_LINES = HASH_SPACE;

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}

const HASH_PROBE_STRIDE = ALPHA.length ** 2 + ALPHA.length + 1;

export const CANON_VERSION = 2;
const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
  return line.replace(CANON_RE, "");
}

function getCanon(cache: Map<string, string>, line: string): string {
  let v = cache.get(line);
  if (v !== undefined) return v;
  v = canon(line);
  cache.set(line, v);
  return v;
}

const BITSET_WORDS = Math.ceil(HASH_SPACE / 32);

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

// SAFETY: large-class — HashIdentity owns hash allocation, canon cache, and snapshot IO as a cohesive single-owner state; splitting would scatter the stable-hash invariant.
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
    throw new DomainError("E_LARGE_FILE", {
      limitKind: "hash-space",
      limit: HASH_SPACE,
    });
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

  private lineHashesPure(content: string, tombstone?: ReadonlySet<string>): string[] {
    const lines = splitLines(content);
    const hashes = new Array<string>(lines.length);
    const used = new Uint32Array(BITSET_WORDS);
    const hint = { value: 0 };
    const canonCache = new Map<string, string>();
    if (tombstone) {
      for (const h of tombstone) this.markHashUsed(h, used, hint);
    }
    for (let i = 0; i < lines.length; i++) {
      const c = getCanon(canonCache, lines[i]!);
      const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
      const h = this.assignHash(used, baseIdx, hint);
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
  ): void {
    for (let i = 0; i < newLines.length; i++) {
      if (newHashes[i]) continue;
      const c = getCanon(canonCache, newLines[i]!);
      const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE;
      const h = this.assignHash(used, baseIdx, hint);
      newHashes[i] = h;
    }
  }
  private mapStableHashes(
    oldContent: string,
    oldHashes: string[],
    newContent: string,
    removedHashes?: Set<string>,
    tombstone?: ReadonlySet<string>,
  ): string[] {
    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);
    const canonCache = new Map<string, string>();
    const newHashes = new Array<string>(newLines.length);
    const used = new Uint32Array(BITSET_WORDS);
    const hint = { value: 0 };
    const removed = removedHashes ?? new Set<string>();
    const oldHashIndex = this.buildOldHashIndex(oldHashes, used);
    if (tombstone) {
      for (const h of tombstone) this.markHashUsed(h, used, hint);
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
    this.allocateFreshHashes(newLines, newHashes, canonCache, used, hint);
    return newHashes;
  }

  async hashesFor(content: string, options?: HashOptions): Promise<string[]> {
    await initHasher();
    const path = options?.path;
    const prior = options?.prior;
    const persist = options?.persist ?? true;
    const snapshotIO = options?.snapshotIO ?? this.snapshotIO;
    const upsertOptions: HashSnapshotUpsertOptions = {
      retireLeases: options?.retireLeases === true,
    };

    if (!path) {
      if (prior) {
        return this.mapStableHashes(
          prior.content,
          prior.hashes,
          content,
          prior.removedHashes,
          options?.tombstone,
        );
      }
      return this.lineHashesPure(content, options?.tombstone);
    }

    if (prior) {
      const newHashes = this.mapStableHashes(
        prior.content,
        prior.hashes,
        content,
        prior.removedHashes,
        options?.tombstone,
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

    const newHashes = this.lineHashesPure(content, options?.tombstone);
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

  hashesForSync(content: string, tombstone?: ReadonlySet<string>): string[] {
    return this.lineHashesPure(content, tombstone);
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

export function _lineHashesPure(content: string, tombstone?: ReadonlySet<string>): string[] {
  return defaultHashIdentity.hashesForSync(content, tombstone);
}

export async function lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  io?: HashSnapshotIO,
  persist?: boolean,
  tombstone?: ReadonlySet<string>,
): Promise<string[]> {
  return defaultHashIdentity.hashesFor(content, {
    path,
    prior: previous,
    persist: persist ?? true,
    snapshotIO: io,
    tombstone,
  });
}
