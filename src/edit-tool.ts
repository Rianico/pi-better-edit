/** SAFETY: EditTool — deep module owning the edit Use Case seam.
 *
 * Graded surface: one narrow interface `EditTool { execute, preview }`
 * hides pipeline delegation, warnings/drift stitching.
 * Frameworks (pi TUI) never cross this seam — that lives in TuiPresenter.
 * Clean Architecture: Use Cases depend inward only (mutation-engine),
 * never outward to Frameworks.
 *
 * Typed boundaries: validate once at admission (payload-contract via normReq/assertReq),
 * trust inside. Immutable state: never mutates caller-owned request.
 */

import { constants } from "node:fs";
import { sessionKeyFor } from "./served-session/session.js";
import { normReq, assertReq, type NormalizedEditRequest } from "./payload-contract.js";
import { execute as engineExecute, preview as enginePreview } from "./mutation-engine/engine.js";
import { isMutationSuccess } from "./mutation-engine/types.js";
import { genDiff } from "./edit-diff.js";

export type EditToolContext = {
  cwd: string;
  sessionManager?: { getSessionId(): string };
};

export type PreviewContext = {
  sessionManager?: { getSessionId(): string };
};

export type PreviewResult = { diff: string } | { error: string };

export interface EditTool {
  /** SAFETY: Execute a validated edit; returns pi tool_result or throws on failure. Admission: params validated by normReq/assertReq. */
  execute(
    params: unknown,
    signal: AbortSignal | undefined,
    ctx: EditToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
  /** SAFETY: Preview without persisting — mirrors pi's compPreview(request, cwd, ctx). The ctx must carry the session whose serves the anchors came from (#165). */
  preview(request: unknown, cwd: string, ctx: PreviewContext): Promise<PreviewResult>;
}

export function createEditTool(): EditTool {
  return {
    async execute(params, signal, ctx) {
      const canonical = normReq(params);
      assertReq(canonical);
      // SAFETY: ctx is untyped at pi boundary — cast validated by pi's runtime context shape (cwd + sessionManager)
      const sessionKey = sessionKeyFor(
        ctx as unknown as { sessionManager?: { getSessionId(): string } },
      );
      // SAFETY: canonical is validated NormalizedEditRequest after assertReq — trusted inside boundary
      const result = await engineExecute(canonical as NormalizedEditRequest, ctx.cwd, {
        accessMode: constants.R_OK | constants.W_OK,
        // SAFETY: signal is AbortSignal | undefined at pi boundary — runtime check via engine's abortIf
        signal: signal as AbortSignal | undefined,
        sessionKey,
      });
      if (isMutationSuccess(result)) {
        // SAFETY: toolResult is validated by isMutationSuccess discriminated union guard
        return result.toolResult as {
          content: Array<{ type: "text"; text: string }>;
          details: unknown;
        };
      }
      // WHY: every range-family producer emits `details.cause` (user-facing diagnosis) —
      // WHY: carry it on the thrown error so callers catching the message still see the cause.
      const failure = new Error(result.message);
      (failure as { code?: string }).code = result.code;
      (failure as { servedRows?: unknown }).servedRows = result.servedRows ?? [];
      (failure as { servedBlock?: string }).servedBlock = result.servedBlock ?? "";
      if (result.details && typeof result.details.cause === "string") {
        (failure as { details?: { cause: string } }).details = result.details;
        (failure as { cause?: string }).cause = result.details.cause;
      }
      throw failure;
    },
    async preview(request, cwd, ctx) {
      try {
        const normalized = normReq(request);
        assertReq(normalized);
        // SAFETY: normalized is validated NormalizedEditRequest after assertReq
        // WHY: (#165) preview verifies against the SAME session the anchors were served to —
        // WHY: without a session, sessionKeyFor fails loud here instead of minting a key whose
        // WHY: lease lookups all miss as a misleading E_UNKNOWN_ANCHOR.
        const result = await enginePreview(normalized as NormalizedEditRequest, cwd, {
          accessMode: constants.R_OK,
          sessionKey: sessionKeyFor(ctx),
        });
        if (!isMutationSuccess(result)) {
          return { error: result.message };
        }
        const file = result.raw;
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
    },
  };
}
