/**
 * ServedVerification — deep module owning all served-range verification.
 *
 * This module absorbs the 280-line healing sprawl previously in served.ts:
 *  - served span resolve (servedPositionsOf + candidate enumeration)
 *  - single-candidate canon scan for orphan healing
 *  - length mismatch and never-served checks
 *  - echo building (buildRangeEcho/fmtServedRows/paginationHint/retryHint)
 *  - E_RANGE_* branching via decision table
 *
 * Canon resolution is instance-scoped via CanonStore (injected), not global.
 * Production uses globalCanonStore; tests inject createCanonStore() for isolation.
 *
 * CONTEXT.md terms preserved: serve, served state, served span, range staleness,
 * never-served, reject-and-serve, drift, orphaned serve, orphaning re-serve,
 * relocated line keeps its hash.
 */
import { HASH_SEP, canon, globalCanonStore, type CanonStore } from "./hash";
import { SERVED_ECHO_CAP } from "../constants";

// ---------------------------------------------------------------------------
// Public contracts — mirrors served.ts so it can re-export without identity split
// ---------------------------------------------------------------------------

export type ServedCode = "E_RANGE_STALE" | "E_RANGE_UNSERVED" | "E_RANGE_UNVERIFIED";

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

export function isServedRejection(error: unknown): error is ServedRejectionError {
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

// ---------------------------------------------------------------------------
// Shared formatting helpers — owned by verification (reject-and-serve contract)
// ---------------------------------------------------------------------------

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
	return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}

function retryHint(): string {
	return "Retry with these anchors (no read needed).";
}

