import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import {
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./replace-diff";
import { normalizeReplaceRequest } from "./replace-normalize";
import { isRecord, hasOwn } from "./utils";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
	applyHashlineEdits,
	computeLineHashes,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import {
	buildChangedResponse,
	buildNoopResponse,
	type ReplaceMeta,
	type ReplaceMetrics,
} from "./replace-response";
import {
	buildAppliedChangedResultText,
	createRenderedEditMarkdownTheme,
	formatEditCall,
	formatRenderedEditResultMarkdown,
	getRenderablePreviewInput,
	getRenderedEditTextContent,
	isAppliedChangedResult,
	type ReplacePreview,
	type ReplaceRenderState,
} from "./replace-render";
import { loadPrompt, loadPromptGuidelines } from "./prompts";
import { validateFileAccess, assertTextFile } from "./validation";


const hashlineEditNewLinesSchema = Type.Array(Type.String(), {
	description:
		"literal replacement file content, one string per line. Must not include the HASH│ prefix from read output.",
});

const hasheditOldRangeSchema = Type.Array(
	Type.String({ description: "anchor (3-char HASH)" }),
	{
		description: "inclusive line range to replace [start_hash, end_hash]. Each element must be the 3-character hash anchor only; do not include the │ separator or line content.",
		minItems: 2,
		maxItems: 2,
	},
);

const hashlineEditItemSchema = Type.Object(
	{
		old_range: Type.Optional(hasheditOldRangeSchema),
		new_lines: Type.Optional(hashlineEditNewLinesSchema),
	},
	{ additionalProperties: false },
);
export const hashlineEditToolSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		edits: Type.Optional(
			Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
		),
	},
	{ additionalProperties: false },
);

export type ReplaceRequestParams = {
	path: string;
	edits?: HashlineToolEdit[];
};


export type HashlineReplaceToolDetails = {
	diff: string;
	firstChangedLine?: number;
	snapshotId?: string;
	classification?: "noop";
	structureOutline?: string[];
	metrics?: ReplaceMetrics;
};

const EDIT_DESC = loadPrompt("../prompts/replace.md");
const EDIT_PROMPT_SNIPPET = loadPrompt("../prompts/replace-snippet.md");
const EDIT_PROMPT_GUIDELINES = loadPromptGuidelines("../prompts/replace-guidelines.md");
const ROOT_KEYS = new Set(["path", "edits"]);

export function assertReplaceRequest(
	request: unknown,
): asserts request is ReplaceRequestParams {
	if (!isRecord(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	for (const legacyKey of ["oldText", "newText", "old_text", "new_text", "start", "end", "lines"]) {
		if (hasOwn(request, legacyKey)) {
			throw new Error(
				`[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {old_range: ["<START>", "<END>"], new_lines: [...]}.`
			);
		}
	}

	const unknownRootKeys = Object.keys(request).filter(
		(key) => !ROOT_KEYS.has(key),
	);
	if (unknownRootKeys.length > 0) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}. Use only { path, edits }; each edit is { old_range: ["<START>", "<END>"], new_lines: [...] }.`,
		);
	}

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
	}

	if (hasOwn(request, "edits") && !Array.isArray(request.edits)) {
		throw new Error('[E_BAD_SHAPE] Edit request requires an "edits" array when provided. Each edit is { old_range: ["<START>", "<END>"], new_lines: [...] }.');
	}

}
async function executeEditPipeline(
	request: unknown,
	cwd: string,
	accessMode: number,
	signal?: AbortSignal,
): Promise<{
	path: string;
	toolEdits: HashlineToolEdit[];
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: "\r\n" | "\n";
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	noopEdits?: { editIndex: number; loc: string; currentContent: string }[];
	firstChangedLine?: number;
	lastChangedLine?: number;
	originalHashes?: string[];
}> {
	const normalized = normalizeReplaceRequest(request);
	assertReplaceRequest(normalized);

	const params = normalized;
	const path = params.path;
	const absolutePath = resolveToCwd(path, cwd);
	const toolEdits = Array.isArray(params.edits)
		? (params.edits as HashlineToolEdit[])
		: [];

	if (toolEdits.length === 0) {
		throw new Error("[E_BAD_SHAPE] Edit request requires a non-empty \"edits\" array.");
	}

	throwIfAborted(signal);
	await validateFileAccess(absolutePath, path, accessMode);

	throwIfAborted(signal);
	const file = await loadFileKindAndText(absolutePath);
	assertTextFile(file, path);

	throwIfAborted(signal);
	const { bom, text: rawContent } = stripBom(file.text);
	const originalEnding = detectLineEnding(rawContent);
	const originalNormalized = normalizeToLF(rawContent);

	const originalHashes = computeLineHashes(originalNormalized);

	const resolved = resolveEditAnchors(toolEdits);
	const anchorResult = applyHashlineEdits(
		originalNormalized,
		resolved,
		signal,
		originalHashes,
	);

	return {
		path,
		toolEdits,
		originalNormalized,
		result: anchorResult.content,
		bom,
		originalEnding,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
		warnings: [...(anchorResult.warnings ?? [])],
		noopEdits: anchorResult.noopEdits,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		originalHashes,
	};
}

export async function computeReplacePreview(
	request: unknown,
	cwd: string,
): Promise<ReplacePreview> {
	try {
		const { path, originalNormalized, result } = await executeEditPipeline(
			request,
			cwd,
			constants.R_OK,
		);

		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edits produced identical content.`,
			};
		}

		return { diff: generateDiffString(originalNormalized, result, 4, computeLineHashes(result)).diff };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type EditToolDefinition = ToolDefinition<
	typeof hashlineEditToolSchema,
	HashlineReplaceToolDetails,
	ReplaceRenderState
