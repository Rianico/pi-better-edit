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
import { DomainError, badPayloadMessageOf, type DomainErrorCode } from "../domain-errors.js";
import { readEnvelope, type ErrorEnvelope } from "../error-envelope.js";

function failureFromEnvelope(args: {
  code: DomainErrorCode;
  message: string;
  env: ErrorEnvelope;
  payloadMessage?: string;
}): MutationResult {
  const { code, message, env, payloadMessage } = args;
  return {
    ok: false,
    code,
    message,
    ...(payloadMessage !== undefined ? { payloadMessage } : {}),
    ...(env.servedRows !== undefined && env.servedRows.length > 0
      ? { servedRows: env.servedRows }
      : {}),
    ...(env.servedBlock !== undefined ? { servedBlock: env.servedBlock } : {}),
    ...(env.cause !== undefined ? { cause: env.cause, details: { code, cause: env.cause } } : {}),
  };
}

/**
 * Route one error to a typed `MutationResult`. A registry `DomainError` supplies its own code, rows,
 * block and diagnosis as fields — the code is read, never scraped, so a `[MODEL]`-only message can
 * never surface as `code: "MODEL"`. A rendered refusal cannot be re-attributed at the tool seam, and
 * the raw payload message travels beside it. A batch-abort wrapper keeps the failing item's code as
 * a plain field, so the envelope reader routes a registry member and its own validation turns a
 * non-registry code (ENOENT, an unexpected throw) into `E_UNKNOWN`, whose message is the first line
 * only. Exported so the envelope test drives this routing seam without running a pipeline.
 */
function toFailure(error: unknown): MutationResult {
  if (error instanceof DomainError) {
    const payloadMessage = badPayloadMessageOf(error);
    return failureFromEnvelope({
      code: error.code,
      message: error.message,
      env: readEnvelope(error) ?? {},
      ...(payloadMessage !== undefined ? { payloadMessage } : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const env = readEnvelope(error);
  if (env !== undefined && env.code !== undefined) {
    return failureFromEnvelope({ code: env.code, message, env });
  }
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
 *
 * A dry run is a request-level promise: `dry_run` on the request derives `noPersist` here, so a
 * programmatic caller never has to remember the option the promise implies.
 */
export async function execute(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<MutationResult> {
  try {
    const isDryRun = request.dry_run === true || options?.dryRun === true;
    const { result, diff, drift, metrics, raw, toolResult } = await pipelineApply(
      request,
      cwd,
      isDryRun ? { ...options, noPersist: true, dryRun: true } : options,
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
 * the internal path via `runMutations` with `noPersist:true`). The preview diff is the `genDiff`
 * projection, built here with the preview pane's context (`DIFF_PREVIEW_CONTEXT`), so the display
 * path consumes it and never re-projects it (#174).
 */
export async function preview(
  request: NormalizedEditRequest,
  cwd: string,
  options?: Omit<PipelineOptions, "noPersist" | "dryRun">,
): Promise<MutationResult> {
  try {
    const file = await pipelinePreview(request, cwd, options);
    const diff = genDiff(
      file.originalNormalized,
      file.result,
      DIFF_PREVIEW_CONTEXT,
      file.resultHashes,
      file.originalHashes,
      undefined,
      file.served,
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
      ...(file.warnings.length > 0 ? { warnings: file.warnings } : {}),
      ...(file.driftNotice !== undefined ? { driftNotice: file.driftNotice } : {}),
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

export { toFailure };
