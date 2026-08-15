import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import { restoreEndings, type LineEnding } from "./edit-diff";
import { readNormFile } from "./file-reader";
import { scanDrift } from "./drift";
import {
	abortIf,
	isRec,
	normalizeFilePath,
	rejectUnknownFields,
	splitLines,
} from "./utils";
import { resolveTarget, writeAtomic } from "./fs-write";
import {
	applyEdit,
	lineHashes,
	resEdit,
	MAX_HASH_LINES,
	type HEdit,
} from "./hashline";
import { toCwd } from "./paths";
import {
	buildBatchResult,
	type BatchDetails,
	type BatchSection,
} from "./edit-response";
import { loadP, loadGuide } from "./prompts";
import { saveUndo } from "./edit-undo";
import { loadServed, recordEchoServes, sessionKeyFor } from "./served-state";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "./hashline/served";
import { loadHashStore, type HashStore } from "./hash-store";
import { snapshotIOFor } from "./snapshot-store";
import { BATCH_EDIT_MAX_ITEMS, NOOP_LOOP_THRESHOLD } from "./constants";
import {
	collectRemovedHashes,
	countLineChanges,
	removeFromSchema,
	removeToSchema,
	replacementTextSchema,
	resolveMissingPath,
} from "./edit";
import { clearNoopLoop, noopPayloadKey, trackNoopPayload } from "./noop-guard";

type BatchItem = {
	path?: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type BatchEditParams = {
	edits: BatchItem[];
};

type PreparedItem = {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	pathWarning?: string;
};

const BATCH_ITEM_KS = new Set([
	"path",
	"remove_from",
	"remove_to",
	"replacement_text",
]);

const batchItemSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					"Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors when they uniquely identify a file in the hash store.",
			}),
		),
		remove_from: removeFromSchema,
		remove_to: removeToSchema,
		replacement_text: replacementTextSchema,
	},
	{ additionalProperties: false },
);

