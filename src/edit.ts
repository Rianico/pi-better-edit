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
import { normReq } from "./edit-normalize";
import {
	isRec,
	rejectUnknownFields,
	abortIf,
	normalizeFilePath,
	splitLines,
} from "./utils";
import { resolveTarget, writeAtomic } from "./fs-write";
import { resEdit, parseHashRef, type NEdit } from "./hashline";
import { toCwd } from "./paths";
import { fileSnap } from "./file-reader";
import {
	buildChanged,
	buildNoop,
	type EditDetails,
	type RMeta,
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
import { sessionKeyFor } from "./served-state";
import type { ResolvedRange } from "./hashline/served";
import { applyOneEdit, countLineChanges, loadEditFile } from "./edit-pipeline";

export const replacementTextSchema = Type.String({
	description:
		'Replacement text as a single string with \\n line separators; every \\n separates lines, so a trailing \\n adds a final empty line. Mirror the removed lines exactly, blank lines included. A replacement that is only blank lines is written as one \\n per blank line. Use "" to delete the range.',
});

export const removeFromSchema = Type.String({
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)',
});

export const removeToSchema = Type.String({
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)',
});

export const editToolSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					"Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake.",
			}),
		),
		remove_from: removeFromSchema,
		remove_to: removeToSchema,
		replacement_text: replacementTextSchema,
	},
	{ additionalProperties: false },
);
export type EditParams = {
	path: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

interface PipelineResult {
	path: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: LineEnding;
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	noopEdit?: NEdit;
	firstChangedLine?: number;
	lastChangedLine?: number;
	originalHashes: string[];
	resultHashes: string[];
	totalAddedLines: number;
	totalRemovedLines: number;
	driftNotice?: string;
	range: ResolvedRange;
}

const ROOT_KS = new Set([
	"path",
	"remove_from",
	"remove_to",
	"replacement_text",
]);

export function assertReq(request: unknown): asserts request is EditParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	rejectUnknownFields(request, ROOT_KS, "Edit request");

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "path" string.',
		);
	}

	if (
		typeof request.remove_from !== "string" ||
		typeof request.remove_to !== "string" ||
		typeof request.replacement_text !== "string"
	) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_text" at the top level.',
		);
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

