/**
 * EditPipeline — Strong, in-process atomic mutation seam.
 *
 * Deepened pipeline that hoists the whole edit mutation behind one
 * seam: load → parse → mutate loop → finalize hashes → drift → persist.
 *
 * Phase diagram (ordering is load-bearing — do not reorder without
 * updating drift/undo/serve invariants):
 *
 *   ┌─────────────┐     ┌────────┐     ┌──────────────────┐
 *   │ Admission   │────▶│  Load  │────▶│ Parse & Validate │
 *   │ (edit.ts)   │     │ (IO)   │     │ (resEdit)        │
 *   │ TypeBox +   │     │readNorm│     │ warnings local   │
 *   │ assertReq   │     │+served │     │ no servePolicy    │
 *   └─────────────┘     └───┬────┘     └────────┬─────────┘
 *                           │                   │
 *                   ┌───────▼───────────────────▼───────┐
 *                   │          Mutate Loop              │
 *                   │  for each HEdit:                  │
 *                   │   applyEdit → verifyServedRange   │
 *                   │   ├─ reject: recordEchoServes+    │
 *                   │   │         batch-abort           │
 *                   │   ├─ noop:  runNoopPolicy         │
 *                   │   └─ applied: lineHashes +        │
 *                   │             track intervals        │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │        Finalize                    │
 *                   │  dense lineHashes (if applied)    │
 *                   │  hadUtf8 warning                  │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │         Drift                     │
 *                   │  scanDrift over edited intervals  │
 *                   │  union gap caveat: disjoint batch │
 *                   │  edits use union [minStart,       │
 *                   │  maxEnd]; gap lines are treated   │
 *                   │  as edited (not drift). For       │
 *                   │  accurate gap-drift use single-   │
 *                   │  edit calls (documented norm).    │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │        Persist (live only)        │
 *                   │  saveUndo → writeAtomic           │
 *                   │  on write failure: restore undo   │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │         Serve (live only)         │
 *                   │  recordDiffServes (dense)         │
 *                   │  echo serves already recorded on  │
 *                   │  reject path                      │
 *                   └───────────────────────────────────┘
 *
 * Atomic guarantee: if any mutate step throws (anchor/served/noop-loop)
 * persist is skipped and the file is unchanged. Warnings are owned
 * locally — not passed by ref across modules. servePolicy string is
 * internal (live vs preview) and not exposed.
 *
 * Drift union gap bug: previously unionStartLine/unionEndLine
 * synthesized in edit.ts as [minStart, maxEnd] and fed as a single
 * ResolvedRange to drift. For disjoint batch edits this hides the
 * gap (e.g., edits at lines 2 and 10 → union 2..10 excludes lines
 * 3..9 from drift). Fix: pipeline tracks per-edit ResolvedRange[]
 * (editedIntervals). Drift is documented as single-edit norm —
 * batch drift uses union and gaps are not reported as drift; a
 * warning is emitted when disjoint intervals are detected. A
 * per-interval drift (drift per-edit) would require mapping each
 * drifted line against any interval served span and per-position
 * delta (not just total delta); that is left as future work.
 *
 * Vocabulary (CONTEXT.md): range, span, served span, drift, drift
 * notice, reject-and-serve, payload contract — preserved.
 */

