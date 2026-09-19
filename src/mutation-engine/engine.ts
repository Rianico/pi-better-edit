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
import type { PipelineOptions } from "./types.js";
import type { MutationResult } from "./types.js";
import type { NormalizedEditRequest } from "../payload-contract.js";
import { errCode } from "../utils.js";

function extractCode(message: string): string {
  // WHY: messages are `[MODEL] [E_*] …` (spec §5.3 Output Error Code), so the code is the `E_*` tag
  // WHY: and never the `[MODEL]` audience tag that precedes it.
  const code = message.match(/\[(E_[A-Z0-9_]+)\]/);
  if (code) return code[1]!;
  const m = message.match(/\[([A-Z0-9_]+)\]/);
  return m ? m[1]! : "E_UNKNOWN";
}

function toFailure(error: unknown): MutationResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? (errCode(message) ?? extractCode(message)) : "E_UNKNOWN";
  // WHY: Try to preserve servedRows/servedBlock if error carries them (ServedRejectionError, AnchorMismatchError)
  const servedRows = (error as { servedRows?: import("../hashline/served.js").ServedRow[] })
    ?.servedRows;
  const servedBlock = (error as { servedBlock?: string })?.servedBlock;
  // WHY: Every range-family producer emits `details.cause` (user-facing diagnosis, never a
  // WHY: model remedy) so it cannot rot into a phantom promise — preserve it on the failure.
  const cause = (error as { cause?: string })?.cause;
  const details = (error as { details?: { cause: string } })?.details;
  // WHY: Served block is embedded in message for batch abort; keep message as serve-block source.
  return {
    ok: false,
    code,
    message,
    ...(servedRows && servedRows.length > 0 ? { servedRows } : {}),
    ...(typeof servedBlock === "string" && servedBlock.length > 0 ? { servedBlock } : {}),
    ...(typeof cause === "string" ? { cause } : {}),
    ...(details && typeof details.cause === "string" ? { details } : {}),
  };
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
    // WHY: Build a success shape matching execute's contract without persist.
    // WHY: `file` is ProcessedEditFile; synthesize diff/metrics via the same
    // WHY: helpers the pipeline's `apply` would use — but for preview we can
    // WHY: return minimal success (raw is the file, diff is empty if noop).
    // WHY: To avoid duplicating buildBatchResult logic, delegate to a thin
    // WHY: conversion: if applied, callers can diff via raw; otherwise noop.
    // WHY: Here we surface raw + a synthetic success — callers that need diff
    // WHY: should use `execute` or rely on `raw.result` vs `raw.originalNormalized`.
    const diff = ""; // WHY: preview diff is available via file.result vs file.originalNormalized; kept empty to avoid duplicating genDiff here
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
