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
  type EditItem,
  editToolSchema,
  editItemSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
  assertReq,
} from "./payload-contract.js";
import { withPayloadSubject } from "./domain-errors.js";
import { attributePayloadSubject } from "./error-envelope.js";
import { createEditTool, type PreviewContext } from "./edit-tool.js";
import { createTuiPresenter } from "./tui-presenter.js";
import { loadP, loadGuide } from "./prompts.js";
import type { EditDetails } from "./edit-response.js";
import type { RPreview, RRState } from "./edit-render.js";
import { inStoreScope, scopedTool } from "./store-lifecycle.js";

void EDIT_DESCRIPTION;
/** SAFETY: @deprecated Import from "./payload-contract.js" — payload-contract is the single source (docs/.archive_adrs/0007-merged-edit-payload-hoisted-path.md). */
export { assertReq };
/** SAFETY: @deprecated Import from "./payload-contract.js" — payload-contract is the single source (docs/.archive_adrs/0007-merged-edit-payload-hoisted-path.md). Re-exports retained for compatibility until next MAJOR. `replaceWithSchema` is REMOVED: the ticket-04 wire has no `replace_with` fold. */
export {
  editToolSchema,
  editItemSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
};
export { reuseText, reuseMarkdown } from "./tui-presenter.js";

/** The wire item (ticket-04): exactly one payload — `text` or `text_ref` — plus optional `at`. */
export type EditParams = EditItem;

export type EditRequest = NormalizedEditRequest;

export async function compPreview(
  request: unknown,
  cwd: string,
  ctx: PreviewContext,
): Promise<RPreview> {
  const tool = createEditTool();
  return inStoreScope(() => tool.preview(request, cwd, ctx));
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
  const presenter = createTuiPresenter(
    (req, cwd) => {
      const sessionManager = getSessionManager?.();
      const previewCtx = sessionManager === undefined ? {} : { sessionManager };
      return inStoreScope(() => tool.preview(req, cwd, previewCtx));
    },
    () => getSessionManager?.()?.getSessionId(),
  );
  return {
    name: "edit",
    label: "Edit",
    description: E_DESC,
    parameters,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    prepareArguments: (args: unknown) => {
      try {
        return prepareEditArguments(args);
      } catch (error) {
        throw withPayloadSubject(error, "edit");
      }
    },
    renderShell: "default",
    ...presenter.asToolDef(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const res = await tool.execute(
          params,
          // SAFETY: pi execute boundary is untyped — ctx narrowed via sessionKeyFor, signal is AbortSignal validated by engine
          signal as AbortSignal | undefined,
          // SAFETY: ctx is untyped at the pi boundary — cast validated by pi's runtime shape
          ctx as unknown as {
            cwd: string;
            sessionManager?: { getSessionId(): string };
          },
        );
        // SAFETY: res is validated tool result after tool.execute — cast to pi ToolDef return type for registration
        return res as unknown as ReturnType<ToolDef["execute"]> extends Promise<infer R>
          ? R
          : never;
      } catch (error) {
        throw attributePayloadSubject(error, "edit");
      }
    },
  };
}

export function regEdit(pi: ExtensionAPI): void {
  let sessionManager: { getSessionId(): string } | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
  });
  pi.registerTool(scopedTool(buildToolDef(() => sessionManager)));
}