import { constants } from "node:fs";
import type { LineEnding } from "../edit-diff.js";
import { genDiff, restoreEndings } from "../edit-diff.js";
import { readNormFile } from "../file-reader.js";
import { abortIf, splitLines, visLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import { loadHashStore } from "../hash-store.js";
import { snapshotIOFor } from "../snapshot-store.js";
import {
	applyEdit,
	MAX_HASH_LINES,
	resEdit,
	type HEdit,
	type NEdit,
} from "../hashline/index.js";
import { defaultHashIdentity, lineHashes } from "../hashline/hash-identity.js";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "../hashline/served.js";
import {
	loadServed,
	recordEchoServes,
	recordDiffServes,
	sessionKeyFor,
} from "../served-state.js";
import { scanDrift } from "../drift.js";
import { createSessionHandle } from "../served-session/session.js";
import { fileSnap } from "../file-reader.js";
import { clearNoopLoop, runNoopPolicy } from "../noop-guard.js";
import { saveUndo } from "../edit-undo.js";
import { resolveTarget, writeAtomic } from "../fs-write.js";
import { toCwd } from "../paths.js";
import type { NormalizedEditRequest } from "../edit-normalize.js";
import { buildBatchResult, type BatchSection } from "../edit-response.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

function collectRemovedHashes(
	edit: HEdit,
	originalHashes: string[],
): Set<string> {
	const removedHashes = new Set<string>();
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const startLine = originalHashes.indexOf(startHash);
	const endLine = originalHashes.indexOf(endHash);
	if (startLine >= 0 && endLine >= 0) {
		const firstLine = Math.min(startLine, endLine);
		const lastLine = Math.max(startLine, endLine);
		for (let i = firstLine; i <= lastLine; i++) {
			removedHashes.add(originalHashes[i]!);
		}
	}
	return removedHashes;
}

function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
	let totalRemovedLines = 0;
	const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
	const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1;
	}
	return {
		totalAddedLines: isNoop ? 0 : edit.content_lines.length,
		totalRemovedLines,
	};
}

