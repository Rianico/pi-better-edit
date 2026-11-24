import { DomainError } from "../domain-errors.js";
import { batchAbort, type BatchFailure } from "../edit-response.js";
import { notifyServedSpans, servedRowsToSpans } from "../served-spans.js";
import { createSessionHandle } from "../served-session/session.js";

/**
 * Records the reject-and-serve rows a rejected edit owes the model, so the anchors it serves are
 * usable without a re-read (README reject-and-serve contract). The pre-mutation span gate and the
 * sequential mutate loop share it, so a rejection records the same serves whichever one catches it.
 * A rowless rejection (a target-lost refusal, pinned by the seam oracle) returns before anything leases:
 * there is nothing to serve, and every window that identifies the model's range still leases through the
 * rows below. A preview is a containment boundary — mirroring its rows would let an edit that was never
 * applied satisfy the read guard.
 */
async function recordRejectionServe(args: {
  error: DomainError;
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  lineCount: number;
  contentHash: string | undefined;
}): Promise<void> {
  if (args.error.servedRows.length === 0) return;
  if (!args.isPreview) {
    notifyServedSpans({
      filePath: args.absolutePath,
      spans: servedRowsToSpans(args.error.servedRows),
      source: "reject-and-serve",
    });
  }
  const handle = createSessionHandle(args.sessionKey, args.absolutePath);
  if (args.isPreview) {
    await handle.recordServeFeedback(args.error.servedRows, "preview", args.lineCount);
    return;
  }
  await handle.recordServeFeedback(args.error.servedRows, "live", args.lineCount, args.contentHash);
}

/** The store identity a rejection serve records through — owned by the pipeline, like the gate does today. */
export interface BatchRejectionRecorder {
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  lineCount: number;
  contentHash: string | undefined;
}

/**
 * The one batch-rejection assembler (#334): every rejection builds its error,
 * records the rows it shows, then throws — forgetting to record stops being
 * possible rather than reviewable. A 1-item call (`total === 1`) throws the
 * bare `failures[0].error` with no verdict line, exactly as the single-item
 * sites did; anything larger builds through `batchAbort`. Rowless allowlist
 * (no `record`): parse failures (`E_MALFORMED_ANCHOR` has no `servedRows`;
 * the `E_BAD_PAYLOAD`/`E_INTERNAL_INVARIANT` payloads here never set one)
 * and foreign aggregation (`foreignRejection` drops leased rows, passing only
 * never-served codes). Rows without a recorder throw `TypeError`, never skip.
 */
export async function throwBatchRejection(args: {
  failures: BatchFailure[];
  total: number;
  path: string;
  record?: BatchRejectionRecorder;
}): Promise<never> {
  const { failures, total, path, record } = args;
  if (record === undefined) {
    for (const failure of failures) {
      const rows = failure.error instanceof DomainError ? failure.error.servedRows : [];
      if (rows.length > 0) {
        throw new TypeError(
          `throwBatchRejection: failure at index ${failure.index} carries ${rows.length} ` +
            "served row(s) but no recorder context was supplied — a rejection that shows rows " +
            "must record them (reject-and-serve). Supply record or route through a context-carrying site.",
        );
      }
    }
  } else {
    for (const failure of failures) {
      if (failure.error instanceof DomainError) {
        await recordRejectionServe({ error: failure.error, ...record });
      }
    }
  }
  if (total === 1) {
    throw failures[0]!.error;
  }
  throw batchAbort({ failures, total, path });
}