export const batchEditToolSchema = Type.Object(
	{
		edits: Type.Array(batchItemSchema, {
			description:
				`Ordered list of edits, each with the same shape as the edit tool: { path?, remove_from, remove_to, replacement_text }. ` +
				`Edits to the same file are applied in order and verified against what was served before anything is written. ` +
				`The batch is all-or-nothing: if any edit fails validation, nothing is written and the failing edit's current range is served back. ` +
				`Use batch_edit when you have multiple edits; do not issue several edit calls in one message.`,
			minItems: 1,
			maxItems: BATCH_EDIT_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

function assertBatchReq(request: unknown): asserts request is BatchEditParams {
	if (!isRec(request)) {
		throw new Error(
			'[E_BAD_SHAPE] batch_edit request must be an object with an "edits" array.',
		);
	}
	rejectUnknownFields(
		request,
		new Set(["edits"]),
		"batch_edit request",
		"The request takes only { edits: [...] }.",
	);
	const edits = request.edits;
	if (!Array.isArray(edits)) {
		throw new Error('[E_BAD_SHAPE] "edits" must be an array of edit items.');
	}
	if (edits.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] "edits" must not be empty — provide at least one edit.',
		);
	}
	if (edits.length > BATCH_EDIT_MAX_ITEMS) {
		throw new Error(
			`[E_BAD_SHAPE] batch_edit accepts at most ${BATCH_EDIT_MAX_ITEMS} edits per call; got ${edits.length}. Split the batch into smaller calls.`,
		);
	}
	edits.forEach((item, index) => {
		if (!isRec(item)) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] must be an object with { path?, remove_from, remove_to, replacement_text }.`,
			);
		}
		rejectUnknownFields(
			item,
			BATCH_ITEM_KS,
			`edits[${index}]`,
			"Each item takes only { path, remove_from, remove_to, replacement_text }.",
		);
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] requires "remove_from", "remove_to", and "replacement_text" strings.`,
			);
		}
		if (
			item.path !== undefined &&
			(typeof item.path !== "string" || item.path.length === 0)
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].path must be a non-empty string.`,
			);
		}
	});
}

async function prepareItems(
	params: BatchEditParams,
	cwd: string,
): Promise<PreparedItem[]> {
	const items: PreparedItem[] = [];
	for (let index = 0; index < params.edits.length; index++) {
		const raw = params.edits[index]!;
		const record: Record<string, unknown> = { ...raw };
		normalizeFilePath(record);

		let path = typeof record.path === "string" ? record.path : undefined;
		let pathWarning: string | undefined;
		if (!path) {
			let resolution: { path: string; warning: string } | undefined;
			try {
				resolution = await resolveMissingPath(record);
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`edits[${index}]: ${error.message}`);
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
				`[E_BAD_SHAPE] edits[${index}] requires a non-empty "path" string, and its anchors match no known file.`,
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
	opts: { signal?: AbortSignal; accessMode: number; sessionKey: string; store: HashStore },
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
	} = await readNormFile(first.path, cwd, {
		signal: opts.signal,
		accessMode: opts.accessMode,
		maxLines: MAX_HASH_LINES,
	});

	const served = await loadServed(opts.sessionKey, absolutePath);
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
				`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${message}\n` +
					`The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.`,
			);
		}

		let anchorResult: ReturnType<typeof applyEdit>;
		try {
			anchorResult = applyEdit(
				currentContent,
				edit,
				opts.signal,
				currentHashes,
				item.path,
				served,
			);
		} catch (error) {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				const originalLines = splitLines(originalNormalized);
				const echoRows =
					error.servedRows.length > 0
						? error.servedRows
						: echoRowsForItem(edit, originalHashes);
				if (echoRows) {
					await recordEchoServes(
						opts.sessionKey,
						absolutePath,
						echoRows,
						"live",
					);
				}
				const echoBlock = echoRows
					? ` Current on-disk range for edits[${item.index}] (unchanged — nothing was written):\n${fmtServedRows(echoRows, originalLines)}`
					: " Call read() to get fresh anchors.";
				throw new Error(
					`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${error.message}${echoBlock}\n` +
						`The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied. Fix the failing edit (and any later edit that depends on it), then resubmit the batch.`,
				);
			}
			throw error;
		}

		const nextContent = anchorResult.content;
		const isNoop = nextContent === currentContent;
		const range = anchorResult.range;
		if (range.startLine < unionStartLine) {
			unionStartLine = range.startLine;
			unionStartHash = range.startHash;
		}
		if (range.endLine > unionEndLine) {
			unionEndLine = range.endLine;
			unionEndHash = range.endHash;
		}

		if (isNoop) {
			noopCount += 1;
			const payload = noopPayloadKey(
				absolutePath,
				item.remove_from,
				item.remove_to,
				item.replacement_text,
			);
			const count = trackNoopPayload(absolutePath, payload);
			if (count >= NOOP_LOOP_THRESHOLD) {
				const originalLines = splitLines(originalNormalized);
				const echoRows = echoRowsForItem(edit, originalHashes);
				if (echoRows) {
					await recordEchoServes(
						opts.sessionKey,
						absolutePath,
						echoRows,
						"live",
					);
				}
				throw new Error(
					`[E_NOOP_LOOP] edits[${item.index}] (${item.path}): this exact edit (anchors ${item.remove_from} to ${item.remove_to}) has been submitted ${count} times and produced no changes each time — the range already contains the replacement text. Do not resend it; it will never change the file. The whole batch was rejected and nothing was written.` +
						(echoRows
							? ` Current on-disk range:\n${fmtServedRows(echoRows, originalLines)}`
							: ""),
				);
			}
			if (count === 2) {
				warnings.push(
					`[E_NOOP_LOOP] Notice: edits[${item.index}] (${item.path}) — this exact edit has produced no changes twice in a row; the range already contains the replacement text. Resending it again will reject the batch.`,
				);
			}
			warnings.push(
				`edits[${item.index}] (${item.path}) was a noop: the range already contains the replacement text.`,
			);
			if (anchorResult.warnings?.length)
				warnings.push(...anchorResult.warnings);
			continue;
		}

		appliedCount += 1;
		const removedHashes = collectRemovedHashes(edit, currentHashes);
		const nextHashes = await lineHashes(
			nextContent,
			absolutePath,
			{ content: currentContent, hashes: currentHashes, removedHashes },
			snapshotIOFor(opts.store),
			false,
		);
		const { totalAddedLines: added, totalRemovedLines: removed } =
			countLineChanges(
				edit,
				originalHashes,
				false,
				anchorResult.autoFixes?.length ?? 0,
			);
		totalAddedLines += added;
		totalRemovedLines += removed;
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
			removedHashes,
		};
		currentContent = nextContent;
		currentHashes = nextHashes;
		clearNoopLoop(absolutePath);
		if (anchorResult.warnings?.length) warnings.push(...anchorResult.warnings);
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
	params: BatchEditParams,
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

	const undos: Array<{ file: ProcessedFile; restore: () => Promise<void> }> =
		[];
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
					console.error(
						"Failed to restore undo entry after batch abort:",
						error,
					);
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
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as any;
			const record = { ...args };
			if (Array.isArray(record.edits)) {
				record.edits = record.edits.map((item: unknown) => {
					if (!isRec(item)) return item;
					const cloned = { ...item };
					normalizeFilePath(cloned);
					return cloned;
				});
			}
			return record as any;
		},
		renderShell: "default",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertBatchReq(params);
			return executeBatch(params, ctx.cwd, signal, ctx);
		},
	};
}

export function regBatchEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildBatchToolDef());
}
