import { HASH_SEP, canon, getCanonForHash, rememberHashCanon } from "./hash";
import { SERVED_ECHO_CAP } from "../constants";

export type ServedCode =
	| "E_RANGE_STALE"
	| "E_RANGE_UNSERVED"
	| "E_RANGE_UNVERIFIED";

export interface ServedRow {
	position: number;
	hash: string;
}

export class ServedRejectionError extends Error {
	readonly code: ServedCode;
	readonly firstOffendingLine: number | undefined;
	readonly servedRows: ServedRow[];

	constructor(opts: {
		code: ServedCode;
		message: string;
		firstOffendingLine?: number;
		servedRows: ServedRow[];
	}) {
		super(opts.message);
		this.name = "ServedRejectionError";
		this.code = opts.code;
		this.firstOffendingLine = opts.firstOffendingLine;
		this.servedRows = opts.servedRows;
	}
}

export function isServedRejection(
	error: unknown,
): error is ServedRejectionError {
	return error instanceof ServedRejectionError;
}

export class AnchorMismatchError extends Error {
	readonly servedRows: ServedRow[];

	constructor(message: string, servedRows: ServedRow[]) {
		super(message);
		this.name = "AnchorMismatchError";
		this.servedRows = servedRows;
	}
}

export function isAnchorMismatch(error: unknown): error is AnchorMismatchError {
	return error instanceof AnchorMismatchError;
}