function echoRowsForEdit(
	edit: HEdit,
	originalHashes: string[],
): ServedRow[] | undefined {
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const s = originalHashes.indexOf(startHash);
	const e = originalHashes.indexOf(endHash);
	if (s < 0 || e < 0) return undefined;
	return buildRangeEcho(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

interface EditFileSource {
	path: string;
	cwd: string;
	signal?: AbortSignal;
	accessMode?: number;
	sessionKey: string;
	store?: HashStore;
	noPersist?: boolean;
}

interface LoadedEditFile {
	normalized: string;
	bom: string;
	originalEnding: LineEnding;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
	absolutePath: string;
	served: (string | null)[];
	tombstone: ReadonlySet<string>;
	servedCanons: (string | null)[];
	epochSnapshotId: string | undefined;
	curSnapshotId: string | undefined;
}

async function loadEditFile(source: EditFileSource): Promise<LoadedEditFile> {
	const {
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors,
		absolutePath,
	} = await readNormFile(source.path, source.cwd, {
		signal: source.signal,
		accessMode: source.accessMode,
		maxLines: MAX_HASH_LINES,
		store: source.store,
		noPersist: source.noPersist,
	});
	const served = await loadServed(source.sessionKey, absolutePath);
	let tombstone: ReadonlySet<string> = new Set();
	let servedCanons: (string | null)[] = [];
	let epochSnapshotId: string | undefined;
	let curSnapshotId: string | undefined;
	try {
		const handle = createSessionHandle(source.sessionKey, absolutePath, source.store);
		// SAFETY: handle typed as unknown for optional getTombstone check — method may be loadTombstone, fallback to empty set preserves batch atomicity
const anyHandle = handle as unknown as { getTombstone?: () => Promise<Set<string>>; getCanons?: () => Promise<(string | null)[]>; getEpochSnapshotId?: () => Promise<string | undefined> };
		if (anyHandle.getTombstone) tombstone = await anyHandle.getTombstone();
		if (anyHandle.getCanons) servedCanons = await anyHandle.getCanons();
		if (anyHandle.getEpochSnapshotId) epochSnapshotId = await anyHandle.getEpochSnapshotId();
	} catch {}
	try {
		curSnapshotId = (await fileSnap(absolutePath)).snapshotId;
	} catch {}
	return {
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors,
		absolutePath,
		served,
		tombstone,
		servedCanons,
		epochSnapshotId,
		curSnapshotId,
	};
}

interface ApplyOneEditInput {
	content: string;
	hashes: string[];
	edit: HEdit;
	signal?: AbortSignal;
	filePath: string;
	served: (string | null)[];
	tombstone?: ReadonlySet<string>;
	servedCanons?: (string | null)[];
	epochSnapshotId?: string;
	curSnapshotId?: string;
	sessionKey: string;
	absolutePath: string;
	store: HashStore;
	persistHashes: boolean;
	isPreview: boolean;
	onRejected: (
		error: AnchorMismatchError | ServedRejectionError,
	) => Promise<never>;
}

type ApplyOneEditOutcome =
	| {
			kind: "applied";
			content: string;
			hashes: string[];
			removedHashes: Set<string>;
			range: ResolvedRange;
			firstChangedLine: number | undefined;
			lastChangedLine: number | undefined;
			anchorWarnings: string[] | undefined;
	  }
	| {
			kind: "noop";
			range: ResolvedRange;
			noopEdit: NEdit | undefined;
			anchorWarnings: string[] | undefined;
	  };

async function applyOneEdit(
	input: ApplyOneEditInput,
): Promise<ApplyOneEditOutcome> {
	abortIf(input.signal);

	let anchorResult: ReturnType<typeof applyEdit>;
	try {
		anchorResult = applyEdit(
			input.content,
			input.edit,
			input.signal,
			input.hashes,
			input.filePath,
			input.served,
			input.tombstone,
			input.servedCanons,
			input.epochSnapshotId,
			input.curSnapshotId,
		);
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError
		) {
			if (!input.isPreview) {
				await recordEchoServes(
					input.sessionKey,
					input.absolutePath,
					error.servedRows,
					"live",
					input.hashes.length,
				);
			} else {
				await recordEchoServes(
					input.sessionKey,
					input.absolutePath,
					error.servedRows,
					"preview",
					input.hashes.length,
				);
			}
			return input.onRejected(error);
		}
		throw error;
	}

	const anchorWarnings = anchorResult.warnings;
	const nextContent = anchorResult.content;
	if (nextContent === input.content) {
		return {
			kind: "noop",
			range: anchorResult.range,
			noopEdit: anchorResult.noopEdit,
			anchorWarnings,
		};
	}

	if (!input.hashes || input.hashes.length === 0)
		throw new Error(
			"[E_STALE_ANCHOR] missing previous hashes for stable anchoring",
		);
	const removedHashes = collectRemovedHashes(input.edit, input.hashes);
	const nextHashes = await defaultHashIdentity.hashesFor(nextContent, {
		path: input.absolutePath,
		prior: { content: input.content, hashes: input.hashes, removedHashes },
		persist: input.persistHashes,
		snapshotIO: snapshotIOFor(input.store),
		// SAFETY: tombstone passed as ReadonlySet via unknown for HashIdentity compatibility — input.tombstone is already typed, cast preserves immutability
tombstone: input.tombstone as unknown as ReadonlySet<string> | undefined,
	} as unknown as Parameters<typeof defaultHashIdentity.hashesFor>[1]);
	return {
		kind: "applied",
		content: nextContent,
		hashes: nextHashes,
		removedHashes,
		range: anchorResult.range,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		anchorWarnings,
	};
}

import type { PipelineOptions, ProcessedEditFile } from "./types.js";
export type { PipelineOptions, ProcessedEditFile };

function parseEdits(
	items: NormalizedEditRequest["edits"],
	path: string,
	warnings: string[],
): HEdit[] {
	const parsed: HEdit[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		try {
			parsed.push(
				resEdit(
					{
						remove_from: item.remove_from,
						remove_to: item.remove_to,
						replacement_text: item.replacement_text,
					},
					warnings,
				),
			);
		} catch (error) {
			if (items.length === 1) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BATCH_ABORT] edit[${index}] (${path}) failed: ${message}\nThe whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.`,
			);
		}
	}
	return parsed;
}
async function runMutations(
	request: NormalizedEditRequest,
	cwd: string,
	options?: PipelineOptions,
): Promise<ProcessedEditFile> {
	if (request.path === null) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request path could not be inferred from anchors.",
		);
	}
	const path = request.path;
	const items = request.edits;
	const hashStore = options?.store ?? (await loadHashStore());
	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined);
	const warnings: string[] = [];
	abortIf(options?.signal);

	const isPreview = options?.noPersist === true;

	const parsed = parseEdits(items, path, warnings);

	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
		absolutePath,
		served,
	} = await loadEditFile({
		path,
		cwd,
		signal: options?.signal,
		accessMode: options?.accessMode,
		sessionKey,
		store: hashStore,
		noPersist: options?.noPersist,
	});

	let currentContent = originalNormalized;
	let currentHashes = originalHashes;
	let appliedCount = 0;
	let noopCount = 0;
	let totalAddedLines = 0;
	let totalRemovedLines = 0;
	let unionStartLine = Infinity;
	let unionEndLine = -Infinity;
	let unionStartHash = "";
	let unionEndHash = "";
	const editedIntervals: ResolvedRange[] = [];
	let lastApplied:
		| { content: string; hashes: string[]; removedHashes: Set<string> }
		| undefined;

	for (let index = 0; index < items.length; index++) {
		abortIf(options?.signal);
		const item = items[index]!;
		const edit = parsed[index]!;

		const outcome = await applyOneEdit({
			content: currentContent,
			hashes: currentHashes,
			edit,
			signal: options?.signal,
			filePath: path,
			served,
			// SAFETY: dynamic import per-iteration to fetch fresh tombstone after previous edit's retire — handle may not have getTombstone, fallback empty preserves correctness
tombstone: (await (async () => { try { const h = (await import("../served-session/session.js")).createSessionHandle(sessionKey, absolutePath, hashStore) as unknown as { getTombstone?: () => Promise<Set<string>> }; return h.getTombstone ? await h.getTombstone() : new Set<string>(); } catch { return new Set<string>(); } })()) as ReadonlySet<string>,
			servedCanons: (await (async () => { try { const h = (await import("../served-session/session.js")).createSessionHandle(sessionKey, absolutePath, hashStore) as unknown as { getCanons?: () => Promise<(string|null)[]> }; return h.getCanons ? await h.getCanons() : []; } catch { return []; } })()),
			epochSnapshotId: (await (async () => { try { const h = (await import("../served-session/session.js")).createSessionHandle(sessionKey, absolutePath, hashStore) as unknown as { getEpochSnapshotId?: () => Promise<string|undefined> }; return h.getEpochSnapshotId ? await h.getEpochSnapshotId() : undefined; } catch { return undefined; } })()),
			curSnapshotId: (await (async () => { try { return (await fileSnap(absolutePath)).snapshotId; } catch { return undefined; } })()),
			sessionKey,
			absolutePath,
			store: hashStore,
			persistHashes: !isPreview,
			isPreview,
			onRejected: async (error) => {
				if (items.length === 1) throw error;
				const originalLines = splitLines(originalNormalized);
				const echoRows =
					error.servedRows.length > 0
						? error.servedRows
						: echoRowsForEdit(edit, originalHashes);
				const echoBlock = echoRows
					? ` Current on-disk range for edit[${index}] (unchanged — nothing was written):\n${fmtServedRows(echoRows, originalLines)}`
					: " Call read() to get fresh anchors.";
				throw new Error(
					`[E_BATCH_ABORT] edit[${index}] (${path}) failed: ${error.message}${echoBlock}\n` +
						`The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied. Fix the failing edit (and any later edit that depends on it), then resubmit.`,
				);
			},
		});

		const range = outcome.range;
		editedIntervals.push(range);
		if (range.startLine < unionStartLine) {
			unionStartLine = range.startLine;
			unionStartHash = range.startHash;
		}
		if (range.endLine > unionEndLine) {
			unionEndLine = range.endLine;
			unionEndHash = range.endHash;
		}

		if (outcome.kind === "noop") {
			noopCount += 1;
			if (isPreview) {
				if (outcome.anchorWarnings?.length) {
					warnings.push(...outcome.anchorWarnings);
				}
				continue;
			}
			const decision = await runNoopPolicy({
				absolutePath,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				ref: `edit[${index}] (${path})`,
				batch: true,
				range,
				hashes: currentHashes,
				lines: splitLines(currentContent),
				sessionKey,
			});
			if (decision.action === "reject") throw new Error(decision.message);
			if (decision.action === "warn") warnings.push(decision.notice);
			if (items.length > 1) {
				warnings.push(
					`edit[${index}] (${path}) was a noop: the range already contains the replacement text.`,
				);
			}
			if (outcome.anchorWarnings?.length) {
				warnings.push(...outcome.anchorWarnings);
			}
			continue;
		}
		appliedCount += 1;
		const { totalAddedLines: added, totalRemovedLines: removed } =
			countLineChanges(edit, originalHashes, false);
		totalAddedLines += added;
		totalRemovedLines += removed;
		if (!isPreview) {
			try {
				// SAFETY: dynamic import for retireAnchors — handle may have retire vs retireAnchors, check existence before calling to avoid throwing in preview mode
const handle = (await import("../served-session/session.js")).createSessionHandle(sessionKey, absolutePath, hashStore) as unknown as { retireAnchors?: (hashes: Iterable<string>) => Promise<void> };
				if (handle.retireAnchors) await handle.retireAnchors(outcome.removedHashes);
			} catch {}
		}
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
			removedHashes: outcome.removedHashes,
		};
		currentContent = outcome.content;
		currentHashes = outcome.hashes;
		if (!isPreview) clearNoopLoop(absolutePath);
		if (outcome.anchorWarnings?.length) {
			warnings.push(...outcome.anchorWarnings);
		}
	}

	const result = currentContent;
	let resultHashes = currentHashes;
	if (appliedCount > 0 && lastApplied) {
		resultHashes = await lineHashes(
			result,
			absolutePath,
			{
				content: lastApplied.content,
				hashes: lastApplied.hashes,
				removedHashes: lastApplied.removedHashes,
			},
			snapshotIOFor(hashStore),
			!isPreview,
		);
	}

	if (hadUtf8DecodeErrors) {
		warnings.push(
			"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
		);
	}

	let driftNotice: string | undefined;
	if (!isPreview && unionStartLine !== Infinity) {
		const sorted = [...editedIntervals].sort((a, b) => a.startLine - b.startLine);
		let hasGap = false;
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i]!.startLine > sorted[i - 1]!.endLine + 1) {
				hasGap = true;
				break;
			}
		}
		if (hasGap && editedIntervals.length > 1) {
			// User-facing signal: Batch drift note stays in details.warnings, filtered from model content (see ADR-0010).
			warnings.push(
				`Batch drift note: edits are disjoint — drift inside the gap between edited intervals is not reported. For accurate gap drift, use sequential single-edit calls.`,
			);
		}
		const resultLines = splitLines(result);
		const originalLines = splitLines(originalNormalized);
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes,
				resultLines,
				range: {
					startLine: unionStartLine,
					endLine: unionEndLine,
					startHash: unionStartHash,
					endHash: unionEndHash,
					delta: resultLines.length - originalLines.length,
				},
				path: absolutePath,
			});
		} catch (error) {
			// SAFETY: best-effort drift notice — scanDrift failure is informational; edit already succeeded and driftNotice is optional, swallowing preserves tool success.
			console.error("Failed to compute drift notice:", error);
		}
	}

	const unionRange: ResolvedRange = {
		startLine: unionStartLine === Infinity ? 1 : unionStartLine,
		endLine: unionEndLine === -Infinity ? 1 : unionEndLine,
		startHash: unionStartHash,
		endHash: unionEndHash,
		delta: splitLines(result).length - splitLines(originalNormalized).length,
	};

	return {
		path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		originalHashes,
		resultHashes,
		appliedCount,
		noopCount,
		totalAddedLines,
		totalRemovedLines,
		driftNotice,
		range: unionRange,
		editedIntervals,
	};
}

function toSection(file: ProcessedEditFile): BatchSection {
	return {
		path: file.path,
		originalNormalized: file.originalNormalized,
		result: file.result,
		originalHashes: file.originalHashes,
		resultHashes: file.resultHashes,
		warnings: file.warnings,
		driftNotice: file.driftNotice,
		appliedCount: file.appliedCount,
		noopCount: file.noopCount,
		totalAddedLines: file.totalAddedLines,
		totalRemovedLines: file.totalRemovedLines,
	};
}

export async function previewEdits(
	request: NormalizedEditRequest,
	cwd: string,
	options?: Omit<PipelineOptions, "noPersist">,
) {
	return runMutations(request, cwd, { ...options, noPersist: true });
}

export async function apply(
	request: NormalizedEditRequest,
	cwd: string,
	options?: PipelineOptions,
): Promise<{
	result: string;
	diff: string;
	drift: string | undefined;
	metrics: ReturnType<typeof buildBatchResult>["details"]["metrics"];
	raw: ProcessedEditFile;
	toolResult: ReturnType<typeof buildBatchResult>;
}> {
	const isPreview = options?.noPersist === true;
	if (isPreview) {
		const file = await runMutations(request, cwd, options);
		const toolResult = buildBatchResult([toSection(file)]);
		const diff = toolResult.details.diff ?? "";
		return {
			result: file.result,
			diff,
			drift: file.driftNotice,
			metrics: toolResult.details.metrics,
			raw: file,
			toolResult,
		};
	}

	const path = request.path;
	if (path === null) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request path could not be inferred from anchors.",
		);
	}
	const absolutePath = toCwd(path, cwd);
	const mutationTargetPath = await resolveTarget(absolutePath);
	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined);

	return withFileMutationQueue(mutationTargetPath, async () => {
		abortIf(options?.signal);

		const file = await runMutations(request, cwd, {
			...options,
			sessionKey,
			accessMode: options?.accessMode ?? constants.R_OK | constants.W_OK,
		});

		if (file.appliedCount === 0) {
			const toolResult = buildBatchResult([toSection(file)]);
			return {
				result: file.result,
				diff: "",
				drift: file.driftNotice,
				metrics: toolResult.details.metrics,
				raw: file,
				toolResult,
			};
		}

		abortIf(options?.signal);
		const undo = await saveUndo(mutationTargetPath, {
			content: file.originalNormalized,
			bom: file.bom,
			originalEnding: file.originalEnding,
			hashes: file.originalHashes,
			resultContent: file.result,
		});
		if (!undo.persisted) {
			throw new Error(
				`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
			);
		}
		try {
			abortIf(options?.signal);
			await writeAtomic(
				file.absolutePath,
				file.bom + restoreEndings(file.result, file.originalEnding),
			);
		} catch (error) {
			await undo.restore();
			throw error;
		}

		try {
			const resultLineCount = visLines(file.result).length;

			const diffInfo = genDiff(
				file.originalNormalized,
				file.result,
				1,
				file.resultHashes,
				file.originalHashes,
			);
			const denseRows: ServedRow[] = [];
			for (let i = 0; i < file.resultHashes.length; i++) {
				denseRows.push({ position: i, hash: file.resultHashes[i]! });
			}
			if (denseRows.length > 0) {
				await recordDiffServes({
					sessionKey,
					path: file.absolutePath,
					servedRows: denseRows,
					resultLineCount,
					firstChangedLine: diffInfo.firstChangedLine,
				});
			}
		} catch (error) {
			// SAFETY: best-effort serve recording — dense serve failures after successful write are ignored; file is already persisted and tool result is valid, next read will re-establish serves.
			console.error("Failed to record dense serves after write:", error);
		}

		const toolResult = buildBatchResult([toSection(file)]);
		return {
			result: file.result,
			diff: toolResult.details.diff ?? "",
			drift: file.driftNotice,
			metrics: toolResult.details.metrics,
			raw: file,
			toolResult,
		};
	});
}

export async function execEdits(
	request: NormalizedEditRequest,
	cwd: string,
	options?: PipelineOptions,
): Promise<ProcessedEditFile> {
	return runMutations(request, cwd, options);
}

// _collectRemovedHashesInternal removed
// _countLineChangesInternal removed
