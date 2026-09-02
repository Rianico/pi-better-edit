/** SAFETY: Edit tool — thin adapter over deep EditTool + TuiPresenter.
 *
 * Clean Architecture: this module is the Interface Adapter seam.
 * It owns the pi ToolDefinition wiring only; Use Case lives in EditTool,
 * Framework (pi TUI) lives in TuiPresenter.
 */

import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
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
import { createEditTool } from "./edit-tool.js";
import { createTuiPresenter } from "./tui-presenter.js";
import { loadP, loadGuide } from "./prompts.js";
import {
	execEdits as pipelineExecEdits,
	type PipelineOptions,
	type ProcessedEditFile,
} from "./edit-pipeline.js";
import type { EditDetails } from "./edit-response.js";
import type { RPreview, RRState } from "./edit-render.js";

void EDIT_DESCRIPTION;
export { assertReq };
export {
	editToolSchema,
	editTupleSchema,
	replacementTextSchema,
	removeFromSchema,
	removeToSchema,
};
export { resolveMissingPath } from "./edit-tool.js";
export { reuseText, reuseMarkdown } from "./tui-presenter.js";

export type EditParams = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type EditRequest = NormalizedEditRequest;

export type ExecPipelineOptions = PipelineOptions;

export function execEdits(
	request: NormalizedEditRequest,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<ProcessedEditFile> {
	return pipelineExecEdits(request, cwd, options);
}

export async function compPreview(
	request: unknown,
	cwd: string,
): Promise<RPreview> {
	const tool = createEditTool();
	return tool.preview(request, cwd);
}

type ToolDef = ToolDefinition<TSchema, EditDetails, RRState> & {
	renderShell?: "default" | "self";
};

export function buildToolDef(): ToolDef {
	const E_DESC = loadP("../prompts/edit.md");
	const E_SNIPPET = loadP("../prompts/edit-snippet.md");
	const E_GUIDE = loadGuide("../prompts/edit-guidelines.md");
	const parameters = editToolSchema;
	const tool = createEditTool();
	const presenter = createTuiPresenter((req, cwd) => tool.preview(req, cwd));
	return {
		name: "edit",
		label: "Edit",
		description: E_DESC,
		parameters,
		promptSnippet: E_SNIPPET,
		promptGuidelines: E_GUIDE,
		prepareArguments: prepareEditArguments,
		renderShell: "default",
		// SAFETY: presenter owns TUI casts — asToolDef returns ToolDefinition-typed renders, edit.ts has zero direct TUI casts
		...presenter.asToolDef(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// SAFETY: pi execute boundary is untyped — ctx narrowed via sessionKeyFor, signal is AbortSignal validated by engine
			const res = await tool.execute(
				params,
				signal as AbortSignal | undefined,
				ctx as unknown as {
					cwd: string;
					sessionManager?: { getSessionId(): string };
				},
			);
			// SAFETY: res is validated tool result after tool.execute — cast to pi ToolDef return type for registration
			return res as unknown as ReturnType<ToolDef["execute"]> extends Promise<
				infer R
			>
				? R
				: never;
		},
	};
}

export function regEdit(pi: ExtensionAPI): void {
	pi.registerTool(buildToolDef());
}