export async function execPipeline(
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path;

	const editWarnings: string[] = [];
	const edit = resEdit(
		{
			remove_from: params.remove_from,
			remove_to: params.remove_to,
			replacement_text: params.replacement_text,
		},
		editWarnings,
	);

	const hashStore = options?.store ?? (await loadHashStore());
	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined);
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

	const outcome = await applyOneEdit({
		content: originalNormalized,
		hashes: originalHashes,
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
			throw error;
		},
	});

	const isNoop = outcome.kind === "noop";
	const result = outcome.kind === "applied" ? outcome.content : originalNormalized;
	const resultHashes = outcome.kind === "applied" ? outcome.hashes : originalHashes;
	const warnings = [...editWarnings, ...(outcome.anchorWarnings ?? [])];
	const { totalAddedLines, totalRemovedLines } = countLineChanges(
		edit,
		originalHashes,
		isNoop,
		outcome.kind === "applied" ? outcome.autoFixes?.length ?? 0 : 0,
	);

	let driftNotice: string | undefined;
	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes,
				resultLines: splitLines(result),
				range: outcome.range,
				path: absolutePath,
			});
		} catch (error) {
			console.error("Failed to compute drift notice:", error);
		}
	}

	return {
		path,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		noopEdit: outcome.kind === "noop" ? outcome.noopEdit : undefined,
		firstChangedLine: outcome.kind === "applied" ? outcome.firstChangedLine : undefined,
		lastChangedLine: outcome.kind === "applied" ? outcome.lastChangedLine : undefined,
		resultHashes,
		originalHashes,
		totalAddedLines,
		totalRemovedLines,
		driftNotice,
		range: outcome.range,
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
		const { path, originalNormalized, result, resultHashes, originalHashes } =
			await execPipeline(normalized, cwd, {
				accessMode: constants.R_OK,
				noPersist: true,
			});
		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edit produced identical content.`,
			};
		}

		return {
			diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes)
				.diff,
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
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as any;
			const record = { ...args };
			normalizeFilePath(record);
			return record;
		},
		renderShell: "default",
		renderCall(args, theme, context) {
			preview.renderCall(context, args);
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				fmtCall(
					getPreviewInput(args) ?? undefined,
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
				return appliedText
					? reuseText(context, appliedText)
					: new Text("", 0, 0);
			}

			if (!renderedText) return new Text("", 0, 0);
			return reuseMarkdown(context, fmtResultMd(renderedText), theme);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const canonical = normReq(params);
			const resolution = isRec(canonical)
				? await resolveMissingPath(canonical)
				: undefined;
			if (resolution && isRec(canonical)) {
				canonical.path = resolution.path;
			}
			assertReq(canonical);

			const normalizedParams = canonical;
			const path = normalizedParams.path;
			const absolutePath = toCwd(path, ctx.cwd);
			const mutationTargetPath = await resolveTarget(absolutePath);
			const sessionKey = sessionKeyFor(ctx);
			return withFileMutationQueue(mutationTargetPath, async () => {
				abortIf(signal);

				const {
					originalNormalized,
					originalHashes,
					result,
					bom,
					originalEnding,
					hadUtf8DecodeErrors,
					warnings,
					noopEdit,
					firstChangedLine,
					lastChangedLine,
					resultHashes,
					totalAddedLines,
					totalRemovedLines,
					driftNotice,
					range,
				} = await execPipeline(normalizedParams, ctx.cwd, {
					accessMode: constants.R_OK | constants.W_OK,
					signal,
					sessionKey,
				});

				if (resolution) {
					warnings.unshift(resolution.warning);
				}

				const editsAttempted = 1;
				if (originalNormalized === result) {
					const decision = await runNoopPolicy({
						absolutePath,
						removeFrom: canonical.remove_from,
						removeTo: canonical.remove_to,
						replacementText: canonical.replacement_text,
						ref: `in ${path}`,
						batch: false,
						range,
						hashes: originalHashes,
						lines: splitLines(originalNormalized),
						sessionKey,
					});
					if (decision.action === "reject") {
						throw new Error(decision.message);
					}
					if (decision.action === "warn") {
						warnings.push(decision.notice);
					}
					let noopSnapshotId: string | undefined;
					try {
						noopSnapshotId = (await fileSnap(absolutePath)).snapshotId;
					} catch (error) {
						console.error("Failed to compute snapshot for noop edit:", error);
					}
					return buildNoop({
						path,
						noopEdit,
						snapshotId: noopSnapshotId,
						editMeta: {
							editsAttempted,
							noopEditsCount: noopEdit ? 1 : 0,
							addedLines: 0,
							removedLines: 0,
						},
						warnings,
						driftNotice,
					});
				}

				clearNoopLoop(absolutePath);

				if (hadUtf8DecodeErrors) {
					warnings.push(
						"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
					);
				}

				abortIf(signal);
				const undo = await saveUndo(mutationTargetPath, {
					content: originalNormalized,
					bom,
					originalEnding,
					hashes: originalHashes,
					resultContent: result,
				});
				if (!undo.persisted) {
					throw new Error(
						`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
					);
				}
				try {
					abortIf(signal);
					await writeAtomic(
						absolutePath,
						bom + restoreEndings(result, originalEnding),
					);
				} catch (error) {
					await undo.restore();
					throw error;
				}
				let updatedSnapshotId: string | undefined;
				try {
					updatedSnapshotId = (await fileSnap(absolutePath)).snapshotId;
				} catch (error) {
					console.error("Failed to compute post-edit snapshot:", error);
				}

				const editMeta: RMeta = {
					editsAttempted,
					noopEditsCount: noopEdit ? 1 : 0,
					firstChangedLine,
					lastChangedLine,
					addedLines: totalAddedLines,
					removedLines: totalRemovedLines,
				};

				const successInput = {
					path,
					originalNormalized,
					originalHashes,
					result,
					resultHashes,
					warnings,
					snapshotId: updatedSnapshotId,
					editMeta,
					driftNotice,
				};
				return buildChanged(successInput);
			});
		},
	};
}

export function regEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildToolDef());
}