function paginationHint(nextOffset: number, more: number): string {
	return `[... ${more} more — read offset=${nextOffset}]`;
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < served.length; i++) {
		if (served[i] === hash) out.push(i);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Decision-table types
// ---------------------------------------------------------------------------

export interface VerificationRange {
	startHash: string;
	endHash: string;
	startLine: number;
	endLine: number;
}

export interface VerificationInput {
	range: VerificationRange;
	served: (string | null)[];
	fileHashes: string[];
	fileLines: string[];
	filePath?: string;
}

/** Result shape requested in the task: {ok} | {code, servedRows, echo}. */
export type VerificationResult =
	| { ok: true }
	| {
			ok: false;
			code: ServedCode;
			servedRows: ServedRow[];
			echo: string;
			message: string;
			firstOffendingLine?: number;
	  };

// ---------------------------------------------------------------------------
// ServedVerification — the deep module
// ---------------------------------------------------------------------------

export class ServedVerification {
	private readonly store: CanonStore;

	constructor(canonStore?: CanonStore) {
		this.store = canonStore ?? globalCanonStore;
	}

	// -- public: pure result -------------------------------------------------

	verify(input: VerificationInput): VerificationResult {
		try {
			this.verifyOrThrow(input);
			return { ok: true };
		} catch (error) {
			if (isServedRejection(error)) {
				// reconstruct echo from servedRows + fileLines (captured in throw site)
				const echo = (error as unknown as { __echo?: string }).__echo as string | undefined;
				// fallback rebuild if __echo not attached (legacy path)
				const fallbackEcho = this.rebuildEchoForError(input, error);
				return {
					ok: false,
					code: error.code,
					servedRows: error.servedRows,
					echo: echo ?? fallbackEcho,
					message: error.message,
					firstOffendingLine: error.firstOffendingLine,
				};
			}
			throw error;
		}
	}

	// -- public: throwing variant (compat with verifyServedRange) ------------

	verifyOrThrow(input: VerificationInput): void {
		const { range, served, fileHashes, fileLines, filePath } = input;
		const where = filePath ? ` in ${filePath}` : "";
		const { startHash, endHash, startLine, endLine } = range;

		this.ensureCanonsPopulated(fileHashes, fileLines, served);

		const { echoRows, echo } = this.buildEchoBlock(startLine, endLine, fileHashes, fileLines);
		const currentLen = endLine - startLine + 1;

		const span = this.resolveServedSpan({
			served,
			startHash,
			endHash,
			startLine,
			currentLen,
			fileHashes,
		});

		// --- decision table entry 1: no span could be resolved -> E_RANGE_UNVERIFIED (or healed) ---
		let from: number | undefined = span.from;
		let to: number | undefined = span.to;
		let isHealed = false;

		if (from === undefined || to === undefined) {
			const healed = this.tryHealOrphanedSpan({
				served,
				startHash,
				endHash,
				currentLen,
				fileLines,
				fileHashes,
				startLine,
				startPositions: servedPositionsOf(served, startHash),
				endPositions: servedPositionsOf(served, endHash),
			});
			if (healed) {
				from = healed.from;
				to = healed.to;
				isHealed = true;
			} else {
				this.throwUnverified({
					served,
					startHash,
					endHash,
					currentLen,
					echo,
					echoRows,
					where,
					startPositions: servedPositionsOf(served, startHash),
					endPositions: servedPositionsOf(served, endHash),
				});
			}
		}

		// --- decision table entries 2..5: validate resolved span ---
		if (isHealed) {
			this.validateHealedSpan({
				served,
				from: from!,
				currentLen,
				fileLines,
				echo,
				echoRows,
				where,
			});
			return;
		}

		this.validateNonHealedSpan({
			served,
			from: from!,
			to: to!,
			startLine,
			currentLen,
			fileHashes,
			fileLines,
			echo,
			echoRows,
			where,
		});
	}

	// -- private: canon population -------------------------------------------

	private ensureCanonsPopulated(
		fileHashes: string[],
		fileLines: string[],
		served: (string | null)[],
	): void {
		for (let i = 0; i < fileHashes.length; i++) {
			const h = fileHashes[i]!;
			if (this.store.get(h) === undefined) this.store.set(h, canon(fileLines[i] ?? ""));
		}
		for (let i = 0; i < served.length; i++) {
			const h = served[i];
			if (h !== null && this.store.get(h) === undefined) {
				const pos = fileHashes.indexOf(h);
				if (pos >= 0) this.store.set(h, canon(fileLines[pos] ?? ""));
			}
		}
	}

	// -- private: echo --------------------------------------------------------

	private buildEchoBlock(
		startLine: number,
		endLine: number,
		fileHashes: string[],
		fileLines: string[],
	): { echoRows: ServedRow[]; echo: string } {
		const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
		const totalLen = endLine - startLine + 1;
		const tail =
			echoRows.length < totalLen
				? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
				: "";
		const echo = fmtServedRows(echoRows, fileLines) + tail;
		return { echoRows, echo };
	}

	private rebuildEchoForError(input: VerificationInput, error: ServedRejectionError): string {
		const { echo } = this.buildEchoBlock(
			input.range.startLine,
			input.range.endLine,
			input.fileHashes,
			input.fileLines,
		);
		return echo + (error.message.includes(paginationHint(0, 0)) ? "" : "");
	}

	// -- private: span resolve ------------------------------------------------

	private resolveServedSpan(args: {
		served: (string | null)[];
		startHash: string;
		endHash: string;
		startLine: number;
		currentLen: number;
		fileHashes: string[];
	}): { from?: number; to?: number } {
		const { served, startHash, endHash, startLine, currentLen, fileHashes } = args;
		const startPositions = servedPositionsOf(served, startHash);
		const endPositions = servedPositionsOf(served, endHash);

		if (startPositions.length === 1 && endPositions.length === 1) {
			return {
				from: Math.min(startPositions[0]!, endPositions[0]!),
				to: Math.max(startPositions[0]!, endPositions[0]!),
			};
		}

		const candidates = this.enumerateExactCandidates({
			served,
			startPositions,
			endPositions,
			currentLen,
			fileHashes,
			startLine,
		});

		if (candidates.length === 1) return candidates[0]!;
		if (candidates.length > 1) {
			candidates.sort(
				(a, b) =>
					Math.abs(a.from - (startLine - 1)) - Math.abs(b.from - (startLine - 1)),
			);
			return candidates[0]!;
		}
		return {};
	}

	private enumerateExactCandidates(args: {
		served: (string | null)[];
		startPositions: number[];
		endPositions: number[];
		currentLen: number;
		fileHashes: string[];
		startLine: number;
	}): Array<{ from: number; to: number }> {
		const { served, startPositions, endPositions, currentLen, fileHashes, startLine } = args;
		const out: Array<{ from: number; to: number }> = [];
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
				if (ok) out.push({ from: candFrom, to: candTo });
			}
		}
		return out;
	}

	// -- private: healing -----------------------------------------------------

	private tryHealOrphanedSpan(args: {
		served: (string | null)[];
		startHash: string;
		endHash: string;
		currentLen: number;
		fileLines: string[];
		fileHashes: string[];
		startLine: number;
		startPositions: number[];
		endPositions: number[];
	}): { from: number; to: number } | undefined {
		// Strategy 1: single-candidate canon scan for served span as content sequence
		const healed1 = this.trySingleCandidateCanonHeal(args);
		if (healed1) return healed1;
		// Strategy 2: orphaned boundary via canon (hash not in file, but canon is)
		return this.tryBoundaryCanonHeal(args);
	}

	private trySingleCandidateCanonHeal(args: {
		served: (string | null)[];
		startHash: string;
		endHash: string;
		currentLen: number;
		fileLines: string[];
		startPositions: number[];
		endPositions: number[];
	}): { from: number; to: number } | undefined {
		const { served, currentLen, fileLines, startPositions, endPositions } = args;
		if (startPositions.length !== 1 || endPositions.length !== 1) return undefined;
		const sPos = startPositions[0]!;
		const ePos = endPositions[0]!;
		const servedFrom = Math.min(sPos, ePos);
		const servedTo = Math.max(sPos, ePos);
		const servedLen = servedTo - servedFrom + 1;
		if (servedLen !== currentLen) return undefined;

		const expectedCanons: string[] = [];
		for (let k = 0; k < servedLen; k++) {
			const h = served[servedFrom + k];
			if (h === null) return undefined;
			const c = this.store.get(h);
			if (c === undefined) return undefined;
			expectedCanons.push(c);
		}

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
			return { from: matches[0]!, to: matches[0]! + servedLen - 1 };
		}
		return undefined;
	}

	private tryBoundaryCanonHeal(args: {
		served: (string | null)[];
		startHash: string;
		endHash: string;
		currentLen: number;
		fileLines: string[];
		fileHashes: string[];
		startPositions: number[];
		endPositions: number[];
	}): { from: number; to: number } | undefined {
		const { served, startHash, endHash, currentLen, fileLines, fileHashes } = args;
		const hasServed = served.some((h) => h !== null);
		const startInFile = fileHashes.includes(startHash);
		const endInFile = fileHashes.includes(endHash);
		if (!hasServed || (startInFile && endInFile)) return undefined;

		const startCanon = this.store.get(startHash);
		const endCanon = this.store.get(endHash);
		if (startCanon === undefined || endCanon === undefined) return undefined;

		const startMatches: number[] = [];
		const endMatches: number[] = [];
		for (let i = 0; i < fileLines.length; i++) {
			if (canon(fileLines[i] ?? "") === startCanon) startMatches.push(i);
			if (canon(fileLines[i] ?? "") === endCanon) endMatches.push(i);
			if (startMatches.length > 1 && endMatches.length > 1) break;
		}
		if (startMatches.length !== 1 || endMatches.length !== 1) return undefined;

		const s = startMatches[0]!;
		const e = endMatches[0]!;
		const healedFrom = Math.min(s, e);
		const healedTo = Math.max(s, e);
		if (healedTo - healedFrom + 1 !== currentLen) return undefined;

		if (currentLen > 2) {
			const healedCanons: string[] = [];
			for (let k = 0; k < currentLen; k++) healedCanons.push(canon(fileLines[healedFrom + k] ?? ""));
			let count = 0;
			for (let i = 0; i <= fileLines.length - currentLen; i++) {
				let ok = true;
				for (let k = 0; k < currentLen; k++) {
					if (canon(fileLines[i + k] ?? "") !== healedCanons[k]) {
						ok = false;
						break;
					}
				}
				if (ok) count++;
				if (count > 1) break;
			}
			if (count !== 1) return undefined;
		}
		return { from: healedFrom, to: healedTo };
	}

	// -- private: validation via decision table -------------------------------

	private validateHealedSpan(args: {
		served: (string | null)[];
		from: number;
		currentLen: number;
		fileLines: string[];
		echo: string;
		echoRows: ServedRow[];
		where: string;
	}): void {
		const { served, from, currentLen, fileLines, echo, echoRows, where } = args;
		for (let k = 0; k < currentLen; k++) {
			const servedHash = served[from + k];
			if (servedHash === null) continue;
			const expectedCanon = this.store.get(servedHash);
			const actualCanon = canon(fileLines[from + k] ?? "");
			if (expectedCanon !== undefined && expectedCanon !== actualCanon) {
				const offendingLine = from + k + 1;
				this.throwStale({
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					echoRows,
					echo,
				});
			}
		}
	}

	private validateNonHealedSpan(args: {
		served: (string | null)[];
		from: number;
		to: number;
		startLine: number;
		currentLen: number;
		fileHashes: string[];
		fileLines: string[];
		echo: string;
		echoRows: ServedRow[];
		where: string;
	}): void {
		const { served, from, to, startLine, currentLen, fileHashes, fileLines, echo, echoRows, where } = args;

		// Decision: never-served gap inside served span
		for (let i = from; i <= to; i++) {
			if (served[i] === null) {
				this.throwUnserved({
					message: `[E_RANGE_UNSERVED] line ${i + 1}${where} was never served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: i + 1,
					echoRows,
					echo,
				});
			}
		}

		// Decision: length mismatch (served span vs current range)
		const servedLen = to - from + 1;
		if (servedLen !== currentLen) {
			if (!this.isLengthHealedViaCanon({ served, from, servedLen, fileLines })) {
				this.throwStale({
					message: `[E_RANGE_STALE] served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: startLine,
					echoRows,
					echo,
				});
			}
		}

		// Decision: hash mismatch (stale interior)
		for (let k = 0; k < servedLen; k++) {
			if (served[from + k] !== fileHashes[startLine - 1 + k]) {
				const offendingLine = startLine + k;
				this.throwStale({
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					echoRows,
					echo,
				});
			}
		}
	}

	private isLengthHealedViaCanon(args: {
		served: (string | null)[];
		from: number;
		servedLen: number;
		fileLines: string[];
	}): boolean {
		const { served, from, servedLen, fileLines } = args;
		const expectedCanons: string[] = [];
		for (let k = 0; k < servedLen; k++) {
			const h = served[from + k];
			if (h === null) return false;
			const c = this.store.get(h);
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

	// -- private: throws with decision-table mapping -------------------------

	private throwUnverified(args: {
		served: (string | null)[];
		startHash: string;
		endHash: string;
		currentLen: number;
		echo: string;
		echoRows: ServedRow[];
		where: string;
		startPositions: number[];
		endPositions: number[];
	}): never {
		const { startHash, endHash, currentLen, echo, echoRows, where, startPositions, endPositions } = args;
		const problems: string[] = [];
		if (startPositions.length === 0) {
			problems.push(`remove_from "${startHash}" has no served position`);
		} else if (startPositions.length > 1) {
			problems.push(`remove_from "${startHash}" was served at ${startPositions.length} positions`);
		}
		if (endPositions.length === 0) {
			problems.push(`remove_to "${endHash}" has no served position`);
		} else if (endPositions.length > 1) {
			problems.push(`remove_to "${endHash}" was served at ${endPositions.length} positions`);
		}
		const err = new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED] cannot verify range against served state${where}: ${problems.join("; ")}. ` +
				`No served span matched the current range (${currentLen} lines). ` +
				`A full read will re-sync the served mirror — the echoed range below is current content, ` +
				`but retrying without re-reading cannot clear a stale duplicate outside the echoed window.\n` +
				`Current range:\n${echo}`,
			servedRows: echoRows,
		});
		(err as unknown as { __echo: string }).__echo = echo;
		throw err;
	}

	private throwStale(args: {
		message: string;
		firstOffendingLine: number;
		echoRows: ServedRow[];
		echo: string;
	}): never {
		const err = new ServedRejectionError({
			code: "E_RANGE_STALE",
			message: args.message,
			firstOffendingLine: args.firstOffendingLine,
			servedRows: args.echoRows,
		});
		(err as unknown as { __echo: string }).__echo = args.echo;
		throw err;
	}

	private throwUnserved(args: {
		message: string;
		firstOffendingLine: number;
		echoRows: ServedRow[];
		echo: string;
	}): never {
		const err = new ServedRejectionError({
			code: "E_RANGE_UNSERVED",
			message: args.message,
			firstOffendingLine: args.firstOffendingLine,
			servedRows: args.echoRows,
		});
		(err as unknown as { __echo: string }).__echo = args.echo;
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Convenience top-level functions (stateless, global store)
// ---------------------------------------------------------------------------

const defaultVerifier = new ServedVerification();

export function verifyServedRange(args: {
	served: (string | null)[];
	startHash: string;
	endHash: string;
	startLine: number;
	endLine: number;
	fileHashes: string[];
	fileLines: string[];
	filePath?: string;
	canonStore?: CanonStore;
}): void {
	const verifier = args.canonStore ? new ServedVerification(args.canonStore) : defaultVerifier;
	verifier.verifyOrThrow({
		range: {
			startHash: args.startHash,
			endHash: args.endHash,
			startLine: args.startLine,
			endLine: args.endLine,
		},
		served: args.served,
		fileHashes: args.fileHashes,
		fileLines: args.fileLines,
		filePath: args.filePath,
	});
}

/** Pure result variant — does not throw for expected rejections. */
export function verifyServedRangeResult(input: VerificationInput, canonStore?: CanonStore): VerificationResult {
	const verifier = canonStore ? new ServedVerification(canonStore) : defaultVerifier;
	return verifier.verify(input);
}

export interface ResolvedRange {
	startLine: number;
	endLine: number;
	startHash: string;
	endHash: string;
	delta: number;
}
