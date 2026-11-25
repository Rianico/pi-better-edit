import { denseServeRows, type ServedRow } from "./served-session/serve-render.js";
import { visLines, clipLine } from "./utils.js";
import {
  DomainError,
  isDomainErrorCode,
  withPayloadSubject,
  type Audience,
} from "./domain-errors.js";
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
  summary?: string;
  /** A dry run validates and renders the change but commits nothing. */
  dryRun?: boolean;
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
  summary?: string;
  warnings?: string[];
  driftNotice?: string;
}

/**
 * The one composition of the model-visible post-edit text: the summary line, a blank line, then the
 * collapsed anchored diff (#174) and the warnings block. See docs/spec/search-and-read-evolution.md
 * §5 (I4).
 */
function modelText(summary: string, diff: string, warnings: string[] | undefined): string {
  return `${summary}\n\n${diff}${warnBlock(warnings)}`;
}

/**
 * The hook seam's renderer. A details payload carrying the applied summary leads with it (I4); a
 * synthesized payload without one keeps the bare diff + warnings text, unchanged.
 */
export function finalizeResult(input: FinalizeInput): string {
  const body = input.diff + warnBlock(input.warnings);
  if (input.summary === undefined || input.summary === "" || input.diff === "") return body;
  return modelText(input.summary, input.diff, input.warnings);
}

export function finalizeToolResult(details: EditDetails): {
  content: Array<{ type: "text"; text: string }>;
  servedRows?: ServedRow[];
} {
  const text = finalizeResult({
    diff: details.diff,
    ...(details.summary !== undefined ? { summary: details.summary } : {}),
    ...(details.warnings !== undefined ? { warnings: details.warnings } : {}),
    ...(details.driftNotice !== undefined ? { driftNotice: details.driftNotice } : {}),
  });
  return {
    content: [{ type: "text", text }],
    ...(details.servedRows !== undefined ? { servedRows: details.servedRows } : {}),
  };
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
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      classification: "noop" as const,
      metrics,
      ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
      ...(driftNotice !== undefined ? { driftNotice } : {}),
    },
  };
}

export type BatchSection = {
  path: string;
  result: string;
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
   * The one projection of this file's change, supplied by the caller that committed it (#326).
   * Required: this envelope never re-projects, so the rendered rows and their anchors have one
   * source of truth — `toSection` cannot omit it.
   */
  renderedDiff: {
    diff: string;
    firstChangedLine: number | undefined;
    lastChangedLine: number | undefined;
  };
};

/**
 * `isDryRun` publishes no served rows: nothing a dry run shows is addressable, because its anchors
 * describe bytes that were never written, so no lease may be minted from them.
 *
 * `metrics.classification` keeps the live vocabulary ("applied"/"noop"): it names the outcome the
 * bytes WOULD have. `details.dryRun` and the `[DRY RUN]` header mark that nothing was written.
 */
