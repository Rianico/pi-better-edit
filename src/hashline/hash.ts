import { splitLines } from "../utils";
import { initHasher } from "./hasher";
import { HASH_LEN, ALPH, ALPH_RE, HASH_CLASS, HASH_RE } from "./alphabet";
export { initHasher, HASH_LEN, ALPH_RE, HASH_CLASS };
import { defaultHashIdentity as _defaultHI } from "./hash-identity";
import type { HashSnapshotIO as _HSIO } from "./hash-identity";

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

export function setDefaultHashSnapshotIO(io: HashSnapshotIO | undefined): void {
	(_defaultHI as any).setSnapshotIO(io as any);
}

export const ANCHOR_LEN = HASH_LEN;

export const HASH_SEP = "│";

export const HASH_SPACE = ALPH.length ** HASH_LEN;
export const MAX_HASH_LINES = HASH_SPACE;

export function isValidHashList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const hash of value) {
		if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
	}
	return true;
}
export const HASH_PROBE_STRIDE = ALPH.length ** 2 + ALPH.length + 1;

export function rememberHashCanon(hash: string, canonText: string): void {
	_defaultHI.rememberHashCanon(hash, canonText);
}

export function getCanonForHash(hash: string): string | undefined {
	return _defaultHI.getCanonForHash(hash);
}

export interface CanonStore {
	get(hash: string): string | undefined;
	set(hash: string, canonText: string): void;
}

export function createCanonStore(): CanonStore {
	const m = new Map<string, string>();
	return {
		get(hash) { return m.get(hash); },
		set(hash, canonText) { if (!m.has(hash)) m.set(hash, canonText); },
	};
}

export function createCanonStoreFromEntries(entries: Array<[string, string]>): CanonStore {
	const m = new Map<string, string>(entries);
	return {
		get(hash) { return m.get(hash); },
		set(hash, canonText) { if (!m.has(hash)) m.set(hash, canonText); },
	};
}

export const globalCanonStore: CanonStore = {
	get(hash) { return getCanonForHash(hash); },
	set(hash, canonText) { rememberHashCanon(hash, canonText); },
};

export function __clearGlobalCanonStoreForTest(): void {
	_defaultHI.clearCanon();
}

export function __globalCanonEntriesForTest(): Array<[string, string]> {
	return [..._defaultHI.canonEntries()];
}

export const HL_PREFIX_PLUS_RE = new RegExp(`^\\+${HASH_CLASS}│`);
export const HL_PREFIX_MINUS_RE = new RegExp(`^-(?:${HASH_CLASS}│| {${ANCHOR_LEN}}│)`);
export const HL_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CLASS})│`);
export const CANON_VERSION = 2;
const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
	return line.replace(CANON_RE, "");
}

export function _lineHashesPure(content: string, canonStore?: CanonStore): string[] {
	if (canonStore && canonStore !== globalCanonStore) {
		const lines = splitLines(content);
		const tmp = _defaultHI.hashesForSync(content);
		for (let i = 0; i < tmp.length; i++) {
			const h = tmp[i]!;
			const c = canon(lines[i] ?? "");
			canonStore.set(h, c);
		}
		return tmp;
	}
	return _defaultHI.hashesForSync(content);
}

export async function lineHashes(content: string, path?: string, previous?: { content: string; hashes: string[]; removedHashes?: Set<string> }, io?: HashSnapshotIO, persist?: boolean, _canonStore?: CanonStore): Promise<string[]> {
	return _defaultHI.hashesFor(content, {
		path,
		prior: previous,
		persist: persist ?? true,
		snapshotIO: io as any,
	});
}
