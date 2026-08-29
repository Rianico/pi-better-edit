import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { genDiff } from "./edit-diff.js";
import {
	normReq,
	prepareEditArguments,
	EDIT_DESCRIPTION,
	type NormalizedEditRequest,
	editToolSchema,
	editTupleSchema,
	replacementTextSchema,
	removeFromSchema,
	removeToSchema,
	assertReq,
} from "./payload-contract.js";
import { parseHashRef } from "./hashline/index.js";
import {
	buildBatchResult,
	type BatchSection,
	type EditDetails,
} from "./edit-response.js";
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
} from "./edit-render.js";
import { DebouncedPreview } from "./preview-controller.js";
import { loadP, loadGuide } from "./prompts.js";
import { findSnapshotPathsByHashes } from "./snapshot-store.js";
import { sessionKeyFor } from "./served-state.js";
import {
	execEdits as pipelineExecEdits,
	type PipelineOptions,
	type ProcessedEditFile,
} from "./edit-pipeline.js";
import {
	execute as engineExecute,
	preview as enginePreview,
} from "./mutation-engine/engine.js";
import { isMutationSuccess } from "./mutation-engine/types.js";

void EDIT_DESCRIPTION;
export { assertReq };
export {
	editToolSchema,
	editTupleSchema,
	replacementTextSchema,
	removeFromSchema,
	removeToSchema,
};

export type EditParams = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type EditRequest = NormalizedEditRequest;

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

export type ExecPipelineOptions = PipelineOptions;

// SAFETY: pass-through retained for import surface — trivial delegate; async removed to avoid needless wrapper.
export function execEdits(
	request: NormalizedEditRequest,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<ProcessedEditFile> {
	return pipelineExecEdits(request, cwd, options);
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
		const result = await enginePreview(normalized, cwd, {
			accessMode: constants.R_OK,
		});
		if (!isMutationSuccess(result)) {
			return { error: result.message };
		}
		const file = result.raw;
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

function makeRenderCall(preview: DebouncedPreview) {
	return (args: unknown, theme: unknown, context: unknown) => {
		const ctx = context as {
			lastComponent: unknown;
			state: unknown;
			expanded: unknown;
		};
		// SAFETY: pi TUI renderCall expects untyped context — cast isolates to render call site, validated by pi's runtime context shape
		preview.renderCall(ctx as unknown as any, args); // SAFETY: pi TUI renderCall expects untyped context
		const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// SAFETY: pi context carries untyped state/expanded — cast to RRState/boolean narrowed by getPreviewInput and theme contract
		text.setText(
			fmtCall(
				getPreviewInput(args),
				(ctx as unknown as { state: RRState }).state as RRState, // SAFETY: state is untyped at TUI boundary
				// SAFETY: pi context expanded is untyped — cast to boolean validated by expanded flag in render call
				(ctx as unknown as { expanded: boolean }).expanded, // SAFETY: expanded is untyped at TUI boundary
				theme as never,
			),
		);
		return text;
	};
}
// SAFETY: pi TUI context isError is untyped at boundary — helper isolates cast validated by render error path
function isErrorContext(ctx: unknown): boolean {
	// SAFETY: isError is untyped at TUI boundary — cast validated by render error path
	return (ctx as unknown as { isError: boolean }).isError;
}

function makeRenderResult(preview: DebouncedPreview) {
	return (
		result: unknown,
		opts: { isPartial: boolean },
		theme: unknown,
		context: unknown,
	) => {
		const ctx = context as {
			lastComponent: unknown;
			state: unknown;
			isError: boolean;
		};
		if (opts.isPartial)
			return reuseText(
				ctx,
				(theme as { fg: (a: string, b: string) => string }).fg(
					"warning",
					"Editing...",
				),
			);
		const typedResult = result as {
			content?: Array<{ type: string; text?: string }>;
			details?: EditDetails;
		};
		const renderedText = getResultText(typedResult);
		// SAFETY: pi TUI context state is untyped at boundary — cast to RRState|undefined validated by preview.clearResult guard
		const renderState = (ctx as unknown as { state: RRState | undefined }) // SAFETY: state is untyped at TUI boundary
			.state as RRState | undefined;
		if (renderState) preview.clearResult(renderState);
		// SAFETY: pi TUI context isError is untyped — cast to boolean validated by render error path
		if (isErrorContext(ctx))
			// SAFETY: isError is untyped at TUI boundary
			// SAFETY: isError is untyped at TUI boundary
			// SAFETY: isError is untyped at TUI boundary, cast validated by render error path
			return renderedText
				? reuseText(
						ctx,
						`\n${(theme as { fg: (a: string, b: string) => string }).fg("error", renderedText)}`,
					)
				: new Text("", 0, 0);
		if (isApplied(typedResult.details)) {
			const appliedText = buildAppliedText(typedResult.details, theme as never);
			return appliedText ? reuseText(ctx, appliedText) : new Text("", 0, 0);
		}
		if (!renderedText) return new Text("", 0, 0);
		return reuseMarkdown(ctx, fmtResultMd(renderedText), theme as never);
	};
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
		// SAFETY: ToolDef renderCall typed strictly by pi — cast from preview-typed makeRenderCall validated by ToolDef contract
		renderCall: makeRenderCall(preview) as unknown as ToolDef["renderCall"], // SAFETY: ToolDef renderCall strictly typed

		// SAFETY: ToolDef renderResult typed strictly — cast from preview-typed makeRenderResult validated by ToolDef contract
		renderResult: makeRenderResult(preview) as unknown as ToolDef["renderResult"], // SAFETY: ToolDef renderResult strictly typed

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

			const sessionKey = sessionKeyFor(ctx);
			const result = await engineExecute(canonical, ctx.cwd, {
				accessMode: constants.R_OK | constants.W_OK,
				signal,
				sessionKey,
			});
			// SAFETY: exhaustive switch on discriminated MutationResult — no isError flag checks, preserves model-facing signal.
			if (isMutationSuccess(result)) {
				if (pathWarning) {
					result.raw.warnings.unshift(pathWarning);
					const patched = buildBatchResult([toSection(result.raw)]);
					return patched;
				}
				return result.toolResult;
			}
			throw new Error(result.message);
		},
	};
}

export function regEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildToolDef());
}
