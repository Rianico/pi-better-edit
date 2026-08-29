import { canon } from "../hash.js";

export function findCanonMatches(fileLines: string[], canonVal: string): number[] {
	const matches: number[] = [];
	for (let i = 0; i < fileLines.length; i++) if (canon(fileLines[i] ?? "") === canonVal) matches.push(i);
	return matches;
}

export function isUniqueSection(fileLines: string[], start: number, len: number): boolean {
	if (len <= 2) return true;
	const healedCanons: string[] = [];
	for (let k = 0; k < len; k++) healedCanons.push(canon(fileLines[start + k] ?? ""));
	let count = 0;
	for (let i = 0; i <= fileLines.length - len; i++) {
		let ok = true;
		for (let k = 0; k < len; k++) if (canon(fileLines[i + k] ?? "") !== healedCanons[k]) { ok = false; break; }
		if (ok) count++;
		if (count > 1) break;
	}
	return count === 1;
}

export function isLengthHealedViaCanon(
	served: (string | null)[],
	from: number,
	servedLen: number,
	fileLines: string[],
	store: { get(hash: string): string | undefined },
): boolean {
	const expectedCanons: string[] = [];
	for (let k = 0; k < servedLen; k++) {
		const h = served[from + k];
		if (h === null) return false;
		const c = store.get(h);
		if (c === undefined) return false;
		expectedCanons.push(c);
	}
	let matches = 0;
	for (let i = 0; i <= fileLines.length - servedLen; i++) {
		let ok = true;
		for (let k = 0; k < servedLen; k++) {
			if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
				ok = false;
				break;
			}
		}
		if (ok) matches++;
		if (matches > 1) break;
	}
	return matches === 1;
}
