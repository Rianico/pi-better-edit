/** SAFETY: Edit tool — thin adapter over deep EditTool + TuiPresenter.
 *
 * Clean Architecture: this module is the Interface Adapter seam.
 * It owns the pi ToolDefinition wiring only; Use Case lives in EditTool,
 * Framework (pi TUI) lives in TuiPresenter.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  prepareEditArguments,
  EDIT_DESCRIPTION,
  type NormalizedEditRequest,
  editToolSchema,
  editItemSchema,
  replaceWithSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
  assertReq,
} from "./payload-contract.js";
import { createEditTool, type PreviewContext } from "./edit-tool.js";
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
/** SAFETY: @deprecated Import from "./payload-contract.js" — single source per ADR-0007 */
export { assertReq };
/** SAFETY: @deprecated Import from "./payload-contract.js" — single source per ADR-0007. Re-exports retained for compatibility until next MAJOR. */
export {
  editToolSchema,
  editItemSchema,
  replaceWithSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
};
export { reuseText, reuseMarkdown } from "./tui-presenter.js";

export type EditParams = {
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
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
  ctx: PreviewContext,
): Promise<RPreview> {
  const tool = createEditTool();
  return tool.preview(request, cwd, ctx);
}

type ToolDef = ToolDefinition<TSchema, EditDetails, RRState> & {
  renderShell?: "default" | "self";
};

export function buildToolDef(
  getSessionManager?: () => { getSessionId(): string } | undefined,
): ToolDef {
  const E_DESC = loadP("../prompts/edit.md");
  const E_SNIPPET = loadP("../prompts/edit-snippet.md");
  const E_GUIDE = loadGuide("../prompts/edit-guidelines.md");
  const parameters = editToolSchema;
  const tool = createEditTool();
  const presenter = createTuiPresenter((req, cwd) =>
    tool.preview(req, cwd, { sessionManager: getSessionManager?.() }),
  );
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
      return res as unknown as ReturnType<ToolDef["execute"]> extends Promise<infer R> ? R : never;
    },
  };
}

export function regEdit(pi: ExtensionAPI): void {
  // WHY: (#165) pi's ToolRenderContext carries no session, so the preview pane's session is
  // WHY: captured from the session_start ctx — the same session reads serve anchors to.
  // WHY: session_start fires for startup/reload/new/resume/fork, so the capture tracks switches.
  let sessionManager: { getSessionId(): string } | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
  });
  pi.registerTool(buildToolDef(() => sessionManager));
}
