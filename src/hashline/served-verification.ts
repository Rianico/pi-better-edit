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
import { HASH_SEP, canon, globalCanonStore, type CanonStore } from "./hash.js";
import { SERVED_ECHO_CAP } from "../constants.js";
import { healSingleCanon } from "./healing/single-canon.js";
import { healBoundaryCanon } from "./healing/boundary.js";
import { healOrphanedSpan } from "./healing/orphan.js";
import { isLengthHealedViaCanon as isLengthHealedViaCanonHelper } from "./healing/helpers.js";

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

function isServedRejection(error: unknown): error is ServedRejectionError {
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

function _isAnchorMismatch(error: unknown): error is AnchorMismatchError {
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

interface VerificationRange {
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
				// SAFETY: ServedRejectionError carries __echo as ad-hoc string attached at throw site; cast reads internal echo validated via rebuild fallback.
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

	// -- private: healing — delegated to internal HealingStrategy adapters -----

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
		return healOrphanedSpan({ ...args, store: this.store });
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
		return healSingleCanon({
			served: args.served,
			currentLen: args.currentLen,
			fileLines: args.fileLines,
			startPositions: args.startPositions,
			endPositions: args.endPositions,
			store: this.store,
		});
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
		return healBoundaryCanon({
			served: args.served,
			startHash: args.startHash,
			endHash: args.endHash,
			currentLen: args.currentLen,
			fileLines: args.fileLines,
			fileHashes: args.fileHashes,
			store: this.store,
		});
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
		return isLengthHealedViaCanonHelper(args.served, args.from, args.servedLen, args.fileLines, this.store);
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
		// SAFETY: augmenting ServedRejectionError with __echo for reject-and-serve; property is string set here and read only via guarded cast in verify().
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
		// SAFETY: attaching __echo string to rejection for echo reconstruction; matches read cast in verify() and is string-typed.
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
		// SAFETY: attaching __echo string to stale rejection; mirrors guarded read in verify() and is validated via echo reconstruction.
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
		// SAFETY: attaching __echo string to unserved rejection; paired with guarded cast and fallback rebuild in verify().
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
