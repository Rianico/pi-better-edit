import { denseServeRows, type ServedRow } from "./hashline/served.js";
import { genDiff } from "./edit-diff.js";
import { visLines, clipLine } from "./utils.js";
import { isDomainErrorCode } from "./domain-errors.js";
import { attachEnvelope, rawCodeOf, readEnvelope, type ErrorEnvelope } from "./error-envelope.js";
import { snapshotHashFor } from "./snapshot-store";
import type { ProcessedEditFile } from "./mutation-engine/types.js";

export type EditDetails = {
  path?: string;
  diff: string;
  firstChangedLine?: number;
  lastChangedLine?: number;
  resultLineCount?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
  servedRows?: ServedRow[];
  servedByPath?: Array<{
    path: string;
    servedRows: ServedRow[];
    /** Committed `file_snapshots.snapshot_hash` of this path's served content. */
    contentHash: string;
    resultLineCount?: number;
    firstChangedLine?: number;
    lastChangedLine?: number;
  }>;
  /** Committed `file_snapshots.snapshot_hash` of the single served file, when only one was served. */
  contentHash?: string;
  warnings?: string[];
  driftNotice?: string;
};
type TResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: EditDetails;
};

export type RMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  classification: "applied" | "noop";
  changed_lines?: { first: number; last: number };
  added_lines?: number;
  removed_lines?: number;
  literalDeclarations?: number;
};

type RMeta = {
  editsAttempted: number;
  noopEditsCount: number;
  firstChangedLine?: number;
  lastChangedLine?: number;
  addedLines: number;
  removedLines: number;
};

type NEditEntry = {
  loc: string;
  currentContent: string;
};

export interface NoopInput {
  path: string;
  noopEdit: NEditEntry | undefined;
  snapshotId?: string;
  editMeta: RMeta;
  warnings: string[] | undefined;
  driftNotice?: string;
}

export interface SuccessInput {
  path: string;
  originalNormalized: string;
  originalHashes: string[];
  result: string;
  resultHashes: string[];
  /** Committed `file_snapshots.snapshot_hash` of `result`. */
  contentHash: string;
  warnings: string[] | undefined;
  snapshotId?: string;
  editMeta: RMeta;
  driftNotice?: string;
}

export function buildMetrics(args: {
  classification: "applied" | "noop";
  editsAttempted: number;
  noopEditsCount: number;
  warningsCount: number;
  firstChangedLine?: number;
  lastChangedLine?: number;
  addedLines?: number;
  removedLines?: number;
  literalDeclarations?: number;
}): RMetrics {
  const metrics: RMetrics = {
    edits_attempted: args.editsAttempted,
    edits_noop: args.noopEditsCount,
    warnings: args.warningsCount,
    classification: args.classification,
  };
  if (
    args.classification === "applied" &&
    args.firstChangedLine !== undefined &&
    args.lastChangedLine !== undefined
  ) {
    metrics.changed_lines = {
      first: args.firstChangedLine,
      last: args.lastChangedLine,
    };
  }
  if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
  if (args.removedLines !== undefined) metrics.removed_lines = args.removedLines;
  if (args.literalDeclarations !== undefined && args.literalDeclarations > 0)
    metrics.literalDeclarations = args.literalDeclarations;
  return metrics;
}

export interface FinalizeInput {
  diff: string;
  warnings?: string[];
  driftNotice?: string;
}

export function finalizeResult(input: FinalizeInput): string {
  const base = input.diff + warnBlock(input.warnings);
  return base;
}

export function finalizeToolResult(details: EditDetails): {
  content: Array<{ type: "text"; text: string }>;
  servedRows: ServedRow[] | undefined;
} {
  const text = finalizeResult({
    diff: details.diff,
    warnings: details.warnings,
    driftNotice: details.driftNotice,
  });
  return { content: [{ type: "text", text }], servedRows: details.servedRows };
}

function warnBlock(warnings: string[] | undefined): string {
  return warnings?.length ? `\n\n${warnings.join("\n")}` : "";
}

export function buildNoop(input: NoopInput): TResult {
  const { path, noopEdit, snapshotId, editMeta, warnings, driftNotice } = input;

  const noopDetailsText = noopEdit
    ? `Edit for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
    : "The edit produced identical content.";
  const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warnBlock(warnings)}`;

  const metrics = buildMetrics({
    classification: "noop",
    editsAttempted: editMeta.editsAttempted,
    noopEditsCount: editMeta.noopEditsCount,
    warningsCount: warnings?.length ?? 0,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      path,
      diff: "",
      firstChangedLine: undefined,
      snapshotId,
      classification: "noop" as const,
      metrics,
      ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
      ...(driftNotice !== undefined ? { driftNotice } : {}),
    },
  };
}