export function buildBatchResult(sections: BatchSection[], isDryRun = false): TResult {
  const totalEdits = sections.reduce((n, s) => n + s.appliedCount + s.noopCount, 0);
  const appliedFiles = sections.filter((s) => s.appliedCount > 0);
  const appliedTotal = appliedFiles.reduce((n, s) => n + s.appliedCount, 0);
  const noopTotal = sections.reduce((n, s) => n + s.noopCount, 0);
  const addedLines = sections.reduce((n, s) => n + s.totalAddedLines, 0);
  const removedLines = sections.reduce((n, s) => n + s.totalRemovedLines, 0);
  const literalDeclarations = sections.reduce((n, s) => n + (s.literalDeclarations ?? 0), 0);
  const allNoop = appliedTotal === 0;
  const warnings = sections.flatMap((s) => s.warnings ?? []);
  const noticeText = sections
    .map((s) => s.driftNotice)
    .filter((d): d is string => d !== undefined)
    .join("\n\n");
  const driftNotice = noticeText.length > 0 ? noticeText : undefined;

  if (allNoop) {
    const text = isDryRun
      ? `[DRY RUN] No changes would be made. All ${totalEdits} edit(s) in the call produce identical content.\nClassification: noop${warnBlock(warnings)}`
      : `No changes made. All ${totalEdits} edit(s) in the call produced identical content.\nClassification: noop${warnBlock(warnings)}`;
    return {
      content: [{ type: "text", text }],
      details: {
        diff: "",
        ...(isDryRun ? { dryRun: true as const } : {}),
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
    const diffResult = s.renderedDiff;
    diffParts.push(`--- ${s.path} ---\n${diffResult.diff}`);
    const denseRows: ServedRow[] = isDryRun ? [] : denseServeRows(s.resultHashes);
    if (denseRows.length > 0) {
      servedByPath.push({
        path: s.path,
        servedRows: denseRows,
        contentHash: s.resultHash,
        resultLineCount: visLines(s.result).length,
        ...(diffResult.firstChangedLine !== undefined
          ? { firstChangedLine: diffResult.firstChangedLine }
          : {}),
        ...(diffResult.lastChangedLine !== undefined
          ? { lastChangedLine: diffResult.lastChangedLine }
          : {}),
      });
    }
  }
  const diff = diffParts.join("\n\n");

  const lineSummary =
    addedLines > 0 || removedLines > 0
      ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
      : "";
  const summary = isDryRun
    ? `[DRY RUN] Validated ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) would be applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`
    : `Successfully edited ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`;
  const text = modelText(summary, diff, warnings);

  return {
    content: [{ type: "text", text }],
    details: {
      diff,
      summary,
      ...(isDryRun ? { dryRun: true as const } : {}),
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
      servedRows: isDryRun ? [] : servedByPath.flatMap((e) => e.servedRows),
      servedByPath: isDryRun ? [] : servedByPath,
      ...(appliedFiles.length === 1 && appliedFiles[0] !== undefined && !isDryRun
        ? { contentHash: appliedFiles[0].resultHash }
        : {}),
      ...(driftNotice !== undefined ? { driftNotice } : {}),
    },
  };
}

/**
/**
 * The one batch-rejection renderer (spec #329 §4–§5 T1, issue #323). Every rejected
 * multi-item call renders through it: a verdict line naming the failing count and the
 * call's item count, then one bullet per failing item carrying that item's own code.
 * Atomicity lives once, in the verdict (`nothing was written`); a bullet owns the item
 * index, the call's `file` value, the code, the diagnosis, and the indented options.
 * The inner error owns its served rows under its own heading — the envelope never
 * re-renders them, it only unions them for the retry path. A 1-item call never reaches
 * here: it throws the bare `[MODEL]`-prefixed diagnosis with the item's own code (D5).
 */
export interface BatchFailure {
  error: Error;
  index: number;
}

/** The failing item's registry audience, read once for the verdict line (T1 adds no rule). */
function batchAudience(failures: BatchFailure[]): Audience {
  for (const { error } of failures) {
    if (error instanceof DomainError) return error.audience;
  }
  return "MODEL";
}

/** The bullet's code token: the item's own registry code, never a promoted header code (D1). */
function bulletCode(error: Error): string {
  const raw = rawCodeOf(error);
  if (raw !== undefined) return raw;
  const match = (error instanceof Error ? error.message : String(error)).match(/\[(E_[A-Z_]+)\]/);
  return match?.[1] ?? "E_UNKNOWN";
}

/**
 * The item's diagnosis for its bullet: the engine renders the refusal before the
 * wrapper sees it, so the message is re-attributed to the `edit` tool, then the
 * audience and code prefixes are stripped — the bullet header owns them — and every
 * continuation line (range headings and rows, the `Options:` line) is indented two
 * spaces so one failure stays one parseable list entry.
 */
function bulletDiagnosis(error: Error): string {
  const attributed = withPayloadSubject(error, "edit");
  const message = attributed instanceof Error ? attributed.message : String(attributed);
  const stripped = message.replace(/^\[(?:MODEL|USER)\] /, "").replace(/^\[(?:E_[A-Z_]+)\] /, "");
  const [first, ...rest] = stripped.split("\n");
  const continuation = rest
    .map((line) => (line === "" || line.startsWith("  ") ? line : `  ${line}`))
    .join("\n");
  return `${first ?? ""}${continuation === "" ? "" : `\n${continuation}`}`;
}

/**
 * Wraps every rejected item of a multi-item call for the model. Single-failure sites
 * pass a one-element `failures` array with the call's item count as `total`.
 * Field aggregation (spec D2 note — the envelope stays actionable): `code` carries the
 * first failing item's domain code so `toFailure` still routes the typed path instead
 * of rewriting it as `E_UNKNOWN`; `cause` is carried only when every failing item
 * agrees on one diagnosis; `servedRows` is the union of every failing item's rows;
 * `servedBlock` joins every failing item's block, in item order.
 */
export function batchAbort(args: { failures: BatchFailure[]; total: number; path: string }): Error {
  const { failures, total, path } = args;
  const audience = batchAudience(failures);
  const noun = total === 1 ? "edit" : "edits";
  const bullets = failures.map(
    ({ error, index }) =>
      `- edit[${index}] (${path}) [${bulletCode(error)}]: ${bulletDiagnosis(error)}`,
  );
  const wrapped = new Error(
    `[${audience}] Batch rejected: ${failures.length} of ${total} ${noun} failed; nothing was written.\n` +
      bullets.join("\n"),
  );
  const envelopes = failures.map((f) => readEnvelope(f.error) ?? {});
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
  if (failures.length === 1 && envelope.code === "E_BAD_PAYLOAD") {
    const only = envelopes[0];
    if (only?.payloadMessage !== undefined) envelope.payloadMessage = only.payloadMessage;
  }
  attachEnvelope(wrapped, envelope);
  return wrapped;
}


/**
 * The batch-result section for one processed file — the pipeline's fact mapped to the model envelope.
 * `renderedDiff` is the projection of that file's change; the caller that committed the bytes owns it,
 * so this mapping never re-renders and the response carries exactly one projection (#326).
 */
export function toSection(
  file: ProcessedEditFile,
  renderedDiff: BatchSection["renderedDiff"],
): BatchSection {
  return {
    path: file.path,
    result: file.result,
    resultHashes: file.resultHashes,
    resultHash: snapshotHashFor(file.result),
    warnings: file.warnings,
    driftNotice: file.driftNotice,
    appliedCount: file.appliedCount,
    noopCount: file.noopCount,
    totalAddedLines: file.totalAddedLines,
    totalRemovedLines: file.totalRemovedLines,
    ...(file.literalDeclarations > 0 ? { literalDeclarations: file.literalDeclarations } : {}),
    renderedDiff,
  };
}