export function buildRangeEcho(
	startLine: number,
	endLine: number,
	fileHashes: string[],
): ServedRow[] {
	const total = endLine - startLine + 1;
	const shown = Math.min(total, SERVED_ECHO_CAP);
	const rows: ServedRow[] = [];
	for (let ln = startLine; ln < startLine + shown; ln++) {
		rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
	}
	return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
	return rows
		.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`)
		.join("\n");
}

function retryHint(): string {
	return "Retry with these anchors (no read needed).";
}

function paginationHint(nextOffset: number, more: number): string {
	return `[... ${more} more — read offset=${nextOffset}]`;
}

export function servedPositionsOf(
	served: (string | null)[],
	hash: string,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < served.length; i++) {
		if (served[i] === hash) out.push(i);
	}
	return out;
}

export function verifyServedRange(args: {
	served: (string | null)[];
	startHash: string;
	endHash: string;
	startLine: number;
	endLine: number;
	fileHashes: string[];
	fileLines: string[];
	filePath?: string;
}): void {
	const {
		served,
		startHash,
		endHash,
		startLine,
		endLine,
		fileHashes,
		fileLines,
		filePath,
	} = args;
	const where = filePath ? ` in ${filePath}` : "";
	let isHealed = false;
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		if (getCanonForHash(h) === undefined)
			rememberHashCanon(h, canon(fileLines[i] ?? ""));
	}
	for (let i = 0; i < served.length; i++) {
		const h = served[i];
		if (h !== null && getCanonForHash(h) === undefined) {
			const pos = fileHashes.indexOf(h);
			if (pos >= 0) rememberHashCanon(h, canon(fileLines[pos] ?? ""));
		}
	}
	const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
	const totalLen = endLine - startLine + 1;
	const tail =
		echoRows.length < totalLen
			? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
			: "";
	const echo = fmtServedRows(echoRows, fileLines) + tail;

	const startPositions = servedPositionsOf(served, startHash);
	const endPositions = servedPositionsOf(served, endHash);
	const currentLen = endLine - startLine + 1;
	let from: number | undefined;
	let to: number | undefined;
	if (startPositions.length === 1 && endPositions.length === 1) {
		from = Math.min(startPositions[0]!, endPositions[0]!);
		to = Math.max(startPositions[0]!, endPositions[0]!);
	} else {
		const candidates: Array<{ from: number; to: number }> = [];
		for (const s of startPositions) {
			for (const e of endPositions) {
				const candFrom = Math.min(s, e);
				const candTo = Math.max(s, e);
				if (candTo - candFrom + 1 !== currentLen) continue;
				let ok = true;
				for (let k = 0; k < currentLen; k++) {
					if (served[candFrom + k] !== fileHashes[startLine - 1 + k]) {
						ok = false;
						break;
					}
				}
				if (ok) candidates.push({ from: candFrom, to: candTo });
			}
		}
		if (candidates.length === 1) {
			from = candidates[0]!.from;
			to = candidates[0]!.to;
		} else if (candidates.length > 1) {
			candidates.sort(
				(a, b) =>
					Math.abs(a.from - (startLine - 1)) - Math.abs(b.from - (startLine - 1)),
			);
			from = candidates[0]!.from;
			to = candidates[0]!.to;
		}
	}
	if (from === undefined || to === undefined) {
		let healed: { from: number; to: number } | undefined;
		if (startPositions.length === 1 && endPositions.length === 1) {
			const sPos = startPositions[0]!;
			const ePos = endPositions[0]!;
			const servedFrom = Math.min(sPos, ePos);
			const servedTo = Math.max(sPos, ePos);
			const servedLen = servedTo - servedFrom + 1;
			if (servedLen === currentLen) {
				const expectedCanons: string[] = [];
				let canBuild = true;
				for (let k = 0; k < servedLen; k++) {
					const h = served[servedFrom + k];
					if (h === null) {
						canBuild = false;
						break;
					}
					const c = getCanonForHash(h);
					if (c === undefined) {
						canBuild = false;
						break;
					}
					expectedCanons.push(c);
				}
				if (canBuild) {
					const matches: number[] = [];
					for (let i = 0; i <= fileLines.length - servedLen; i++) {
						let ok = true;
						for (let k = 0; k < servedLen; k++) {
							if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
								ok = false;
								break;
							}
						}
						if (ok) matches.push(i);
						if (matches.length > 1) break;
					}
					if (matches.length === 1) {
						healed = { from: matches[0]!, to: matches[0]! + servedLen - 1 };
					}
				}
			}
		}
		if (!healed) {
			const hasServed = served.some((h) => h !== null);
			const startInFile = fileHashes.includes(startHash);
			const endInFile = fileHashes.includes(endHash);
			if (hasServed && (!startInFile || !endInFile)) {
				const startCanon = getCanonForHash(startHash);
				const endCanon = getCanonForHash(endHash);
				if (startCanon !== undefined && endCanon !== undefined) {
					const startMatches: number[] = [];
					const endMatches: number[] = [];
					for (let i = 0; i < fileLines.length; i++) {
						if (canon(fileLines[i] ?? "") === startCanon) startMatches.push(i);
						if (canon(fileLines[i] ?? "") === endCanon) endMatches.push(i);
						if (startMatches.length > 1 && endMatches.length > 1) break;
					}
					if (startMatches.length === 1 && endMatches.length === 1) {
						const s = startMatches[0]!;
						const e = endMatches[0]!;
						const healedFrom = Math.min(s, e);
						const healedTo = Math.max(s, e);
						if (healedTo - healedFrom + 1 === currentLen) {
							let interiorOk = true;
							if (currentLen > 2) {
								const healedCanons = [];
								for (let k = 0; k < currentLen; k++)
									healedCanons.push(canon(fileLines[healedFrom + k] ?? ""));
								let count = 0;
								for (let i = 0; i <= fileLines.length - currentLen; i++) {
									let ok = true;
									for (let k = 0; k < currentLen; k++)
										if (canon(fileLines[i + k] ?? "") !== healedCanons[k]) {
											ok = false;
											break;
										}
									if (ok) count++;
									if (count > 1) break;
								}
								if (count !== 1) interiorOk = false;
							}
							if (interiorOk) healed = { from: healedFrom, to: healedTo };
						}
					}
				}
			}
		}
		if (healed) {
			from = healed.from;
			to = healed.to;
			isHealed = true;
		} else {
			const problems: string[] = [];
			if (startPositions.length === 0) {
				problems.push(`remove_from "${startHash}" has no served position`);
			} else if (startPositions.length > 1) {
				problems.push(
					`remove_from "${startHash}" was served at ${startPositions.length} positions`,
				);
			}
			if (endPositions.length === 0) {
				problems.push(`remove_to "${endHash}" has no served position`);
			} else if (endPositions.length > 1) {
				problems.push(
					`remove_to "${endHash}" was served at ${endPositions.length} positions`,
				);
			}
			throw new ServedRejectionError({
				code: "E_RANGE_UNVERIFIED",
				message:
					`[E_RANGE_UNVERIFIED] cannot verify range against served state${where}: ${problems.join("; ")}. ` +
					`No served span matched the current range (${currentLen} lines). ` +
					`A full read will re-sync the served mirror — the echoed range below is current content, ` +
					`but retrying without re-reading cannot clear a stale duplicate outside the echoed window.\n` +
					`Current range:\n${echo}`,
				servedRows: echoRows,
			});
		}
	}

	if (isHealed) {
		for (let k = 0; k < currentLen; k++) {
			const servedHash = served[from + k];
			if (servedHash === null) continue;
			const expectedCanon = getCanonForHash(servedHash);
			const actualCanon = canon(fileLines[from + k] ?? "");
			if (expectedCanon !== undefined && expectedCanon !== actualCanon) {
				const offendingLine = from + k + 1;
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					servedRows: echoRows,
				});
			}
		}
	} else {
		for (let i = from; i <= to; i++) {
			if (served[i] === null) {
				throw new ServedRejectionError({
					code: "E_RANGE_UNSERVED",
					message: `[E_RANGE_UNSERVED] line ${i + 1}${where} was never served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: i + 1,
					servedRows: echoRows,
				});
			}
		}
		const servedLen = to - from + 1;
		if (servedLen !== currentLen) {
			let lenHealed = false;
			const expectedCanons: string[] = [];
			let canBuild = true;
			for (let k = 0; k < servedLen; k++) {
				const h = served[from + k];
				if (h === null) {
					canBuild = false;
					break;
				}
				const c = getCanonForHash(h);
				if (c === undefined) {
					canBuild = false;
					break;
				}
				expectedCanons.push(c);
			}
			if (canBuild) {
				let matches = 0;
				for (let i = 0; i <= fileLines.length - servedLen; i++) {
					let ok = true;
					for (let k = 0; k < servedLen; k++)
						if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
							ok = false;
							break;
						}
					if (ok) matches++;
					if (matches > 1) break;
				}
				if (matches === 1) lenHealed = true;
			}
			if (!lenHealed) {
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: startLine,
					servedRows: echoRows,
				});
			}
		}
		for (let k = 0; k < servedLen; k++) {
			if (served[from + k] !== fileHashes[startLine - 1 + k]) {
				const offendingLine = startLine + k;
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					servedRows: echoRows,
				});
			}
		}
	}
}

export interface ResolvedRange {
	startLine: number;
	endLine: number;
	startHash: string;
	endHash: string;
	delta: number;
}
