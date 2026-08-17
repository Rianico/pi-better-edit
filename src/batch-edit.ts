import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import { restoreEndings, type LineEnding } from "./edit-diff";
import { scanDrift } from "./drift";
import { abortIf, isRec, splitLines } from "./utils";
import { resolveTarget, writeAtomic } from "./fs-write";
import { lineHashes, resEdit, type HEdit } from "./hashline";
import { toCwd } from "./paths";
import {
	buildBatchResult,
	type BatchDetails,
	type BatchSection,
} from "./edit-response";
import { loadP, loadGuide } from "./prompts";
import { saveUndo } from "./edit-undo";
import { sessionKeyFor } from "./served-state";
import {
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "./hashline/served";
import { loadHashStore, type HashStore } from "./hash-store";
import { snapshotIOFor } from "./snapshot-store";
import { BATCH_EDIT_MAX_ITEMS } from "./constants";
import {
	assertReq,
	editTupleSchema,
	resolveMissingPath,
	type EditParams,
} from "./edit";
import { normReq } from "./edit-normalize";
import { clearNoopLoop, runNoopPolicy } from "./noop-guard";
import { applyOneEdit, countLineChanges, loadEditFile } from "./edit-pipeline";

type BatchItem = [string | null, [string, string], string];

type CanonicalBatchItem = EditParams;

export type BatchEditParams = BatchItem[] | { batch: BatchItem[] };

type CanonicalBatchEditParams = CanonicalBatchItem[];

type PreparedItem = {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	pathWarning?: string;
};

const batchItemSchema = editTupleSchema;

export const batchEditToolSchema = Type.Object(
	{
		batch: Type.Array(batchItemSchema, {
			description: "Ordered list of edit tuples",
			minItems: 1,
			maxItems: BATCH_EDIT_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

function rawBatchItems(request: unknown): unknown[] {
	if (Array.isArray(request)) return request;
	if (
		isRec(request) &&
		Object.keys(request).length === 1 &&
		Array.isArray(request.batch)
	) {
		return request.batch;
	}
	throw new Error(
		'[E_BAD_SHAPE] batch_edit request must be an object with a "batch" array.',
	);
}

function assertBatchReq(request: unknown): asserts request is BatchEditParams {
	const items = rawBatchItems(request);
	if (items.length === 0) {
		throw new Error(
			"[E_BAD_SHAPE] batch_edit request must not be empty — provide at least one edit.",
		);
	}
	if (items.length > BATCH_EDIT_MAX_ITEMS) {
		throw new Error(
			`[E_BAD_SHAPE] batch_edit accepts at most ${BATCH_EDIT_MAX_ITEMS} edits per call; got ${items.length}. Split the batch into smaller calls.`,
		);
	}
	for (let index = 0; index < items.length; index++) {
		const normalized = normReq(items[index]);
		try {
			assertReq(normalized);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BAD_SHAPE] batch_edit[${index}] ${message.replace(/^\[E_BAD_SHAPE\] /, "")}`,
			);
		}
	}
}

function canonicalizeBatchReq(request: unknown): CanonicalBatchEditParams {
	const items = rawBatchItems(request);
	assertBatchReq(request);
	return items.map((item) => {
		const normalized = normReq(item);
		assertReq(normalized);
		return normalized;
	});
}

async function prepareItems(
	params: CanonicalBatchEditParams,
	cwd: string,
): Promise<PreparedItem[]> {
	const items: PreparedItem[] = [];
	for (let index = 0; index < params.length; index++) {
		const raw = params[index]!;
		const record: Record<string, unknown> = { ...raw };

		let path = typeof record.path === "string" ? record.path : undefined;
		let pathWarning: string | undefined;
		if (!path) {
			let resolution: { path: string; warning: string } | undefined;
			try {
				resolution = await resolveMissingPath(record);
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`batch_edit[${index}]: ${error.message}`);
				}
				throw error;
			}
			if (resolution) {
				path = resolution.path;
				pathWarning = resolution.warning;
			}
		}
		if (!path) {
			throw new Error(
				`[E_BAD_SHAPE] batch_edit[${index}] requires a non-empty path, and its anchors match no known file.`,
			);
		}

		items.push({
			index,
			path,
			absolutePath: await resolveTarget(toCwd(path, cwd)),
			remove_from: record.remove_from as string,
			remove_to: record.remove_to as string,
			replacement_text: record.replacement_text as string,
			pathWarning,
		});
	}
	return items;
}

function groupByPath(items: PreparedItem[]): Map<string, PreparedItem[]> {
	const groups = new Map<string, PreparedItem[]>();
	for (const item of items) {
		const list = groups.get(item.absolutePath);
		if (list) list.push(item);
		else groups.set(item.absolutePath, [item]);
	}
	return groups;
}

function echoRowsForItem(
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

type ProcessedFile = {
	displayPath: string;
	absolutePath: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: LineEnding;
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	originalHashes: string[];
	resultHashes: string[];
	appliedCount: number;
	noopCount: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	driftNotice: string | undefined;
	range: ResolvedRange;
};

async function processFile(
	items: PreparedItem[],
	cwd: string,
	opts: {
		signal?: AbortSignal;
		accessMode: number;
		sessionKey: string;
		store: HashStore;
	},
): Promise<ProcessedFile> {
	const first = items[0]!;
	abortIf(opts.signal);
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
		absolutePath,
		served,
	} = await loadEditFile({
		path: first.path,
		cwd,
		signal: opts.signal,
		accessMode: opts.accessMode,
		sessionKey: opts.sessionKey,
		store: opts.store,
	});
	const warnings: string[] = [];

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
	let lastApplied:
		| { content: string; hashes: string[]; removedHashes: Set<string> }
		| undefined;

	for (const item of items) {
		abortIf(opts.signal);
		let edit: HEdit;
		try {
			edit = resEdit(
				{
					remove_from: item.remove_from,
					remove_to: item.remove_to,
					replacement_text: item.replacement_text,
				},
				warnings,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BATCH_ABORT] batch_edit[${item.index}] (${item.path}) failed: ${message}\n` +
					`The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.`,
			);
		}

		const outcome = await applyOneEdit({
			content: currentContent,
			hashes: currentHashes,
			edit,
			signal: opts.signal,
			filePath: item.path,
			served,
			sessionKey: opts.sessionKey,
			absolutePath,
			store: opts.store,
			persistHashes: false,
			servePolicy: "live",
			onRejected: async (error) => {
				const originalLines = splitLines(originalNormalized);
				const echoRows =
					error.servedRows.length > 0
						? error.servedRows
						: echoRowsForItem(edit, originalHashes);
				const echoBlock = echoRows
					? ` Current on-disk range for batch_edit[${item.index}] (unchanged — nothing was written):\n${fmtServedRows(echoRows, originalLines)}`
					: " Call read() to get fresh anchors.";
				throw new Error(
					`[E_BATCH_ABORT] batch_edit[${item.index}] (${item.path}) failed: ${error.message}${echoBlock}\n` +
						`The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied. Fix the failing edit (and any later edit that depends on it), then resubmit the batch.`,
				);
			},
		});

		const range = outcome.range;
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
			const decision = await runNoopPolicy({
				absolutePath,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				ref: `batch_edit[${item.index}] (${item.path})`,
				batch: true,
				range,
				hashes: currentHashes,
				lines: splitLines(currentContent),
				sessionKey: opts.sessionKey,
			});
			if (decision.action === "reject") throw new Error(decision.message);
			if (decision.action === "warn") warnings.push(decision.notice);
			warnings.push(
				`batch_edit[${item.index}] (${item.path}) was a noop: the range already contains the replacement text.`,
			);
			if (outcome.anchorWarnings?.length) warnings.push(...outcome.anchorWarnings);
			continue;
		}

		appliedCount += 1;
		const { totalAddedLines: added, totalRemovedLines: removed } =
			countLineChanges(
				edit,
				originalHashes,
				false,
				outcome.autoFixes?.length ?? 0,
			);
		totalAddedLines += added;
		totalRemovedLines += removed;
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
			removedHashes: outcome.removedHashes,
		};
		currentContent = outcome.content;
		currentHashes = outcome.hashes;
		clearNoopLoop(absolutePath);
		if (outcome.anchorWarnings?.length) warnings.push(...outcome.anchorWarnings);
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
			snapshotIOFor(opts.store),
			true,
		);
	}

	if (hadUtf8DecodeErrors) {
		warnings.push(
			"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
		);
	}
	if (first.pathWarning) warnings.unshift(first.pathWarning);

	let driftNotice: string | undefined;
	if (appliedCount > 0 && unionStartLine !== Infinity) {
		const resultLines = splitLines(result);
		const originalLines = splitLines(originalNormalized);
		try {
			driftNotice = await scanDrift({
				sessionKey: opts.sessionKey,
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
			console.error("Failed to compute drift notice:", error);
		}
	}

	return {
		displayPath: first.path,
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
		range: {
			startLine: unionStartLine,
			endLine: unionEndLine,
			startHash: unionStartHash,
			endHash: unionEndHash,
			delta: splitLines(result).length - splitLines(originalNormalized).length,
		},
	};
}
function toSection(file: ProcessedFile): BatchSection {
	return {
		path: file.displayPath,
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

async function executeBatch(
	params: CanonicalBatchEditParams,
	cwd: string,
	signal: AbortSignal | undefined,
	ctx: { cwd: string; sessionManager?: { getSessionId(): string } },
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: BatchDetails;
}> {
	const sessionKey = sessionKeyFor(ctx);
	const items = await prepareItems(params, cwd);
	const hashStore = await loadHashStore();
	const groups = groupByPath(items);

	const processed: ProcessedFile[] = [];
	for (const groupItems of groups.values()) {
		abortIf(signal);
		processed.push(
			await processFile(groupItems, cwd, {
				signal,
				accessMode: constants.R_OK | constants.W_OK,
				sessionKey,
				store: hashStore,
			}),
		);
	}

	const undos: Array<{ file: ProcessedFile; restore: () => Promise<void> }> = [];
	for (const file of processed) {
		if (file.appliedCount === 0) continue;
		const undo = await saveUndo(file.absolutePath, {
			content: file.originalNormalized,
			bom: file.bom,
			originalEnding: file.originalEnding,
			hashes: file.originalHashes,
			resultContent: file.result,
		});
		if (!undo.persisted) {
			for (const u of undos) {
				try {
					await u.restore();
				} catch (error) {
					console.error("Failed to restore undo entry after batch abort:", error);
				}
			}
			throw new Error(
				`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the batch was NOT applied and no file was written. Retry the batch, or use write if the store cannot be recovered.`,
			);
		}
		undos.push({ file, restore: undo.restore });
	}

	const written: Array<{ file: ProcessedFile; restore: () => Promise<void> }> =
		[];
	try {
		for (const u of undos) {
			abortIf(signal);
			await withFileMutationQueue(u.file.absolutePath, async () => {
				await writeAtomic(
					u.file.absolutePath,
					u.file.bom + restoreEndings(u.file.result, u.file.originalEnding),
				);
			});
			written.push(u);
		}
	} catch (error) {
		for (const w of written) {
			try {
				await withFileMutationQueue(w.file.absolutePath, async () => {
					await writeAtomic(
						w.file.absolutePath,
						w.file.bom +
							restoreEndings(w.file.originalNormalized, w.file.originalEnding),
					);
				});
			} catch (restoreError) {
				console.error(
					"Failed to restore file after batch write failure:",
					restoreError,
				);
			}
			try {
				await w.restore();
			} catch (restoreError) {
				console.error(
					"Failed to restore undo entry after batch write failure:",
					restoreError,
				);
			}
		}
		throw error;
	}

	return buildBatchResult(processed.map(toSection));
}

export function buildBatchToolDef(): ToolDefinition<any, BatchDetails, any> {
	return {
		name: "batch_edit",
		label: "Batch Edit",
		description: loadP("../prompts/batch-edit.md"),
		parameters: batchEditToolSchema,
		promptSnippet: loadP("../prompts/batch-edit-snippet.md"),
		promptGuidelines: loadGuide("../prompts/batch-edit-guidelines.md"),
		prepareArguments: (args: unknown) =>
			Array.isArray(args) ? { batch: args } : (args as any),
		renderShell: "default",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeBatch(canonicalizeBatchReq(params), ctx.cwd, signal, ctx);
		},
	};
}

export function regBatchEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildBatchToolDef());
}