export function buildChanged(input: SuccessInput): TResult {
  const {
    path,
    result,
    warnings,
    snapshotId,
    contentHash,
    originalNormalized,
    originalHashes,
    editMeta,
    resultHashes,
    driftNotice,
  } = input;
  const resultLines = visLines(result);
  const diffResult = genDiff(originalNormalized, result, 1, resultHashes, originalHashes);
  const addedLines = editMeta.addedLines;
  const removedLines = editMeta.removedLines;
  const warningsBlock = warnBlock(warnings);
  const successPrefix = `Successfully edited in ${path}.`;
  const lineSummary =
    addedLines > 0 || removedLines > 0
      ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
      : "";
  const text =
    resultLines.length === 0
      ? "File is empty. Use edit to insert content."
      : warningsBlock
        ? `${successPrefix}${lineSummary}${warningsBlock}`
        : `${successPrefix}${lineSummary}`;

  const metrics = buildMetrics({
    classification: "applied",
    editsAttempted: editMeta.editsAttempted,
    noopEditsCount: editMeta.noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    firstChangedLine: editMeta.firstChangedLine,
    lastChangedLine: editMeta.lastChangedLine,
    addedLines,
    removedLines,
  });
  const denseServedRows = denseServeRows(resultHashes);

  return {
    content: [{ type: "text", text }],
    details: {
      path,
      diff: diffResult.diff,
      firstChangedLine: editMeta.firstChangedLine ?? diffResult.firstChangedLine,
      lastChangedLine: editMeta.lastChangedLine ?? diffResult.lastChangedLine,
      resultLineCount: resultLines.length,
      snapshotId,
      metrics,
      ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
      servedRows: denseServedRows,
      contentHash,
      ...(driftNotice !== undefined ? { driftNotice } : {}),
    },
  };
}

export type BatchSection = {
  path: string;
  originalNormalized: string;
  result: string;
  originalHashes: string[];
  resultHashes: string[];
  /** Committed `file_snapshots.snapshot_hash` of `result` — the served content's identity. */
  resultHash: string;
  warnings: string[] | undefined;
  driftNotice: string | undefined;
  appliedCount: number;
  noopCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  literalDeclarations?: number;
  /**
   * WHY: the commit path (`apply`) already renders this section's diff to derive the mirror's
   * WHY: `firstChangedLine`; carrying it here keeps genDiff at one render per commit — the
   * WHY: model-visible text and `servedByPath.firstChangedLine` come from that same render.
   */
  renderedDiff?: {
    diff: string;
    firstChangedLine: number | undefined;
    lastChangedLine: number | undefined;
  };
};

type _BatchDetails = EditDetails;

export function buildBatchResult(sections: BatchSection[]): TResult {
  const totalEdits = sections.reduce((n, s) => n + s.appliedCount + s.noopCount, 0);
  const appliedFiles = sections.filter((s) => s.appliedCount > 0);
  const appliedTotal = appliedFiles.reduce((n, s) => n + s.appliedCount, 0);
  const noopTotal = sections.reduce((n, s) => n + s.noopCount, 0);
  const addedLines = sections.reduce((n, s) => n + s.totalAddedLines, 0);
  const removedLines = sections.reduce((n, s) => n + s.totalRemovedLines, 0);
  const literalDeclarations = sections.reduce((n, s) => n + (s.literalDeclarations ?? 0), 0);
  const allNoop = appliedTotal === 0;
  const warnings = sections.flatMap((s) => s.warnings ?? []);
  const driftNotice = sections
    .map((s) => s.driftNotice)
    .filter((d): d is string => d !== undefined)
    .join("\n\n");

  if (allNoop) {
    const text = `No changes made. All ${totalEdits} edit(s) in the call produced identical content.\nClassification: noop${warnBlock(warnings)}`;
    return {
      content: [{ type: "text", text }],
      details: {
        diff: "",
        classification: "noop" as const,
        metrics: buildMetrics({
          classification: "noop",
          editsAttempted: totalEdits,
          noopEditsCount: noopTotal,
          warningsCount: warnings.length,
          ...(literalDeclarations > 0 ? { literalDeclarations } : {}),
        }),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(driftNotice !== undefined ? { driftNotice } : {}),
      },
    };
  }

  const servedByPath: Array<{
    path: string;
    servedRows: ServedRow[];
    contentHash: string;
    resultLineCount?: number;
    firstChangedLine?: number;
    lastChangedLine?: number;
  }> = [];
  const diffParts: string[] = [];
  for (const s of appliedFiles) {
    const diffResult =
      s.renderedDiff ??
      genDiff(s.originalNormalized, s.result, 1, s.resultHashes, s.originalHashes);
    diffParts.push(`--- ${s.path} ---\n${diffResult.diff}`);
    // WHY: dense rows for the batch serve record — position and hash only; canon evidence is
    // WHY: derived from the leases the record grants (#151).
    const denseRows = denseServeRows(s.resultHashes);
    if (denseRows.length > 0) {
      servedByPath.push({
        path: s.path,
        servedRows: denseRows,
        contentHash: s.resultHash,
        resultLineCount: visLines(s.result).length,
        firstChangedLine: diffResult.firstChangedLine,
        lastChangedLine: diffResult.lastChangedLine,
      });
    }
  }
  const diff = diffParts.join("\n\n");

  const lineSummary =
    addedLines > 0 || removedLines > 0
      ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
      : "";
  const summary = `Successfully edited ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`;
  const text = `${summary}${warnBlock(warnings)}`;

  return {
    content: [{ type: "text", text }],
    details: {
      diff,
      metrics: buildMetrics({
        classification: "applied",
        editsAttempted: totalEdits,
        noopEditsCount: noopTotal,
        warningsCount: warnings.length,
        addedLines,
        removedLines,
        ...(literalDeclarations > 0 ? { literalDeclarations } : {}),
      }),
      ...(warnings.length > 0 ? { warnings } : {}),
      servedRows: servedByPath.flatMap((e) => e.servedRows),
      servedByPath,
      ...(appliedFiles.length === 1 ? { contentHash: appliedFiles[0]!.resultHash } : {}),
      ...(driftNotice !== undefined ? { driftNotice } : {}),
    },
  };
}

