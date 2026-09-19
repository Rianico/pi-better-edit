/**
 * SAFETY: EditPipeline — Strong, in-process atomic mutation seam.
 *
 * Deepened pipeline that hoists the whole edit mutation behind one
 * seam: load → parse → mutate loop → finalize hashes → drift → persist.
 *
 * Phase diagram (ordering is load-bearing — do not reorder without
 * updating drift/undo/serve invariants):
 *
 *   ┌─────────────┐     ┌────────┐     ┌──────────────────┐
 *   │ Admission   │────▶│  Load  │────▶│ Parse & Validate │
 *   │ (edit.ts)   │     │ (IO)   │     │ (resEdit)        │
 *   │ TypeBox +   │     │readNorm│     │ warnings local   │
 *   │ assertReq   │     │+served │     │ no servePolicy    │
 *   └─────────────┘     └───┬────┘     └────────┬─────────┘
 *                           │                   │
 *                   ┌───────▼───────────────────▼───────┐
 *                   │          Mutate Loop              │
 *                   │  for each HEdit:                  │
 *                   │   applyEdit → verifyServedRange   │
 *                   │   ├─ reject: recordRejectionServes+    │
 *                   │   │         batch-abort           │
 *                   │   ├─ noop:  runNoopPolicy         │
 *                   │   └─ applied: lineHashes +        │
 *                   │             track intervals        │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │        Finalize                    │
 *                   │  dense lineHashes (if applied)    │
 *                   │  hadUtf8 warning                  │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │         Drift                     │
 *                   │  scanDrift over edited intervals  │
 *                   │  union gap caveat: disjoint batch │
 *                   │  edits use union [minStart,       │
 *                   │  maxEnd]; gap lines are treated   │
 *                   │  as edited (not drift). For       │
 *                   │  accurate gap-drift use single-   │
 *                   │  edit calls (documented norm).    │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │        Persist (live only)        │
 *                   │  saveUndo → writeAtomic           │
 *                   │  on write failure: restore undo   │
 *                   └───────────────┬───────────────────┘
 *                                   │
 *                   ┌───────────────▼───────────────────┐
 *                   │         Serve (live only)         │
 *                   │  recordDiffServes (dense)         │
 *                   │  rejection serves already recorded on  │
 *                   │  reject path                      │
 *                   └───────────────────────────────────┘
 *
 * Atomic guarantee: if any mutate step throws (anchor/served/noop-loop)
 * persist is skipped and the file is unchanged. Warnings are owned
 * locally — not passed by ref across modules. servePolicy string is
 * internal (live vs preview) and not exposed.
 *
 * Drift is interval-aware: pipeline tracks per-edit ResolvedRange[]
 * (editedIntervals) and Drift scans per-interval (not union). Gaps
 * between disjoint edits are correctly reported as drift; no
 * Batch drift note warning is emitted. Per-interval deltaBefore
 * maps served positions to current positions.
 *
 * Vocabulary (CONTEXT.md): range, span, served span, drift, drift
 * notice, reject-and-serve, payload contract — preserved.
 */

import { constants } from "node:fs";
import type { LineEnding } from "../edit-diff.js";
import { genDiff, restoreEndings } from "../edit-diff.js";
import { readNormFile } from "../file-reader.js";
import { abortIf, splitLines, visLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import { loadHashStore } from "../hash-store.js";
import { snapshotIOFor, upsertSnapshotFor } from "../snapshot-store";
import {
  applyEdit,
  MAX_HASH_LINES,
  resEdit,
  resolveLeasedEdit,
  swapReversedRanges,
  buildNeverServedEditHint,
  type HEdit,
  type LeasedEditResolution,
  type LeaseSpanSource,
  type NEdit,
} from "../hashline/index.js";
import { defaultHashIdentity, lineHashes } from "../hashline/hash-identity.js";
import {
  AnchorMismatchError,
  ServedRejectionError,
  buildRangeServeRows,
  fmtServedRows,
  type ResolvedRange,
  type ServedRow,
} from "../hashline/served.js";
import {
  createSessionHandle,
  sessionKeyFor,
  loadLeases,
  type ServedLease,
} from "../served-session/session.js";
import { snapshotHashFor, positionsByIdentity } from "../snapshot-store";
import { scanDrift } from "../drift.js";
import { clearNoopLoop, runNoopPolicy } from "../noop-guard.js";
import { clearServedRefusals } from "../hashline/served-guard.js";
import { saveUndo } from "../edit-undo.js";
import { resolveTarget, writeAtomic } from "../fs-write.js";
import { toCwd } from "../paths.js";
import type { NormalizedEditRequest } from "../payload-contract.js";
import { buildBatchResult, type BatchSection } from "../edit-response.js";
import { DEFERRED_STORE_SYNC_WARNING } from "../constants.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

function collectRemovedHashes(edit: HEdit, originalHashes: string[]): Set<string> {
  const removedHashes = new Set<string>();
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const startLine = originalHashes.indexOf(startHash);
  const endLine = originalHashes.indexOf(endHash);
  if (startLine >= 0 && endLine >= 0) {
    const firstLine = Math.min(startLine, endLine);
    const lastLine = Math.max(startLine, endLine);
    for (let i = firstLine; i <= lastLine; i++) {
      removedHashes.add(originalHashes[i]!);
    }
  }
  return removedHashes;
}

function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  let totalRemovedLines = 0;
  const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
  const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
  if (startLine >= 0 && endLine >= 0) {
    totalRemovedLines = Math.abs(endLine - startLine) + 1;
  }
  return {
    totalAddedLines: isNoop ? 0 : edit.content_lines.length,
    totalRemovedLines,
  };
}

