import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import { genDiff, restoreEndings, type LineEnding } from "./edit-diff";
import { scanDrift } from "./drift";
import {
	isNormalizedEdit,
	normReq,
	prepareEditArguments,
	type NormalizedEditRequest,
} from "./edit-normalize";
import { abortIf, rejectUnknownFields, splitLines } from "./utils";
import { resolveTarget, writeAtomic } from "./fs-write";
import { lineHashes, resEdit, type HEdit } from "./hashline";
import { parseHashRef } from "./hashline";
import { toCwd } from "./paths";
import {
	buildBatchResult,
	type BatchSection,
	type EditDetails,
} from "./edit-response";
import {
	buildAppliedText,
	mkMdTheme,
	fmtCall,
	fmtResultMd,
	getPreviewInput,
	getResultText,
	isApplied,
	type RPreview,
	type RRState,
} from "./edit-render";
import { DebouncedPreview } from "./preview-controller";
import { loadP, loadGuide } from "./prompts";
import { saveUndo } from "./edit-undo";
import { loadHashStore, type HashStore } from "./hash-store";
import { clearNoopLoop, runNoopPolicy } from "./noop-guard";
import { findSnapshotPathsByHashes } from "./snapshot-store";
import { snapshotIOFor } from "./snapshot-store";
import { sessionKeyFor } from "./served-state";
import {
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "./hashline/served";
import { applyOneEdit, countLineChanges, loadEditFile } from "./edit-pipeline";
import { EDITS_MAX_ITEMS } from "./constants";

export const replacementTextSchema = Type.String({
	description: 'Complete replacement for the range; use "" to delete',
});

export const removeFromSchema = Type.String({
	description: "First line to remove (inclusive)",
});

export const removeToSchema = Type.String({
	description: "Last line to remove (inclusive)",
});

const editPathSchema = Type.Union([
	Type.String({
		minLength: 1,
		description: "File path; null infers it from anchors",
	}),
	Type.Null(),
]);

export const editTupleSchema = Type.Tuple(
	[removeFromSchema, removeToSchema, replacementTextSchema],
	{
		description: "[remove_from, remove_to, replacement_text]",
	},
);

export const editToolSchema = Type.Object(
	{
		path: editPathSchema,
		edits: Type.Array(editTupleSchema, {
			description: "Ordered list of edit tuples",
			minItems: 1,
			maxItems: EDITS_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

export type EditParams = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type EditRequest = NormalizedEditRequest;

interface ProcessedEditFile {
	path: string;
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
}

const ROOT_KS = new Set(["path", "edits"]);

export function assertReq(
	request: unknown,
): asserts request is NormalizedEditRequest {
	if (!isNormalizedEdit(request)) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request must be exactly { path, edits: [[remove_from, remove_to, replacement_text], ...] }.",
		);
	}

	rejectUnknownFields(request, ROOT_KS, "Edit request");

	if (
		request.path !== null &&
		(typeof request.path !== "string" || request.path.length === 0)
	) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request path must be a non-empty string or null.",
		);
	}

	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request requires a non-empty \"edits\" array.",
		);
	}

	for (let index = 0; index < request.edits.length; index++) {
		const item = request.edits[index]!;
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] Edit request edits[${index}] must be a three-position array [remove_from, remove_to, replacement_text].`,
			);
		}
	}
}

export async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === "string") return undefined;
	const from = request.remove_from;
	const to = request.remove_to;
	if (typeof from !== "string" || typeof to !== "string") return undefined;
	const hashes: string[] = [];
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash);
		} catch {
			return undefined;
		}
	}
	let matches: string[];
	try {
		matches = await findSnapshotPathsByHashes(hashes);
	} catch {
		return undefined;
	}
	if (matches.length === 1) {
		return {
			path: matches[0]!,
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
		);
	}
	return undefined;
}

export interface ExecPipelineOptions {
	accessMode?: number;
	signal?: AbortSignal;
	store?: HashStore;
	noPersist?: boolean;
	sessionKey?: string;
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

export async function execEdits(
	request: NormalizedEditRequest,
	cwd: string,
	options?: ExecPipelineOptions,
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
				`[E_BATCH_ABORT] edit[${index}] (${path}) failed: ${message}\n` +
					`The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.`,
			);
		}
	}

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
			sessionKey,
			absolutePath,
			store: hashStore,
			persistHashes: options?.noPersist !== true,
			servePolicy: options?.noPersist === true ? "preview" : "live",
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
			if (options?.noPersist === true) {
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
		if (options?.noPersist !== true) clearNoopLoop(absolutePath);
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
			options?.noPersist !== true,
		);
	}

	if (hadUtf8DecodeErrors) {
		warnings.push(
			"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
		);
	}

	let driftNotice: string | undefined;
	if (options?.noPersist !== true && unionStartLine !== Infinity) {
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
			console.error("Failed to compute drift notice:", error);
		}
	}

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
		range: {
			startLine: unionStartLine,
			endLine: unionEndLine,
			startHash: unionStartHash,
			endHash: unionEndHash,
			delta: splitLines(result).length - splitLines(originalNormalized).length,
		},
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

export function reuseText(context: any, content: string): Text {
	const t =
		context.lastComponent instanceof Text
			? context.lastComponent
			: new Text("", 0, 0);
	t.setText(content);
	return t;
}

export async function compPreview(
	request: unknown,
	cwd: string,
): Promise<RPreview> {
	try {
		const normalized = normReq(request);
		assertReq(normalized);
		let pathWarning: string | undefined;
		if (normalized.path === null) {
			const resolution = await resolveMissingPath({
				path: normalized.path,
				remove_from: normalized.edits[0]!.remove_from,
				remove_to: normalized.edits[0]!.remove_to,
			});
			if (resolution) {
				normalized.path = resolution.path;
				pathWarning = resolution.warning;
			}
		}
		assertReq(normalized);
		const file = await execEdits(normalized, cwd, {
			accessMode: constants.R_OK,
			noPersist: true,
		});
		if (pathWarning) file.warnings.unshift(pathWarning);
		if (file.originalNormalized === file.result) {
			return {
				error: `No changes made to ${file.path}. The edit produced identical content.`,
			};
		}

		return {
			diff: genDiff(
				file.originalNormalized,
				file.result,
				4,
				file.resultHashes,
				file.originalHashes,
			).diff,
		};
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type ToolDef = ToolDefinition<any, EditDetails, RRState> & {
	renderShell?: "default" | "self";
};

export function reuseMarkdown(
	context: any,
	content: string,
	theme: any,
): Markdown {
	const m =
		context.lastComponent instanceof Markdown
			? context.lastComponent
			: new Markdown("", 0, 0, mkMdTheme(theme));
	m.setText(content);
	return m;
}

export function buildToolDef(): ToolDef {
	const E_DESC = loadP("../prompts/edit.md");
	const E_SNIPPET = loadP("../prompts/edit-snippet.md");
	const E_GUIDE = loadGuide("../prompts/edit-guidelines.md");

	const parameters = editToolSchema;
	const preview = new DebouncedPreview(compPreview);
	return {
		name: "edit",
		label: "Edit",
		description: E_DESC,
		parameters,
		promptSnippet: E_SNIPPET,
		promptGuidelines: E_GUIDE,
		prepareArguments: prepareEditArguments,
		renderShell: "default",
		renderCall(args, theme, context) {
			preview.renderCall(context, args);
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				fmtCall(
					getPreviewInput(args),
					context.state as RRState,
					context.expanded,
					theme,
				),
			);
			return text;
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) {
				return reuseText(context, theme.fg("warning", "Editing..."));
			}

			const typedResult = result as {
				content?: Array<{ type: string; text?: string }>;
				details?: EditDetails;
			};
			const renderedText = getResultText(typedResult);

			const renderState = context.state as RRState | undefined;
			if (renderState) {
				preview.clearResult(renderState);
			}

			if (context.isError) {
				return renderedText
					? reuseText(context, `\n${theme.fg("error", renderedText)}`)
					: new Text("", 0, 0);
			}

			if (isApplied(typedResult.details)) {
				const appliedText = buildAppliedText(typedResult.details, theme);
				return appliedText ? reuseText(context, appliedText) : new Text("", 0, 0);
			}

			if (!renderedText) return new Text("", 0, 0);
			return reuseMarkdown(context, fmtResultMd(renderedText), theme);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const canonical = normReq(params);
			assertReq(canonical);
			let pathWarning: string | undefined;
			if (canonical.path === null) {
				const resolution = await resolveMissingPath({
					path: canonical.path,
					remove_from: canonical.edits[0]!.remove_from,
					remove_to: canonical.edits[0]!.remove_to,
				});
				if (resolution) {
					canonical.path = resolution.path;
					pathWarning = resolution.warning;
				}
			}
			assertReq(canonical);
			if (canonical.path === null) {
				throw new Error(
					"[E_BAD_SHAPE] Edit request path could not be inferred from anchors.",
				);
			}

			const path = canonical.path as string;
			const absolutePath = toCwd(path, ctx.cwd);
			const mutationTargetPath = await resolveTarget(absolutePath);
			const sessionKey = sessionKeyFor(ctx);
			return withFileMutationQueue(mutationTargetPath, async () => {
				abortIf(signal);

				const file = await execEdits(canonical, ctx.cwd, {
					accessMode: constants.R_OK | constants.W_OK,
					signal,
					sessionKey,
				});
				if (pathWarning) file.warnings.unshift(pathWarning);

				if (file.appliedCount === 0) {
					return buildBatchResult([toSection(file)]);
				}

				abortIf(signal);
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
					abortIf(signal);
					await writeAtomic(
						file.absolutePath,
						file.bom + restoreEndings(file.result, file.originalEnding),
					);
				} catch (error) {
					await undo.restore();
					throw error;
				}

				return buildBatchResult([toSection(file)]);
			});
		},
	};
}

export function regEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildToolDef());
}
