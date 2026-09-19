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
import { DomainError, isDomainErrorCode } from "../domain-errors.js";
import type { ServedRow } from "../domain-errors.js";

function failureFromFields(args: {
  code: string;
  message: string;
  fields: {
    servedRows?: unknown;
    servedBlock?: unknown;
    cause?: unknown;
    details?: unknown;
  };
}): MutationResult {
  const { servedRows, servedBlock, cause, details } = args.fields;
  return {
    ok: false,
    code: args.code,
    message: args.message,
    ...(Array.isArray(servedRows) && servedRows.length > 0
      ? { servedRows: servedRows as ServedRow[] }
      : {}),
    ...(typeof servedBlock === "string" && servedBlock.length > 0 ? { servedBlock } : {}),
    ...(typeof cause === "string" ? { cause } : {}),
    ...(details !== null &&
    typeof details === "object" &&
    "cause" in details &&
    typeof (details as { cause: unknown }).cause === "string"
      ? { details: details as { cause: string } }
      : {}),
  };
}

function toFailure(error: unknown): MutationResult {
  // WHY: registry errors carry their code, rows, block, and diagnosis as typed
  // WHY: fields — the code is read, never scraped from the message, so a
  // WHY: `[MODEL]`-only message can never surface as `code: "MODEL"`.
  if (error instanceof DomainError) {
    return failureFromFields({ code: error.code, message: error.message, fields: error });
  }
  const fields = error as
    | {
        code?: unknown;
        servedRows?: unknown;
        servedBlock?: unknown;
        cause?: unknown;
        details?: unknown;
      }
    | null
    | undefined;
  const message = error instanceof Error ? error.message : String(error);
  // WHY: the batch-abort wrapper preserves the failing item's own code as a
  // WHY: plain field — a registry member routes the typed path, while
  // WHY: errno-style codes (ENOENT) and unexpected throws fall through to
  // WHY: `E_UNKNOWN` instead of leaking a scraped token as the code.
  if (fields !== null && typeof fields === "object" && isDomainErrorCode(fields.code)) {
    return failureFromFields({ code: fields.code, message, fields });
  }
  // WHY: unexpected errors emit `E_UNKNOWN` through the registry: the first
  // WHY: message line only, never the verbatim `String(error)` dump.
  const unknown = new DomainError("E_UNKNOWN", {
    errorName: error instanceof Error ? error.name : typeof error,
    message,
  });
  return failureFromFields({ code: unknown.code, message: unknown.message, fields: unknown });
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
