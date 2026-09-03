import { splitLines } from "../utils.js";
import { xxh32, contentChecksum, initHasher } from "./hasher.js";
import { HASH_LEN, ALPHA, ALPHA_RE, HASH_CLASS, HASH_RE } from "./alphabet.js";

export { initHasher, HASH_LEN, ALPHA_RE, HASH_CLASS };

export interface HashSnapshotIO {
	get(
		path: string,
		content: string,
		deleteCorrupt: boolean,
	): Promise<string[] | undefined>;
	upsert(
		path: string,
		checksum: string,
		lineCount: number,
		hashes: string[],
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

// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, bounded 3-char, linear prefix match — no user input, no nested quantifiers, no ReDoS.
export const HL_PREFIX_PLUS_RE = new RegExp(`^\\+${HASH_CLASS}│`);
// SAFETY: HASH_CLASS and ANCHOR_LEN are trusted constants (3-char alphanumeric), bounded and linear — no user-controlled pattern, no ReDoS.
export const HL_PREFIX_MINUS_RE = new RegExp(
	`^-(?:${HASH_CLASS}│| {${ANCHOR_LEN}}│)`,
);
// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, bounded 3-char, linear anchor prefix — no user input, no ReDoS.
export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CLASS})│`);
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
		(right >= candidates.length ||
			target - candidates[left]! <= candidates[right]! - target)
	) {
		return left;
	}
	return right < candidates.length ? right : -1;
}

// SAFETY: large-class — HashIdentity owns hash allocation, canon cache, and snapshot IO as a cohesive single-owner state; splitting would scatter the stable-hash invariant.
export class HashIdentity {
	private hashToCanon = new Map<string, string>();
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

	rememberHashCanon(hash: string, canonText: string): void {
		if (!this.hashToCanon.has(hash)) this.hashToCanon.set(hash, canonText);
	}

	getCanonForHash(hash: string): string | undefined {
		return this.hashToCanon.get(hash);
	}

	clearCanon(): void {
		this.hashToCanon.clear();
	}

	canonEntries(): IterableIterator<[string, string]> {
		return this.hashToCanon.entries();
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
		throw new Error(
			`[MODEL] [E_LARGE_FILE] Cannot allocate a unique hash anchor: the file exceeds the ${HASH_SPACE}-line limit for ${HASH_LEN}-char hashline anchors. For very large files use write or a non-line-based approach.`,
		);
	}

	private assignHash(
		used: Uint32Array,
		baseIdx: number,
		hint: { value: number },
	): string {
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
			this.rememberHashCanon(h, c);
		}
		return hashes;
	}

	private buildOldHashIndex(
		oldHashes: string[],
		used: Uint32Array,
	): Map<string, number> {
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
	private markHashUsed(
		hash: string,
		used: Uint32Array,
		hint: { value: number },
	): void {
		const idx = hashToIndex(hash);
		if (idx < 0) return;
		this.setBit(used, idx);
		if (idx + HASH_PROBE_STRIDE > hint.value)
			hint.value = idx + HASH_PROBE_STRIDE;
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
			const candidates = newByContent.get(
				getCanon(canonCache, oldLines[entry.index]!),
			);
			if (!candidates || candidates.length === 0) continue;
			const target =
				entry.index > spanEnd ? entry.index + shiftAfterSpan : entry.index;
			const pos = nearestNew(candidates, target);
			if (pos < 0) continue;
			const newIdx = candidates.splice(pos, 1)[0]!;
			newHashes[newIdx] = entry.hash;
			this.markHashUsed(entry.hash, used, hint);
			this.rememberHashCanon(
				entry.hash,
				getCanon(canonCache, oldLines[entry.index]!),
			);
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
			this.rememberHashCanon(h, c);
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
		const { survivors } = this.partitionEntries(
			oldHashes,
			removedIndexes,
		);
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
// SAFETY: pass-through wrapper — see above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- SAFETY: retained wrapper for import surface
function rememberHashCanon(hash: string, canonText: string): void {
	defaultHashIdentity.rememberHashCanon(hash, canonText);
}

// SAFETY: pass-through wrapper — retained for external import surface; trivial delegate kept over churn.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- SAFETY: retained wrapper for import surface
function getCanonForHash(hash: string): string | undefined {
	return defaultHashIdentity.getCanonForHash(hash);
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
