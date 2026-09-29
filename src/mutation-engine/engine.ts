/**
 * SAFETY: MutationEngine — deep module behind the mutation seam.
 *
 * Small interface: `execute` + `preview`. Deep implementation: load → parse
 * → mutate → finalize → drift → persist → serve hidden inside the pipeline.
 * Internal seams (validate, verify, mutate, guard, persist, record) stay
 * private — not exported. The interface is the test surface.
 *
 * Typed boundaries: validate once at admission (edit.ts via payload-contract),
 * trust inside. Errors fail loud with typed `MutationFailure`.
 */

import { apply as pipelineApply, previewEdits as pipelinePreview } from "./pipeline.js";
import { genDiff } from "../edit-diff.js";
import { DIFF_PREVIEW_CONTEXT } from "../constants.js";
import type { PipelineOptions } from "./types.js";
import type { MutationResult } from "./types.js";
import type { NormalizedEditRequest } from "../payload-contract.js";
import { DomainError, type DomainErrorCode } from "../domain-errors.js";
import { readEnvelope, type ErrorEnvelope } from "../error-envelope.js";

function failureFromEnvelope(args: {
  code: DomainErrorCode;
  message: string;
  env: ErrorEnvelope;
}): MutationResult {
  const { code, message, env } = args;
  return {
    ok: false,
    code,
    message,
    ...(env.servedRows !== undefined && env.servedRows.length > 0
      ? { servedRows: env.servedRows }
      : {}),
    ...(env.servedBlock !== undefined ? { servedBlock: env.servedBlock } : {}),
    ...(env.cause !== undefined ? { cause: env.cause, details: { code, cause: env.cause } } : {}),
  };
}

function toFailure(error: unknown): MutationResult {
  // WHY: registry errors carry their code, rows, block, and diagnosis as typed
  // WHY: fields — the code is read, never scraped from the message, so a
  // WHY: `[MODEL]`-only message can never surface as `code: "MODEL"`.
  if (error instanceof DomainError) {
    return failureFromEnvelope({
      code: error.code,
      message: error.message,
      env: readEnvelope(error) ?? {},
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // WHY: the batch-abort wrapper preserves the failing item's own code as a
  // WHY: plain field — a registry member routes the typed path, while
  // WHY: errno-style codes (ENOENT) and unexpected throws fall through to
  // WHY: `E_UNKNOWN` instead of leaking a scraped token as the code. The
  // WHY: envelope reader owns that validation: a non-registry code reads back
  // WHY: as no code at all, which is exactly the fall-through condition.
  const env = readEnvelope(error);
  if (env !== undefined && env.code !== undefined) {
    return failureFromEnvelope({ code: env.code, message, env });
  }
  // WHY: unexpected errors emit `E_UNKNOWN` through the registry: the first
  // WHY: message line only, never the verbatim `String(error)` dump.
  const unknown = new DomainError("E_UNKNOWN", {
    errorName: error instanceof Error ? error.name : typeof error,
    message,
  });
  return failureFromEnvelope({
    code: unknown.code,
    message: unknown.message,
    env: readEnvelope(unknown) ?? {},
  });
}

/**
 * SAFETY: Execute a mutation against the file system (persist + undo + serve).
 * Returns discriminated `MutationResult` — callers must switch on `ok`.
 *
 * No `any` threading: input is `NormalizedEditRequest` (validated at
 * admission), output is typed. Failures are `ok:false` with `code`, not
 * loose `isError` flags.
 */
export async function execute(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<MutationResult> {
  try {
    const { result, diff, drift, metrics, raw, toolResult } = await pipelineApply(
      request,
      cwd,
      options,
    );
    if (!metrics) throw new Error("missing metrics from pipeline — invariant violation");
    return {
      ok: true,
      result,
      diff,
      drift,
      metrics,
      raw,
      toolResult,
    };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * SAFETY: Preview a mutation without persisting (noPersist). Same seam as `execute`,
 * same `MutationResult` — one interface, N call sites (preview + apply share
 * the internal path via `runMutations` with `noPersist:true`).
 */
export async function preview(
  request: NormalizedEditRequest,
  cwd: string,
  options?: Omit<PipelineOptions, "noPersist">,
): Promise<MutationResult> {
  try {
    // WHY: pipelinePreview does not persist and does not write undo — but still
    // WHY: runs the full mutate→finalize→drift path.
    const file = await pipelinePreview(request, cwd, options);
    // WHY: #174 single-projection contract — the preview diff IS the `genDiff` projection,
    // WHY: produced here at the same seam that returns execute's projected `diff`, with the
    // WHY: preview pane's context (`DIFF_PREVIEW_CONTEXT`). The display path (`edit-tool
    // WHY: preview` → preview-controller → edit-render) consumes this text and never
    // WHY: re-projects; `file` already carries everything `genDiff` needs, so no side
    // WHY: decision of an empty diff is synthesized here.
    const diff = genDiff(
      file.originalNormalized,
      file.result,
      DIFF_PREVIEW_CONTEXT,
      file.resultHashes,
      file.originalHashes,
    ).diff;
    const metrics: import("../edit-response.js").RMetrics = {
      classification: (file.appliedCount > 0 ? "applied" : "noop") as "applied" | "noop",
      edits_attempted: file.appliedCount + file.noopCount,
      edits_noop: file.noopCount,
      warnings: file.warnings.length,
      added_lines: file.totalAddedLines,
      removed_lines: file.totalRemovedLines,
      ...(file.literalDeclarations > 0 ? { literalDeclarations: file.literalDeclarations } : {}),
    };
    const details: import("../edit-response.js").EditDetails = {
      diff,
      warnings: file.warnings.length > 0 ? file.warnings : undefined,
      driftNotice: file.driftNotice,
      metrics,
      servedRows: [],
    };
    return {
      ok: true,
      result: file.result,
      diff,
      drift: file.driftNotice,
      metrics,
      raw: file,
      toolResult: { content: [{ type: "text", text: diff }], details },
    };
  } catch (error) {
    return toFailure(error);
  }
}

// WHY: Re-export for callers that need the throw-based legacy path.
export { toFailure };