/**
 * The atomicity trailer every rejected item of a multi-item call carries (spec §3.2.3). The call is
 * all-or-nothing, so the model must know that the items before the failing one were rolled back too.
 */
const BATCH_ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

/**
 * Strips a leading audience tag so a wrapped rejection carries exactly one `[MODEL]` marker.
 * The inner diagnostic already names its own code; the outer wrapper owns the single prefix.
 */
function stripModelPrefix(message: string): string {
  return message.startsWith("[MODEL] ") ? message.slice("[MODEL] ".length) : message;
}

/**
 * Wraps a rejected item of a multi-item call for the model. Shared by the pre-mutation span gate and
 * the sequential mutate loop, so an item that fails either way reads identically: the failing item,
 * its own diagnostic, and the reject-and-serve rows of the range the model retries from.
 *
 * The item's OWN error code is propagated untouched — `[E_BATCH_ABORT]` is reserved for overlapping
 * or nested spans, so a malformed anchor or a failed apply reads as the code the model can act on
 * (`[E_MALFORMED_ANCHOR]`, `[E_STALE_RANGE]`, …), with the atomicity trailer instead of a relabel.
 */
export function batchAbortFor(args: { error: Error; index: number; path: string }): Error {
  const { error, index, path } = args;
  // WHY: the inner rejection already carries its own reject-and-serve rows under `Current range:`,
  // WHY: so the wrapper must not render them a second time — one serve block per rejection.
  // WHY: the inner `details.cause` (user-facing diagnosis) is preserved on the wrapper so a
  // WHY: batched failure still emits it.
  // WHY: the failing edit's pre-rendered serve block is forwarded too (spec D2): an atomic
  // WHY: batch abort must preserve the serve block or the retry owes a re-read.
  const wrapped = new Error(
    `[MODEL] edit[${index}] (${path}) failed: ${stripModelPrefix(error.message)}\n` +
      `${BATCH_ATOMICITY_TRAILER} Fix the failing edit (and any later edit that depends on it), then resubmit.`,
  );
  // WHY: the whole forwarded payload moves through the envelope reader/writer pair
  // WHY: (src/error-envelope.ts) — the wrapper stamps exactly the validated slots the
  // WHY: inner rejection carries: code, cause (with its `details` projection), rows, block.
  attachEnvelope(wrapped, readEnvelope(error) ?? {});
  return wrapped;
}
/**
 * Wraps MULTIPLE rejected items of a multi-item call for the model. Sibling of `batchAbortFor`:
 * one aggregated rejection with one bullet per failing item (`- edit[1]: …`) so a single
 * resubmission can fix them all instead of burning one turn per failure. The batch is still
 * all-or-nothing — the atomicity trailer is identical — and each item keeps its own diagnostic
 * (and code) inline, so the model can act on every failure without a re-read.
 *
 * Field aggregation (spec D2 — the envelope must stay actionable):
 * - `code`: every item keeps its own `[E_*]` inline in the message; the envelope carries the
 *   first item's domain code so `toFailure` still routes the typed path (and keeps this full
 *   message) instead of rewriting it as `E_UNKNOWN`.
 * - `details`/`cause`: carried only when every failing item agrees on one diagnosis; a mixed
 *   batch states each cause inline instead of promoting one.
 * - `servedRows`: the union of every failing item's rows (each item's retry leases were already
 *   recorded on its own rejection path).
 * - `servedBlock`: every failing item's block, in item order.
 */