function serveRowsForEdit(edit: HEdit, originalHashes: string[]): ServedRow[] | undefined {
  const startHash = edit.hash_bounds[0].hash;
  const endHash = edit.hash_bounds[1].hash;
  const s = originalHashes.indexOf(startHash);
  const e = originalHashes.indexOf(endHash);
  if (s < 0 || e < 0) return undefined;
  return buildRangeServeRows(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

interface EditFileSource {
  path: string;
  cwd: string;
  signal?: AbortSignal;
  accessMode?: number;
  sessionKey: string;
  store?: HashStore;
  noPersist?: boolean;
}

interface LoadedEditFile {
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
  absolutePath: string;
  served: (string | null)[];
  tombstone: ReadonlySet<string>;
  servedCanons: (string | null)[];
}

async function loadEditFile(source: EditFileSource): Promise<LoadedEditFile> {
  const { normalized, bom, originalEnding, fileHashes, hadUtf8DecodeErrors, absolutePath } =
    await readNormFile(source.path, source.cwd, {
      signal: source.signal,
      accessMode: source.accessMode,
      maxLines: MAX_HASH_LINES,
      store: source.store,
      noPersist: source.noPersist,
    });
  const served = await createSessionHandle(source.sessionKey, absolutePath).load();
  let tombstone: ReadonlySet<string> = new Set();
  let servedCanons: (string | null)[] = [];
  try {
    const handle = createSessionHandle(source.sessionKey, absolutePath, source.store);
    try {
      tombstone = await handle.loadTombstone();
    } catch (error) {
      console.error("Failed to load legacy tombstone for edit:", error);
      tombstone = new Set<string>();
    }
    try {
      servedCanons = await handle.loadCanons();
    } catch (error) {
      console.error("Failed to load served canons for edit:", error);
      servedCanons = [];
    }
  } catch (error) {
    console.error("Failed to load served state for edit:", error);
  }
  return {
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors,
    absolutePath,
    served,
    tombstone,
    servedCanons,
  };
}

interface ApplyOneEditInput {
  content: string;
  hashes: string[];
  edit: HEdit;
  signal?: AbortSignal;
  filePath: string;
  served: (string | null)[];
  tombstone?: ReadonlySet<string>;
  servedCanons?: (string | null)[];
  sessionKey: string;
  absolutePath: string;
  store: HashStore;
  isPreview: boolean;
  mode?: "general" | "literal";
  /**
   * The working buffer's own `line_id` map (spec §3.2.4 step 1), entry `i` naming line `i + 1`.
   * Present for a live batch: identity resolution reads it directly instead of re-deriving positions
   * by pairing the intermediate buffer against `S_latest`, which cannot tell two byte-identical lines
   * apart. Absent for preview, where no identity map is in flight.
   */
  currentIds?: (number | null)[];
  onRejected: (error: AnchorMismatchError | ServedRejectionError) => Promise<never>;
}

type ApplyOneEditOutcome =
  | {
      kind: "applied";
      content: string;
      hashes: string[];
      removedHashes: Set<string>;
      range: ResolvedRange;
      firstChangedLine: number | undefined;
      lastChangedLine: number | undefined;
      anchorWarnings: string[] | undefined;
      literalBypass: boolean;
      neverServedCount: number;
    }
  | {
      kind: "noop";
      range: ResolvedRange;
      noopEdit: NEdit | undefined;
      anchorWarnings: string[] | undefined;
      literalBypass: boolean;
      neverServedCount: number;
    };

/**
 * Builds the read-only lease identity source for one edit (spec §3.1.1). Leases come straight from
 * `served_leases`; the `line_id` -> current-line map comes from the working buffer's own identity map
 * when one is in flight (a chained batch edit), else from `line_lineage(C)` when the edit load path
 * materialized C, else from an in-memory `pairSnapshots(S_latest, content)` for preview. Nothing is
 * written: the edit path never re-stamps a lease.
 */
function leaseSpanSource(input: {
  store: HashStore;
  sessionKey: string;
  absolutePath: string;
  content: string;
  currentIds?: (number | null)[];
}): LeaseSpanSource {
  const byAnchor = new Map<string, ServedLease>();
  for (const lease of loadLeases(input.store, input.sessionKey, input.absolutePath)) {
    byAnchor.set(lease.anchor, lease);
  }
  const positions = input.currentIds
    ? identityPositions(input.currentIds)
    : positionsByIdentity(input.store, input.absolutePath, input.content);
  return {
    currentSnapshotHash: snapshotHashFor(input.content),
    leaseFor: (anchor) => {
      const lease = byAnchor.get(anchor);
      if (!lease) return undefined;
      return {
        lineId: lease.line_id,
        canonHash: lease.canon_hash,
        servedSnapshotHash: lease.served_snapshot_hash,
        servedLineNumber: lease.served_line_number,
        retiredAt: lease.retired_at,
      };
    },
    rebasedLineOf: (lineId) => positions.get(lineId),
  };
}

async function applyOneEdit(input: ApplyOneEditInput): Promise<ApplyOneEditOutcome> {
  abortIf(input.signal);

  const identity = leaseSpanSource({
    store: input.store,
    sessionKey: input.sessionKey,
    absolutePath: input.absolutePath,
    content: input.content,
    currentIds: input.currentIds,
  });

  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(input.content, input.edit, input.signal, input.hashes, {
      filePath: input.filePath,
      absolutePath: input.absolutePath,
      served: input.served,
      ...(input.tombstone !== undefined ? { tombstone: input.tombstone } : {}),
      ...(input.servedCanons !== undefined ? { servedCanons: input.servedCanons } : {}),
      identity,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    });
  } catch (error) {
    if (error instanceof AnchorMismatchError || error instanceof ServedRejectionError) {
      await recordRejectionServe({
        error,
        sessionKey: input.sessionKey,
        absolutePath: input.absolutePath,
        isPreview: input.isPreview,
        lineCount: input.hashes.length,
        contentHash: input.isPreview ? undefined : snapshotHashFor(input.content),
      });
      return input.onRejected(error);
    }
    throw error;
  }

  const anchorWarnings = anchorResult.warnings;
  const nextContent = anchorResult.content;
  const literalBypass = anchorResult.literalBypass === true;
  const neverServedCount = anchorResult.neverServedCount ?? 0;
  if (nextContent === input.content) {
    return {
      kind: "noop",
      range: anchorResult.range,
      noopEdit: anchorResult.noopEdit,
      anchorWarnings,
      literalBypass,
      neverServedCount,
    };
  }

  if (!input.hashes || input.hashes.length === 0)
    throw new Error(
      "[MODEL] [E_STALE_ANCHOR] missing previous hashes for stable anchoring. Re-read the full file and copy fresh 3-char anchors (before │), then retry.",
    );
  const removedHashes = collectRemovedHashes(input.edit, input.hashes);
  const nextHashes = await defaultHashIdentity.hashesFor(nextContent, {
    path: input.absolutePath,
    prior: { content: input.content, hashes: input.hashes, removedHashes },
    // WHY: the working buffer is strictly in-memory (spec §3.2.4): no snapshot is written and no
    // WHY: lease is retired until the batch commits S_final to disk. Persisting here made a batch
    // WHY: that wrote nothing retire every anchor the session still validly held.
    persist: false,
    snapshotIO: snapshotIOFor(input.store),
    // SAFETY: tombstone passed as ReadonlySet via unknown for HashIdentity compatibility — input.tombstone is already typed, cast preserves immutability
    tombstone: input.tombstone as unknown as ReadonlySet<string> | undefined,
  } as unknown as Parameters<typeof defaultHashIdentity.hashesFor>[1]);
  return {
    kind: "applied",
    content: nextContent,
    hashes: nextHashes,
    removedHashes,
    range: anchorResult.range,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    anchorWarnings,
    literalBypass,
    neverServedCount,
  };
}

import type { PipelineOptions, ProcessedEditFile } from "./types.js";
export type { PipelineOptions, ProcessedEditFile };

/**
 * The in-memory working buffer's identity starting point: every line of the loaded content that
 * `line_lineage(content)` already names keeps that `line_id`, and a line no committed snapshot names
 * enters as `null` ("created by this batch"). Built through the same `positionsByIdentity` seam the
 * edit resolution uses, so the identity an edit resolves through and the identity the commit persists
 * can never disagree.
 */
function workingBufferIds(
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
function identityPositions(currentIds: readonly (number | null)[]): Map<number, number> {
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
function spliceWorkingBufferIds(
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
interface BaselineSpanContext {
  served: (string | null)[];
  identity: LeaseSpanSource;
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  path: string;
  originalHashes: string[];
  originalNormalized: string;
}

/**
 * Records the reject-and-serve rows a rejected edit owes the model, so the anchors it serves are
 * usable without a re-read (README reject-and-serve contract). The pre-mutation span gate and the
 * sequential mutate loop share it, so a rejection records the same serves whichever one catches it.
 */
async function recordRejectionServe(args: {
  error: AnchorMismatchError | ServedRejectionError;
  sessionKey: string;
  absolutePath: string;
  isPreview: boolean;
  lineCount: number;
  contentHash: string | undefined;
}): Promise<void> {
  // WHY: a target-lost rejection carries no rows (seam oracle pins `servedRows: []`), so there is
  // WHY: nothing to lease — an accidental retry cannot write. Every window that identifies the
  // WHY: model's range still leases through the rows below. The length check alone owns the
  // WHY: skip: no code branch is needed because the oracle proves the payload invariant.
  if (args.error.servedRows.length === 0) return;
  const handle = createSessionHandle(args.sessionKey, args.absolutePath);
  if (args.isPreview) {
    await handle.recordServeFeedback(args.error.servedRows, "preview", args.lineCount);
    return;
  }
  await handle.recordServeFeedback(args.error.servedRows, "live", args.lineCount, args.contentHash);
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
 * The reject-and-serve block for the overlap gate. It renders the current range once with the
 * shared `Current range:` contract, so a batched rejection never repeats the served rows.
 */
function batchAbortServeBlock(args: {
  rows: ServedRow[] | undefined;
  originalNormalized: string;
}): string {
  return args.rows
    ? ` Current range:\n${fmtServedRows(args.rows, splitLines(args.originalNormalized))}`
    : " Call read() to get fresh anchors.";
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
function batchAbortFor(args: { error: Error; index: number; path: string }): Error {
  const { error, index, path } = args;
  // WHY: the inner rejection already carries its own reject-and-serve rows under `Current range:`,
  // WHY: so the wrapper must not render them a second time — one serve block per rejection.
  return new Error(
    `[MODEL] edit[${index}] (${path}) failed: ${stripModelPrefix(error.message)}\n` +
      `${BATCH_ATOMICITY_TRAILER} Fix the failing edit (and any later edit that depends on it), then resubmit.`,
  );
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
  const abort = async (error: unknown): Promise<never> => {
    if (error instanceof AnchorMismatchError || error instanceof ServedRejectionError) {
      await recordRejectionServe({
        error,
        sessionKey: ctx.sessionKey,
        absolutePath: ctx.absolutePath,
        isPreview: ctx.isPreview,
        lineCount: ctx.originalHashes.length,
        contentHash: ctx.isPreview ? undefined : snapshotHashFor(ctx.originalNormalized),
      });
      throw batchAbortFor({
        error,
        index,
        path: ctx.path,
      });
    }
    throw error;
  };
  // WHY: `applyEdit` runs `swapReversedRanges` (its `prepareEdit`) before resolution, so a reversed
  // WHY: pair is healed rather than tripping the lease seam's own `E_REVERSED_ANCHORS` guard here.
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
async function assertBatchSpansDisjoint(edits: HEdit[], ctx: BaselineSpanContext): Promise<void> {
  if (edits.length < 2) return;
  const spans: BaselineSpan[] = [];
  for (let index = 0; index < edits.length; index++) {
    spans.push(await resolveBaselineSpan(edits[index]!, index, ctx));
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) {
        // WHY: the rejected batch still owes the model usable anchors (README error-code contract):
        // WHY: the later item's span is served exactly like the sequential anchor-mismatch abort,
        // WHY: so the retry never needs a re-read.
        const serveBlock = batchAbortServeBlock({
          rows: serveRowsForEdit(edits[b.index]!, ctx.originalHashes),
          originalNormalized: ctx.originalNormalized,
        });
        throw new Error(
          `[MODEL] [E_BATCH_ABORT] edit[${b.index}] (${ctx.path}) failed: overlapping spans — edit[${a.index}] targets lines ${a.startLine}-${a.endLine} and edit[${b.index}] targets lines ${b.startLine}-${b.endLine} of the same call. Spans in one edits[] call must be disjoint.\n` +
            `The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.${serveBlock}\n` +
            `Merge the overlapping ranges into a single edit (or split them into separate edit calls), then resubmit.`,
        );
      }
    }
  }
}

function parseEdits(items: NormalizedEditRequest["edits"], path: string): HEdit[] {
  const parsed: HEdit[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    try {
      parsed.push(
        resEdit({
          anchor_from: item.anchor_from,
          anchor_to: item.anchor_to,
          replace_with: item.replace_with,
        }),
      );
    } catch (error) {
      if (items.length === 1) throw error;
      // WHY: a payload malformation keeps its own code (`[E_MALFORMED_ANCHOR]`, `[E_BAD_PAYLOAD]`, …) — the
      // WHY: atomicity trailer explains the rolled-back siblings without misdirecting the model to
      // WHY: hunt for coordinate overlap.
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[MODEL] edit[${index}] (${path}) failed: ${stripModelPrefix(raw)}\n${BATCH_ATOMICITY_TRAILER}`,
      );
    }
  }
  return parsed;
}
async function runMutations(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<ProcessedEditFile> {
  if (request.file === null) {
    throw new Error(
      "[MODEL] [E_BAD_PAYLOAD] Edit request file could not be inferred from anchors.",
    );
  }
  const path = request.file;
  const items = request.edits;
  const mode = request.mode ?? "general";
  const hashStore = options?.store ?? (await loadHashStore());
  const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined);
  const warnings: string[] = [];
  // WHY: (#146) the never-served soft hint is once per call: per-item counts
  // WHY: travel as structured data (`neverServedCount`) and aggregate here, and
  // WHY: one counted hint is rendered after the loop. No other warning tier is
  // WHY: capped. A noop writes nothing, so its count is never aggregated.
  let neverServedTotal = 0;
  const pushAppliedWarnings = (list: string[] | undefined, hintCount: number): void => {
    if (list) warnings.push(...list);
    neverServedTotal += hintCount;
  };
  const pushNoopWarnings = (list: string[] | undefined): void => {
    if (list) warnings.push(...list);
  };
  abortIf(options?.signal);

  const isPreview = options?.noPersist === true;

  const parsed = parseEdits(items, path);

  const {
    normalized: originalNormalized,
    bom,
    originalEnding,
    fileHashes: originalHashes,
    hadUtf8DecodeErrors,
    absolutePath,
    served,
  } = await loadEditFile({
    path,
    cwd,
    signal: options?.signal,
    accessMode: options?.accessMode,
    sessionKey,
    store: hashStore,
    noPersist: options?.noPersist,
  });

  if (parsed.length > 1) {
    // WHY: the baseline identity seam is built from the pre-batch `S_curr`, so a span the gate
    // WHY: compares is the `s'_k` the apply path would rewrite — one source for both (spec §3.2.1).
    await assertBatchSpansDisjoint(parsed, {
      served,
      identity: leaseSpanSource({
        store: hashStore,
        sessionKey,
        absolutePath,
        content: originalNormalized,
      }),
      sessionKey,
      absolutePath,
      isPreview,
      path,
      originalHashes,
      originalNormalized,
    });
  }

  let currentContent = originalNormalized;
  let currentHashes = originalHashes;
  // WHY: the working buffer's line identity travels with its content (spec §3.2.4 step 1). It is the
  // WHY: exact `line_id` of every line the batch has not touched, so the commit persists identities it
  // WHY: already knows instead of re-deriving them by pairing S_final against S_latest. `null` marks a
  // WHY: line a preceding edit in this batch created; the commit allocates those from the counter.
  let currentIds: (number | null)[] = isPreview
    ? []
    : workingBufferIds(hashStore, absolutePath, originalNormalized);
  // WHY: the working buffer applies each edit to the previous edit's output, which is exactly the
  // WHY: preceding-delta rebase of spec §3.2.2: an anchor of edit k resolves in a buffer that only
  // WHY: edits with `s'_end,j < s'_start,k` have shifted, so `p_buffer = s'_k + Δ_k` falls out of the
  // WHY: sequential apply without ever materializing Δ_k as a coordinate. `assertBatchSpansDisjoint`
  // WHY: is what keeps the shift well-defined: disjoint baseline spans mean no edit's coordinates are
  // WHY: moved by an edit whose span contains them.
  let appliedCount = 0;
  let noopCount = 0;
  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  let literalDeclarations = 0;
  let unionStartLine = Infinity;
  let unionEndLine = -Infinity;
  let unionStartHash = "";
  let unionEndHash = "";
  const editedIntervals: ResolvedRange[] = [];
  let lastApplied: { content: string; hashes: string[]; removedHashes: Set<string> } | undefined;
  // WHY: (#117, spec §3.2.4 step 4) the legacy v6 `served.retired` mirror is read-only
  // WHY: in-memory during the batch. `batchTombstone` starts from the store snapshot and grows
  // WHY: with each applied item's removals, so later items still observe earlier removals for
  // WHY: hash-allocation and verification without any store write before `writeAtomic`.
  // WHY: `accumulatedRemoved` is the post-commit payload, retired once after the bytes are on disk.
  let baseCanons: (string | null)[] = [];
  try {
    baseCanons = await createSessionHandle(sessionKey, absolutePath, hashStore).loadCanons();
  } catch (error) {
    console.error("Failed to load served canons for batch:", error);
    baseCanons = [];
  }
  const batchTombstone = new Set<string>();
  try {
    for (const hash of await createSessionHandle(
      sessionKey,
      absolutePath,
      hashStore,
    ).loadTombstone()) {
      batchTombstone.add(hash);
    }
  } catch (error) {
    console.error("Failed to load legacy tombstone for batch:", error);
  }
  const accumulatedRemoved = new Set<string>();

  for (let index = 0; index < items.length; index++) {
    abortIf(options?.signal);
    const item = items[index]!;
    const edit = parsed[index]!;

    const outcome = await applyOneEdit({
      content: currentContent,
      hashes: currentHashes,
      edit,
      signal: options?.signal,
      filePath: path,
      served,
      tombstone: batchTombstone,
      servedCanons: baseCanons,
      sessionKey,
      absolutePath,
      store: hashStore,
      isPreview,
      mode,
      // WHY: the intermediate buffer is in-memory only, so its identities come from the buffer map
      // WHY: (`null` lines are the batch's own creations) — a re-diff of it against S_latest cannot
      // WHY: tell which of two byte-identical lines carries a leased line_id.
      currentIds: isPreview ? undefined : currentIds,
      onRejected: async (error) => {
        if (items.length === 1) throw error;
        throw batchAbortFor({ error, index, path });
      },
    });

    const range = outcome.range;
    editedIntervals.push(range);
    if (range.startLine < unionStartLine) {
      unionStartLine = range.startLine;
      unionStartHash = range.startHash;
    }
    if (range.endLine > unionEndLine) {
      unionEndLine = range.endLine;
      unionEndHash = range.endHash;
    }

    if (outcome.kind === "noop") {
      noopCount += 1;
      if (outcome.literalBypass) literalDeclarations += 1;
      if (isPreview) {
        pushNoopWarnings(outcome.anchorWarnings);
        continue;
      }
      const decision = await runNoopPolicy({
        absolutePath,
        removeFrom: item.anchor_from,
        removeTo: item.anchor_to,
        replacementText: item.replace_with,
        ref: `edit[${index}] (${path})`,
        batch: items.length > 1,
        range,
        hashes: currentHashes,
        lines: splitLines(currentContent),
        sessionKey,
        contentHash: snapshotHashFor(currentContent),
      });
      if (decision.action === "reject") throw new Error(decision.message);
      if (decision.action === "warn") warnings.push(decision.notice);
      if (items.length > 1) {
        warnings.push(
          `edit[${index}] (${path}) was a noop: the range already contains the replacement text.`,
        );
      }
      pushNoopWarnings(outcome.anchorWarnings);
      continue;
    }
    appliedCount += 1;
    if (outcome.literalBypass) literalDeclarations += 1;
    const { totalAddedLines: added, totalRemovedLines: removed } = countLineChanges(
      edit,
      originalHashes,
      false,
    );
    totalAddedLines += added;
    totalRemovedLines += removed;
    // WHY: (#117, spec §3.2.4 step 4) no store mutation before `writeAtomic`. The removed hashes
    // WHY: accumulate in-memory for the post-commit legacy retire; `batchTombstone` keeps later
    // WHY: items observing earlier removals without touching the store, so a failed batch retires
    // WHY: nothing.
    for (const hash of outcome.removedHashes) {
      batchTombstone.add(hash);
      accumulatedRemoved.add(hash);
    }
    lastApplied = {
      content: currentContent,
      hashes: currentHashes,
      removedHashes: outcome.removedHashes,
    };
    currentContent = outcome.content;
    currentHashes = outcome.hashes;
    if (!isPreview) {
      currentIds = spliceWorkingBufferIds(
        currentIds,
        range.startLine,
        range.endLine,
        splitLines(outcome.content).length,
      );
    }
    if (!isPreview) clearNoopLoop(absolutePath);
    pushAppliedWarnings(outcome.anchorWarnings, outcome.neverServedCount);
  }

  if (neverServedTotal > 0) {
    warnings.push(buildNeverServedEditHint({ count: neverServedTotal }));
  }

  const result = currentContent;
  let resultHashes = currentHashes;
  if (appliedCount > 0 && lastApplied) {
    // WHY: `persist: false` — S_final is still an in-memory working buffer here (spec §3.2.4): the
    // WHY: batch has not committed to disk, so this call must neither write a snapshot nor be able to
    // WHY: retire a lease. The single authoritative materialization runs after `writeAtomic` in
    // WHY: `apply`, and only there.
    resultHashes = await lineHashes(
      result,
      absolutePath,
      {
        content: lastApplied.content,
        hashes: lastApplied.hashes,
        removedHashes: lastApplied.removedHashes,
      },
      snapshotIOFor(hashStore),
      false,
    );
  }
  const resultLineIds = isPreview ? [] : currentIds;

  if (hadUtf8DecodeErrors) {
    warnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
  }

  let driftNotice: string | undefined;
  if (!isPreview && unionStartLine !== Infinity) {
    const resultLines = splitLines(result);
    try {
      driftNotice = await scanDrift({
        sessionKey,
        served,
        resultHashes,
        resultLines,
        contentHash: snapshotHashFor(result),
        intervals: editedIntervals,
        path: absolutePath,
      });
    } catch (error) {
      // SAFETY: best-effort drift notice — scanDrift failure is informational; edit already succeeded and driftNotice is optional, swallowing preserves tool success.
      console.error("Failed to compute drift notice:", error);
    }
  }

  const unionRange: ResolvedRange = {
    startLine: unionStartLine === Infinity ? 1 : unionStartLine,
    endLine: unionEndLine === -Infinity ? 1 : unionEndLine,
    startHash: unionStartHash,
    endHash: unionEndHash,
    delta: splitLines(result).length - splitLines(originalNormalized).length,
  };

  return {
    path,
    absolutePath,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    originalHashes,
    resultHashes,
    resultLineIds,
    removedHashes: accumulatedRemoved,
    appliedCount,
    noopCount,
    totalAddedLines,
    totalRemovedLines,
    driftNotice,
    range: unionRange,
    editedIntervals,
    literalDeclarations,
  };
}

function toSection(file: ProcessedEditFile): BatchSection {
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
  };
}

export async function previewEdits(
  request: NormalizedEditRequest,
  cwd: string,
  options?: Omit<PipelineOptions, "noPersist">,
) {
  return runMutations(request, cwd, { ...options, noPersist: true });
}

export async function apply(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<{
  result: string;
  diff: string;
  drift: string | undefined;
  metrics: ReturnType<typeof buildBatchResult>["details"]["metrics"];
  raw: ProcessedEditFile;
  toolResult: ReturnType<typeof buildBatchResult>;
}> {
  const isPreview = options?.noPersist === true;
  if (isPreview) {
    const file = await runMutations(request, cwd, options);
    const toolResult = buildBatchResult([toSection(file)]);
    const diff = toolResult.details.diff ?? "";
    return {
      result: file.result,
      diff,
      drift: file.driftNotice,
      metrics: toolResult.details.metrics,
      raw: file,
      toolResult,
    };
  }

  const path = request.file;
  if (path === null) {
    throw new Error(
      "[MODEL] [E_BAD_PAYLOAD] Edit request file could not be inferred from anchors.",
    );
  }
  const absolutePath = toCwd(path, cwd);
  const mutationTargetPath = await resolveTarget(absolutePath);
  const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined);

  return withFileMutationQueue(mutationTargetPath, async () => {
    abortIf(options?.signal);

    const file = await runMutations(request, cwd, {
      ...options,
      sessionKey,
      accessMode: options?.accessMode ?? constants.R_OK | constants.W_OK,
    });

    if (file.appliedCount === 0) {
      const toolResult = buildBatchResult([toSection(file)]);
      return {
        result: file.result,
        diff: "",
        drift: file.driftNotice,
        metrics: toolResult.details.metrics,
        raw: file,
        toolResult,
      };
    }

    abortIf(options?.signal);
    const undo = await saveUndo(mutationTargetPath, {
      content: file.originalNormalized,
      bom: file.bom,
      originalEnding: file.originalEnding,
      hashes: file.originalHashes,
      resultContent: file.result,
    });
    if (!undo.persisted) {
      throw new Error(
        `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
      );
    }
    try {
      abortIf(options?.signal);
      await writeAtomic(
        file.absolutePath,
        file.bom + restoreEndings(file.result, file.originalEnding),
      );
    } catch (error) {
      await undo.restore();
      throw error;
    }
    clearServedRefusals(file.absolutePath);

    // WHY: S_final is the edit path's only authoritative materialization (spec §3.2.4 step 4): it is
    // WHY: deliberately deferred to here, after the bytes are on disk, so an edit that writes nothing
    // WHY: (rejected batch, E_UNDO_UNAVAILABLE, writeAtomic rollback) can never retire a lease the
    // WHY: session still validly holds. Retirement must not happen in runMutations, which materializes
    // WHY: the working buffer while saveUndo/writeAtomic can still fail.
    // WHY: (#117) the legacy v6 `served.retired` mirror retires once here, after the bytes are on
    // WHY: disk, from the batch's in-memory accumulation. A failed batch never reaches this point,
    // WHY: so it tombstones nothing. Best-effort with context on failure: the bytes already
    // WHY: committed, so the edit succeeds with a deferred-sync warning, never a silent swallow.
    if (file.removedHashes.size > 0) {
      try {
        const legacyHandle =
          options?.store === undefined
            ? createSessionHandle(sessionKey, file.absolutePath)
            : createSessionHandle(sessionKey, file.absolutePath, options.store);
        await legacyHandle.retire(file.removedHashes);
      } catch (error) {
        console.error("Failed to retire legacy tombstones after write:", error);
        file.warnings.push(DEFERRED_STORE_SYNC_WARNING);
      }
    }
    const resultLineCount = visLines(file.result).length;
    const diffInfo = genDiff(
      file.originalNormalized,
      file.result,
      1,
      file.resultHashes,
      file.originalHashes,
    );
    const denseRows: ServedRow[] = [];
    for (let i = 0; i < file.resultHashes.length; i++) {
      denseRows.push({ position: i, hash: file.resultHashes[i]! });
    }
    try {
      // WHY: the served diff rows are step 5 of the commit transaction (spec §3.2.4 step 4):
      // WHY: snapshot + lineage + retirement + leases share one `BEGIN IMMEDIATE`, so a lease
      // WHY: failure rolls the snapshot back instead of leaving snapshot-without-leases behind.
      await upsertSnapshotFor(
        {
          path: file.absolutePath,
          snapshotHash: snapshotHashFor(file.result),
          lineCount: splitLines(file.result).length,
          hashes: file.resultHashes,
          content: file.result,
          lineIds: file.resultLineIds,
        },
        {
          retireLeases: true,
          leases: { sessionKey, rows: denseRows },
        },
      );
    } catch (error) {
      // SAFETY: best-effort post-write materialization — the edit already committed; a store failure
      // SAFETY: leaves the in-memory hashes authoritative and the next read re-materializes and
      // SAFETY: retires. SPEC §3.6.2: the bytes are on disk, so the tool reports success but must
      // SAFETY: warn that store synchronization is deferred.
      console.error("Failed to commit post-write snapshot materialization:", error);
      file.warnings.push(DEFERRED_STORE_SYNC_WARNING);
    }

    try {
      // WHY: mirror-only — the diff leases already committed in the transaction above, so no
      // WHY: `contentHash` is passed and no third transaction remains on the edit path.
      if (denseRows.length > 0) {
        await createSessionHandle(sessionKey, file.absolutePath).recordDiff(denseRows, {
          resultLineCount,
          firstChangedLine: diffInfo.firstChangedLine,
        });
      }
    } catch (error) {
      // SAFETY: best-effort serve recording — dense serve failures after successful write are ignored; file is already persisted and tool result is valid, next read will re-establish serves.
      console.error("Failed to record dense serves after write:", error);
    }

    const toolResult = buildBatchResult([toSection(file)]);
    return {
      result: file.result,
      diff: toolResult.details.diff ?? "",
      drift: file.driftNotice,
      metrics: toolResult.details.metrics,
      raw: file,
      toolResult,
    };
  });
}

export async function execEdits(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<ProcessedEditFile> {
  return runMutations(request, cwd, options);
}

// WHY: _collectRemovedHashesInternal removed
// WHY: _countLineChangesInternal removed