> & { renderShell?: "default" | "self" };

const editToolDefinition: EditToolDefinition = {
	name: "replace",
	label: "Replace",
	description: EDIT_DESC,
	parameters: hashlineEditToolSchema,
	promptSnippet: EDIT_PROMPT_SNIPPET,
	promptGuidelines: EDIT_PROMPT_GUIDELINES,
	prepareArguments: (args: unknown) =>
		normalizeReplaceRequest(args) as ReplaceRequestParams,
	renderShell: "default",
	renderCall(args, theme, context) {
		const previewInput = getRenderablePreviewInput(args);
		if (context.executionStarted) {
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration =
				(context.state.previewGeneration ?? 0) + 1;
		} else if (!context.argsComplete || !previewInput) {
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration =
				(context.state.previewGeneration ?? 0) + 1;
		} else {
			const argsKey = JSON.stringify(previewInput);
			if (context.state.argsKey !== argsKey) {
				context.state.argsKey = argsKey;
				context.state.preview = undefined;
				const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
				context.state.previewGeneration = previewGeneration;
				computeReplacePreview(previewInput, context.cwd)
					.then((preview) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = preview;
							context.invalidate();
						}
					})
					.catch((err: unknown) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = {
								error: err instanceof Error ? err.message : String(err),
							};
							context.invalidate();
						}
					});
			}
		}
		const text =
			(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatEditCall(
				getRenderablePreviewInput(args) ?? undefined,
				context.state as ReplaceRenderState,
				context.expanded,
				theme,
			),
		);
		return text;
	},

	renderResult(result, { isPartial }, theme, context) {
		if (isPartial) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("warning", "Editing..."));
			return text;
		}

		const typedResult = result as {
			content?: Array<{ type: string; text?: string }>;
			details?: HashlineReplaceToolDetails;
		};
		const renderedText = getRenderedEditTextContent(typedResult);

		const renderState = context.state as ReplaceRenderState | undefined;
		if (renderState) {
			renderState.preview = undefined;
			renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
		}

		if (context.isError) {
			if (!renderedText) {
				return new Text("", 0, 0);
			}
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			text.setText(`\n${theme.fg("error", renderedText)}`);
			return text;
		}

		if (isAppliedChangedResult(typedResult.details)) {
			const appliedChangedText = buildAppliedChangedResultText(
				renderedText,
				typedResult.details,
				theme,
			);
			if (!appliedChangedText) {
				return new Text("", 0, 0);
			}
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			text.setText(appliedChangedText);
			return text;
		}

		if (!renderedText) {
			return new Text("", 0, 0);
		}

		const markdown =
			context.lastComponent instanceof Markdown
				? context.lastComponent
				: new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
		markdown.setText(formatRenderedEditResultMarkdown(renderedText));
		return markdown;
	},

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const normalized = normalizeReplaceRequest(params);
		assertReplaceRequest(normalized);
		const normalizedParams = normalized;
		const path = normalizedParams.path;
		const absolutePath = resolveToCwd(path, ctx.cwd);
		const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
		return withFileMutationQueue(mutationTargetPath, async () => {
			throwIfAborted(signal);

			const {
				originalNormalized,
				result,
				bom,
				originalEnding,
				hadUtf8DecodeErrors,
				warnings,
				noopEdits,
				firstChangedLine,
				lastChangedLine,
			} = await executeEditPipeline(
				normalized,
				ctx.cwd,
				constants.R_OK | constants.W_OK,
				signal,
			);

			const editsAttempted = Array.isArray(normalizedParams.edits)
				? normalizedParams.edits.length
				: 0;

			if (originalNormalized === result) {
				const noopSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
			return buildNoopResponse({
				path,
				noopEdits,
				snapshotId: noopSnapshotId,
				editMeta: {
					editsAttempted,
					noopEditsCount: noopEdits?.length ?? 0,
				},
				warnings,
			});
			}

			if (hadUtf8DecodeErrors) {
				warnings.push(
					"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
				);
			}

			throwIfAborted(signal);
			await writeFileAtomically(
				absolutePath,
				bom + restoreLineEndings(result, originalEnding),
			);
			const updatedSnapshotId = (await getFileSnapshot(absolutePath))
				.snapshotId;

			const editMeta: ReplaceMeta = {
				editsAttempted,
				noopEditsCount: noopEdits?.length ?? 0,
				firstChangedLine,
				lastChangedLine,
			};

			const successInput = {
				path,
				originalNormalized,
				result,
				resultHashes: computeLineHashes(result),
				warnings,
				snapshotId: updatedSnapshotId,
				editMeta,
			};

			return buildChangedResponse(successInput);
		});
	},
};

export function registerReplaceTool(pi: ExtensionAPI): void {
	pi.registerTool(editToolDefinition);
}