export function batchAbortForMany(args: {
  failures: { error: Error; index: number }[];
  path: string;
}): Error {
  const { failures, path } = args;
  const bullets = failures.map(
    ({ error, index }) => `- edit[${index}]: ${stripModelPrefix(error.message)}`,
  );
  const wrapped = new Error(
    `[MODEL] ${failures.length} edits in ${path} failed. The whole edit call was rejected and the file is unchanged.\n` +
      `${bullets.join("\n")}\n` +
      `${BATCH_ATOMICITY_TRAILER} Fix the failing edits (and any later edits that depend on them), then resubmit.`,
  );
  const envelopes = failures.map((f) => readEnvelope(f.error) ?? {});
  // WHY: promotion keys off the FIRST item's raw string code — registry member or not —
  // WHY: so a non-registry head code suppresses the typed route instead of letting a
  // WHY: later item's code promote (the aggregation rule `toFailure`'s routing depends on).
  const firstCode = failures.map((f) => rawCodeOf(f.error)).find((code) => code !== undefined);
  const envelope: ErrorEnvelope = {};
  if (firstCode !== undefined && isDomainErrorCode(firstCode)) {
    envelope.code = firstCode;
  }
  const causes = envelopes.map((env) => env.cause);
  const firstCause = causes[0];
  if (firstCause !== undefined && causes.every((cause) => cause === firstCause)) {
    envelope.cause = firstCause;
  }
  const servedRows: ServedRow[] = [];
  for (const env of envelopes) {
    if (env.servedRows !== undefined) servedRows.push(...env.servedRows);
  }
  if (servedRows.length > 0) {
    envelope.servedRows = servedRows;
  }
  const blocks = envelopes
    .map((env) => env.servedBlock)
    .filter((block): block is string => block !== undefined);
  if (blocks.length > 0) {
    envelope.servedBlock = blocks.join("\n");
  }
  attachEnvelope(wrapped, envelope);
  return wrapped;
}

/**
 * Wraps one malformed payload item of a multi-item call for the model. Single-failure arm of
 * `parseEdits` — the envelope reads exactly as before; multi-failure batches route to
 * `batchAbortForMany` instead so every malformed item is reported together.
 */
export function wrapParseFailure(error: Error, index: number, path: string): Error {
  // WHY: a payload malformation keeps its own code (`[E_MALFORMED_ANCHOR]`, `[E_BAD_PAYLOAD]`, …) — the
  // WHY: atomicity trailer explains the rolled-back siblings without misdirecting the model to
  // WHY: hunt for coordinate overlap.
  const wrapped = new Error(
    `[MODEL] edit[${index}] (${path}) failed: ${stripModelPrefix(error.message)}\n${BATCH_ATOMICITY_TRAILER}`,
  );
  // WHY: the wrapper carries the inner code and diagnosis through the envelope pair so the
  // WHY: failure envelope keeps the code the model can act on. A parse failure carries no
  // WHY: rows or block — only the two diagnostic slots are forwarded here.
  const { code, cause } = readEnvelope(error) ?? {};
  attachEnvelope(wrapped, { code, cause });
  return wrapped;
}

/** The batch-result section for one processed file — the pipeline's fact mapped to the model envelope. */
export function toSection(
  file: ProcessedEditFile,
  renderedDiff?: BatchSection["renderedDiff"],
): BatchSection {
  return {
    path: file.path,
    originalNormalized: file.originalNormalized,
    result: file.result,
    originalHashes: file.originalHashes,
    resultHashes: file.resultHashes,
    resultHash: snapshotHashFor(file.result),
    warnings: file.warnings,
    driftNotice: file.driftNotice,
    appliedCount: file.appliedCount,
    noopCount: file.noopCount,
    totalAddedLines: file.totalAddedLines,
    totalRemovedLines: file.totalRemovedLines,
    ...(file.literalDeclarations > 0 ? { literalDeclarations: file.literalDeclarations } : {}),
    ...(renderedDiff !== undefined ? { renderedDiff } : {}),
  };
}
