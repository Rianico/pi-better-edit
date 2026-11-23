/**
 * SAFETY: Batch span-gate owner — baseline (`S_curr`) span resolution, batch
 * disjointness, and the working buffer's `line_id` bookkeeping for the
 * mutation pipeline. Pure pre-mutation gate: the only store touches it
 * performs are reads, plus the reject-and-serve recording the pipeline owns
 * (`recordRejectionServe`, passed in through the context — it stays with the
 * store seam). Vocabulary (GLOSSARY.md): span, served span, reject-and-serve,
 * line identity — preserved.
 */

import { DomainError } from "../domain-errors.js";
import { splitLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import { resolveLeasedEdit, type LeasedEditResolution } from "../hashline/lease-resolve.js";
import { swapReversedRanges, type HEdit, type LeaseSpanSource } from "../hashline/resolve.js";
import type { SpanMode } from "../span-mode-config.js";
import {
  buildRangeServeRows,
  fmtServedRows,
  type ServedRow,
} from "../served-session/serve-render.js";
import { snapshotHashFor, positionsByIdentity } from "../snapshot-store";
import { batchAbortFor, batchAbortForMany } from "../edit-response.js";

function serveRowsForEdit(edit: HEdit, originalHashes: string[]): ServedRow[] | undefined {
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const s = originalHashes.indexOf(startHash);
  const e = originalHashes.indexOf(endHash);
  if (s < 0 || e < 0) return undefined;
  return buildRangeServeRows(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

/**
 * The in-memory working buffer's identity starting point: every line of the loaded content that
 * `line_lineage(content)` already names keeps that `line_id`, and a line no committed snapshot names
 * enters as `null` ("created by this batch"). Built through the same `positionsByIdentity` seam the
 * edit resolution uses, so the identity an edit resolves through and the identity the commit persists
 * can never disagree.
 */
export function workingBufferIds(
  store: HashStore,
  absolutePath: string,
  content: string,
): (number | null)[] {
  const byLine = new Map<number, number>();
  for (const [lineId, lineNumber] of positionsByIdentity(store, absolutePath, content)) {
    byLine.set(lineNumber, lineId);
  }
  const ids: (number | null)[] = Array.from<number | null>({
    length: splitLines(content).length,
  }).fill(null);
  for (const [lineNumber, lineId] of byLine) {
    if (lineNumber >= 1 && lineNumber <= ids.length) ids[lineNumber - 1] = lineId;
  }
  return ids;
}

/**
 * Inverts a working buffer's `line_id` map into the `line_id` -> current-line lookup the lease seam
 * consumes. `null` marks a line the batch created, which carries no identity to resolve yet.
 */
export function identityPositions(currentIds: readonly (number | null)[]): Map<number, number> {
  const positions = new Map<number, number>();
  for (let index = 0; index < currentIds.length; index++) {
    const lineId = currentIds[index];
    if (typeof lineId === "number") positions.set(lineId, index + 1);
  }
  return positions;
}

/**
 * Advances the working buffer's identity map by one edit (spec §3.2.2/§3.2.4): lines outside the
 * resolved range keep the `line_id` the buffer already assigned them, they only shift; the range's
 * replacement lines enter as `null` and are allocated by the commit's single counter upsert.
 */
export function spliceWorkingBufferIds(
  ids: (number | null)[],
  startLine: number,
  endLine: number,
  resultLineCount: number,
): (number | null)[] {
  const replacedLineCount = endLine - startLine + 1;
  const insertedLineCount = Math.max(0, resultLineCount - ids.length + replacedLineCount);
  return [
    ...ids.slice(0, startLine - 1),
    ...Array.from<number | null>({ length: insertedLineCount }).fill(null),
    ...ids.slice(endLine),
  ];
}

interface BaselineSpan {
  index: number;
  startLine: number;
  endLine: number;
}

/** The baseline (`S_curr`) state one batch's spans are resolved against, before anything mutates. */
export interface BaselineSpanContext {
  served: (string | null)[];
  identity: LeaseSpanSource;
  spanMode?: SpanMode;
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  path: string;
  originalHashes: string[];
  originalNormalized: string;
  /**
   * Injected rather than imported: the pipeline owns the store seam a rejection serve records
   * through, so the pre-mutation gate and the sequential mutate loop share one recorder.
   */
  recordRejectionServe: (args: {
    error: DomainError;
    sessionKey: string;
    absolutePath: string;
    isPreview: boolean;
    lineCount: number;
    contentHash: string | undefined;
  }) => Promise<void>;
}

/**
 * Resolves one edit's baseline span (`s'_start .. s'_end`) in the pre-batch snapshot through the same seam the apply path resolves it
 * with (spec §3.2.1): every edit goes through `resolveLeasedEdit`, so its span is the `line_lineage(S_curr)` window of its leased
 * `line_id`s — a duplicate canon resolves through the leased identity, never through the first content occurrence. An anchor this seam
 * cannot place has no comparable baseline coordinate, and the sequential apply rejects that edit anyway, so the batch aborts with that
 * same diagnostic (`[E_STALE_ANCHOR]`, `[E_STALE_RANGE]`) instead of silently dropping the span (a dropped span blinds the overlap gate
 * for every other item in the call).
 *
 * A span-ref MOVE contributes a second baseline span — its retired source — because the source lines are mutated state the overlap gate
 * must see (invariant 5). A copy's source is read, not mutated, so it adds no span.
 * Rejections aggregate in `assertBatchSpansDisjoint`, so this seam records the rows each failing edit owes and rethrows the raw diagnostic — the `edit[i] (path) failed:` envelope lands once, at aggregation.
 */
async function resolveBaselineSpans(
  edit: HEdit,
  index: number,
  ctx: BaselineSpanContext,
): Promise<BaselineSpan[]> {
  const fileLines = splitLines(ctx.originalNormalized);
  const fileHashes = ctx.originalHashes;
  const abort = async (error: unknown): Promise<never> => {
    if (error instanceof DomainError) {
      await ctx.recordRejectionServe({
        error,
        sessionKey: ctx.sessionKey,
        absolutePath: ctx.absolutePath,
        isPreview: ctx.isPreview,
        lineCount: ctx.originalHashes.length,
        contentHash: ctx.isPreview ? undefined : snapshotHashFor(ctx.originalNormalized),
      });
    }
    throw error;
  };
  const spanOf = (leased: LeasedEditResolution): BaselineSpan => {
    const from = leased.resolved.hash_bounds[0].line;
    const to = leased.resolved.hash_bounds[1].line;
    return { index, startLine: Math.min(from, to), endLine: Math.max(from, to) };
  };
  // HACK: dead pre-heal — `resolveLeasedEdit` heals a reversed pair itself and the span below is order-proof via `Math.min`/`Math.max`, so this survives only until the heal-path cleanup pass.
  const fixed = swapReversedRanges(edit, fileHashes, []);
  let leased: LeasedEditResolution;
  try {
    leased = resolveLeasedEdit({
      edit: fixed,
      snapshot: { fileHashes, fileLines, filePath: ctx.path },
      served: ctx.served,
      source: ctx.identity,
      ...(ctx.spanMode !== undefined ? { spanMode: ctx.spanMode } : {}),
    });
  } catch (error) {
    return abort(error);
  }
  const spans = [spanOf(leased)];
  if (edit.source?.retire) {
    const sourceEdit: HEdit = { content_lines: [], hash_bounds: edit.source.bounds };
    let leasedSource: LeasedEditResolution;
    try {
      leasedSource = resolveLeasedEdit({
        edit: sourceEdit,
        snapshot: { fileHashes, fileLines, filePath: ctx.path },
        served: ctx.served,
        source: ctx.identity,
        ...(ctx.spanMode !== undefined ? { spanMode: ctx.spanMode } : {}),
      });
    } catch (error) {
      return abort(error);
    }
    spans.push(spanOf(leasedSource));
  }
  return spans;
}

/**
 * Overlapping or nested spans in one `edits[]` array reject the entire batch before the first
 * mutation (spec §3.2.3): the preceding-delta working buffer is only well-defined for spans that are
 * strictly ordered, so a batch that would edit one line twice is a model error, not a merge.
 *
 * Validation aggregates instead of failing fast, since every item resolves against the same pure
 * pre-batch snapshot: one failing edit cannot mask another, and invalid anchors leave no coordinates
 * to compare, so validation rejections throw before the overlap scan. A move's target and its retired
 * source are one item, never a batch conflict — `applyEdit` refuses that overlap itself
 * (`E_BAD_PAYLOAD`) and the four touching spellings stay legal noops (ticket-02b P1-B) — and the
 * abort still serves the rejected rows, like the sequential abort, so a retry needs no re-read.
 */
export async function assertBatchSpansDisjoint(
  edits: HEdit[],
  ctx: BaselineSpanContext,
): Promise<void> {
  if (edits.length < 2) return;
  const spans: BaselineSpan[] = [];
  const failures: { error: DomainError; index: number }[] = [];
  for (let index = 0; index < edits.length; index++) {
    try {
      spans.push(...(await resolveBaselineSpans(edits[index]!, index, ctx)));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      failures.push({ error, index });
    }
  }
  if (failures.length === 1) {
    const only = failures[0]!;
    throw batchAbortFor({ error: only.error, index: only.index, path: ctx.path });
  }
  if (failures.length > 1) {
    throw batchAbortForMany({ failures, path: ctx.path });
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a.index === b.index) continue;
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) {
        const originalLines = splitLines(ctx.originalNormalized);
        const rows = serveRowsForEdit(edits[b.index]!, ctx.originalHashes);
        throw new DomainError("E_BATCH_ABORT", {
          earlierIndex: a.index,
          laterIndex: b.index,
          earlierStart: a.startLine,
          earlierEnd: a.endLine,
          laterStart: b.startLine,
          laterEnd: b.endLine,
          path: ctx.path,
          servedBlock: rows === undefined ? "" : fmtServedRows(rows, originalLines),
        });
      }
    }
  }
}
