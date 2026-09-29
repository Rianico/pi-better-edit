/**
 * SAFETY: Batch span-gate owner — baseline (`S_curr`) span resolution, batch
 * disjointness, and the working buffer's `line_id` bookkeeping for the
 * mutation pipeline. Pure pre-mutation gate: the only store touches it
 * performs are reads, plus the reject-and-serve recording the pipeline owns
 * (`recordRejectionServe`, passed in through the context — it stays with the
 * store seam). Vocabulary (CONTEXT.md): span, served span, reject-and-serve,
 * line identity — preserved.
 */

import { DomainError } from "../domain-errors.js";
import { splitLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import {
  resolveLeasedEdit,
  swapReversedRanges,
  type HEdit,
  type LeasedEditResolution,
  type LeaseSpanSource,
} from "../hashline/index.js";
import { buildRangeServeRows, fmtServedRows, type ServedRow } from "../hashline/served.js";
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
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  path: string;
  originalHashes: string[];
  originalNormalized: string;
  /**
   * WHY: the pipeline owns the store seam a rejection serve records through, so the gate
   * WHY: receives the recorder instead of importing it — the pre-mutation gate and the
   * WHY: sequential mutate loop keep sharing one recorder.
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
 * Resolves one edit's baseline span (`s'_start .. s'_end`) in the pre-batch snapshot through the same
 * seam the apply path resolves it with (spec §3.2.1): every edit goes through `resolveLeasedEdit`, so
 * its span is the `line_lineage(S_curr)` window of its leased `line_id`s — a duplicate canon resolves
 * through the leased identity, never through the first content occurrence. An anchor this seam cannot
 * place has no comparable baseline coordinate, and the sequential apply rejects that edit anyway, so
 * the batch aborts with that same diagnostic (`[E_STALE_ANCHOR]`, `[E_STALE_RANGE]`) instead of
 * silently dropping the span (a dropped span blinds the overlap gate for every other item in the
 * call).
 */
async function resolveBaselineSpan(
  edit: HEdit,
  index: number,
  ctx: BaselineSpanContext,
): Promise<BaselineSpan> {
  const fileLines = splitLines(ctx.originalNormalized);
  const fileHashes = ctx.originalHashes;
  // WHY: the span gate aggregates per-item rejections in `assertBatchSpansDisjoint`, so this seam
  // WHY: records the reject-and-serve rows each failing edit owes and rethrows the RAW diagnostic —
  // WHY: the `edit[i] (path) failed:` envelope is applied once at aggregation time. A non-domain
  // WHY: throw is unexpected (not an item failure) and aborts immediately.
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
  // WHY: follow-up — this pre-heal is dead since the lease seam heals a reversed pair
  // WHY: internally (`resolveLeasedEdit` swaps the resolved lines and narrates
  // WHY: `[W_REVERSED_ANCHORS]`), and the measured span below is order-proof via
  // WHY: `Math.min`/`Math.max` either way. Kept (not deleted) pending a cleanup pass
  // WHY: that removes the redundant swap once the heal path is covered.
  const fixed = swapReversedRanges(edit, fileHashes, []);
  let leased: LeasedEditResolution;
  try {
    leased = resolveLeasedEdit({
      edit: fixed,
      snapshot: { fileHashes, fileLines, filePath: ctx.path },
      served: ctx.served,
      source: ctx.identity,
    });
  } catch (error) {
    return abort(error);
  }
  const from = leased.resolved.hash_bounds[0].line;
  const to = leased.resolved.hash_bounds[1].line;
  return { index, startLine: Math.min(from, to), endLine: Math.max(from, to) };
}

/**
 * Overlapping or nested spans in one `edits[]` array reject the entire batch before the first
 * mutation (spec §3.2.3). The preceding-delta working buffer is only well-defined for spans that are
 * strictly ordered, so a batch that would edit one line twice is a model error, not a merge.
 */
export async function assertBatchSpansDisjoint(
  edits: HEdit[],
  ctx: BaselineSpanContext,
): Promise<void> {
  if (edits.length < 2) return;
  const spans: BaselineSpan[] = [];
  // WHY: span validation aggregates instead of failing fast — every item resolves against the same
  // WHY: pre-batch snapshot through a pure seam, so one failing edit cannot mask another and the
  // WHY: model fixes all of them in one resubmission. Each failure's reject-and-serve rows are
  // WHY: already recorded inside `resolveBaselineSpan`; a non-domain throw is unexpected and aborts
  // WHY: immediately. Atomicity is untouched: the gate runs before the first mutation, so an
  // WHY: aggregated rejection still writes zero bytes.
  const failures: { error: DomainError; index: number }[] = [];
  for (let index = 0; index < edits.length; index++) {
    try {
      spans.push(await resolveBaselineSpan(edits[index]!, index, ctx));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      failures.push({ error, index });
    }
  }
  // WHY: anchor failures mask overlap reporting — without valid anchors there are no coordinates
  // WHY: to compare, so validation rejections throw before the overlap scan below.
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
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) {
        // WHY: the rejected batch still owes the model usable anchors (README error-code contract):
        // WHY: the later item's span is served exactly like the sequential anchor-mismatch abort,
        // WHY: so the retry never needs a re-read.
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
