import { reportDiagnostic } from "../diagnostics.js";
// Ref: docs/adr/0018-mutation-pipeline-phase-ordering-is-the-atomicity-contract.md

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { genDiff, restoreEndings } from "../edit-diff.js";
import {
  changedTerminatorCount,
  endingName,
  resolveEffectiveEolFromCounts,
  terminatorKindsUsed,
} from "../eol-config.js";
import { abortIf, assertNever, splitLines, visLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import { loadHashStore } from "../hash-store.js";
import { getSnapshot, snapshotIOFor, upsertSnapshotFor, snapshotHashFor } from "../snapshot-store";
import { applyEdit } from "../hashline/apply.js";
import { buildNeverServedEditHint } from "../served-session/serve-render.js";
import { resEdit, type HEdit, type NEdit } from "../hashline/resolve.js";
import { defaultHashIdentity, lineHashes } from "../hashline/hash-identity.js";
import { HASH_LEN } from "../hashline/alphabet.js";
import { denseServeRows, type ResolvedRange } from "../served-session/serve-render.js";
import { resolveLeasedEdit } from "../hashline/lease-resolve.js";
import type { FileSnapshotContext } from "../served-session/serve-render.js";
import { resolveSpanMode, type SpanMode } from "../span-mode-config.js";
import {
  DomainError,
  formatWarning,
  UNVERIFIED_HEADLINE,
  type DomainErrorCode,
} from "../domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "../served-spans.js";
import { createSessionHandle } from "../served-session/session.js";
import { scanDrift } from "../drift.js";
import { clearNoopLoop, runNoopPolicy } from "../noop-guard.js";
import { clearServedRefusals } from "../served-session/serve-render.js";
import { saveUndo } from "../edit-undo.js";
import { saveCutIntent, dropCutIntent } from "../undo-store.js";
import { repairCutIntents } from "../cut-repair.js";
import { withSortedMutationQueues } from "../mutation-queue.js";
import { resolveTarget, writeAtomic, readBytes } from "../fs-write.js";
import { toCwd } from "../paths.js";
import type {
  DesiredContent,
  NormalizedEditItem,
  NormalizedEditRequest,
} from "../payload-contract.js";
import {
  batchAbortFor,
  batchAbortForMany,
  buildBatchResult,
  toSection,
  wrapParseFailure,
} from "../edit-response.js";
import { DEFERRED_STORE_SYNC_WARNING } from "../constants.js";
import type { PipelineOptions, ProcessedEditFile, ForeignCutRecord } from "./types.js";
import {
  loadEditFile,
  loadForeignServedView,
  leaseSpanSource,
  requireSessionKey,
  type ForeignServedView,
} from "./edit-source.js";
import {
  assertBatchSpansDisjoint,
  spliceWorkingBufferIds,
  workingBufferIds,
} from "./batch-span-gate.js";

export type { PipelineOptions, ProcessedEditFile };

/** A move's retired source joins the union whatever the placement; a copy retires nothing. */
function collectRemovedHashes(edit: HEdit, originalHashes: string[]): Set<string> {
  const removedHashes = new Set<string>();
  const addSpan = (startHash: string, endHash: string): void => {
    const startLine = originalHashes.indexOf(startHash);
    const endLine = originalHashes.indexOf(endHash);
    if (startLine >= 0 && endLine >= 0) {
      for (let i = Math.min(startLine, endLine); i <= Math.max(startLine, endLine); i++) {
        removedHashes.add(originalHashes[i]!);
      }
    }
  };
  if (edit.placement !== "before" && edit.placement !== "after") {
    addSpan(edit.hash_bounds[0].hash, edit.hash_bounds[1].hash);
  }
  if (edit.source?.retire) {
    addSpan(edit.source.bounds[0].hash, edit.source.bounds[1].hash);
  }
  return removedHashes;
}

function countLineChanges(
  edit: HEdit,
  originalHashes: string[],
  isNoop: boolean,
): { totalAddedLines: number; totalRemovedLines: number } {
  if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
  if (edit.placement === "before" || edit.placement === "after") {
    return { totalAddedLines: edit.content_lines.length, totalRemovedLines: 0 };
  }
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

interface ApplyOneEditInput {
  content: string;
  hashes: string[];
  edit: HEdit;
  signal?: AbortSignal;
  served: (string | null)[];
  blockedHashes?: ReadonlySet<string>;
  canonDigests?: (string | null)[];
  sessionKey: string;
  absolutePath: string;
  store: HashStore;
  isPreview: boolean;
  mode?: "general" | "literal";
  spanMode: SpanMode;
  /**
   * The working buffer's own `line_id` map (spec §3.2.4 step 1), entry `i` naming line `i + 1`.
   * Present for a live batch: identity resolution reads it directly instead of re-deriving positions
   * by pairing the intermediate buffer against `S_latest`, which cannot tell two byte-identical lines
   * apart. Absent for preview, where no identity map is in flight.
   */
  currentIds?: (number | null)[];
  /**
   * Present once an earlier item of a live batch has changed the working buffer: maps a buffer line
   * to its pre-batch line (`undefined` for a line the batch created). A rejection's rows then come
   * from an uncommitted buffer and are not guaranteed current-file rows, so they are neither shown
   * nor recorded as served.
   */
  baselineLineOf?: (bufferLine: number) => number | undefined;
  onRejected: (error: DomainError) => Promise<never>;
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
      /** Span-ref move: the retired source span in pre-item coordinates. */
      sourceRange: ResolvedRange | undefined;
      /** Span-ref item: the mutated line regions the identity splice must apply. */
      mutationSpans: { startLine: number; endLine: number; inserted: number }[] | undefined;
      mutationStats: { addedLines: number; removedLines: number } | undefined;
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
 * Apply one edit to the working buffer. `filePath` and `absolutePath` carry the same canonical path,
 * because the hash re-read below and the write must agree. A rejection standing at buffer coordinates
 * is never recorded as served: those rows would patch the mirror at the wrong positions and refuse a
 * later standalone edit of a served span.
 */
async function applyOneEdit(input: ApplyOneEditInput): Promise<ApplyOneEditOutcome> {
  abortIf(input.signal);

  const identity = leaseSpanSource({
    store: input.store,
    sessionKey: input.sessionKey,
    absolutePath: input.absolutePath,
    content: input.content,
    ...(input.currentIds !== undefined ? { currentIds: input.currentIds } : {}),
  });

  let anchorResult: ReturnType<typeof applyEdit>;
  try {
    anchorResult = applyEdit(input.content, input.edit, input.signal, input.hashes, {
      filePath: input.absolutePath,
      absolutePath: input.absolutePath,
      sessionKey: input.sessionKey,
      served: input.served,
      ...(input.canonDigests !== undefined ? { canonDigests: input.canonDigests } : {}),
      identity,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      spanMode: input.spanMode,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (input.baselineLineOf !== undefined && error.servedRows.length > 0) {
        return input.onRejected(shiftedBufferRejection(error, input.baselineLineOf));
      }
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
    throw new DomainError("E_STALE_ANCHOR", {
      headline: `missing previous hashes for stable anchoring. Re-read the full file and copy fresh ${HASH_LEN}-char anchors (before │), then retry.`,
      cause: "never-served",
    });
  const removedHashes = collectRemovedHashes(input.edit, input.hashes);
  // SAFETY: the options object is typed by HashIdentity's internal parameter shape, which the
  // SAFETY: caller never sees; every field above is already typed, so the cast widens nothing.
  const nextHashes = await defaultHashIdentity.hashesFor(nextContent, {
    path: input.absolutePath,
    prior: { content: input.content, hashes: input.hashes, removedHashes },
    persist: false,
    snapshotIO: snapshotIOFor(input.store),
    // SAFETY: blockedHashes passed as ReadonlySet via unknown for HashIdentity compatibility — input.blockedHashes is already typed, cast preserves immutability
    blockedHashes: input.blockedHashes as unknown as ReadonlySet<string> | undefined,
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
    sourceRange: anchorResult.sourceRange,
    mutationSpans: anchorResult.mutationSpans,
    mutationStats: anchorResult.mutationStats,
  };
}

/**
 * A rejection raised inside a batch buffer that earlier items already changed, made served-or-absent
 * (the foreign-rejection rule): its rows come from a buffer this call has not committed as the
 * current on-disk state and are not guaranteed current-file rows, so they must not be shown as a
 * fresh read or recorded as served, and grant no lease. The rows are dropped and the headline says
 * so, stating which current-file lines an anchored read would serve (facts only, no retry
 * directive). Code and cause are preserved; the headline and first offending line are re-anchored
 * to current-file coordinates (a buffer line that has no baseline is omitted).
 * The row frame is per code: `E_STALE_RANGE`/`E_STALE_ANCHOR` producers name working-buffer coordinates,
 * while the `E_UNVERIFIED_RANGE` window already names current-file lines. No other row-carrying code
 * reaches here today; one that does keeps its rendering but is still never recorded by the caller.
 */
function shiftedBufferRejection(
  error: DomainError,
  baselineLineOf: (bufferLine: number) => number | undefined,
): DomainError {
  const rowsAreBufferCoordinates = error.code !== "E_UNVERIFIED_RANGE";
  const toCurrentLine = (line: number): number | undefined =>
    rowsAreBufferCoordinates ? baselineLineOf(line) : line;
  const lines = error.servedRows
    .map((row) => toCurrentLine(row.position + 1))
    .filter((line): line is number => line !== undefined);
  const read =
    lines.length > 0
      ? `An anchored read of current-file lines ${Math.min(...lines)}-${Math.max(...lines)} would serve that range.`
      : "None of these rows exist in the current file.";
  const firstOffendingLine =
    error.firstOffendingLine === undefined ? undefined : toCurrentLine(error.firstOffendingLine);
  const note =
    " An earlier item of this call had already changed the temporary batch buffer, so this " +
    "rejection's rows come from an uncommitted buffer and are not guaranteed current-file rows: " +
    `none are shown, none grant leases and none were recorded as served. ${read}`;
  const rest = {
    servedRows: [],
    servedBlock: "",
    ...(firstOffendingLine !== undefined ? { firstOffendingLine } : {}),
  };
  if (error.code === "E_STALE_RANGE") {
    const { headline, cause } = error.payload as DomainError<"E_STALE_RANGE">["payload"];
    return new DomainError("E_STALE_RANGE", {
      ...rest,
      cause,
      headline: `${relabelHeadline(headline, toCurrentLine)}${note}`,
    });
  }
  if (error.code === "E_UNVERIFIED_RANGE") {
    const { headline, cause } = error.payload as DomainError<"E_UNVERIFIED_RANGE">["payload"];
    return new DomainError("E_UNVERIFIED_RANGE", {
      ...rest,
      cause,
      headline: `${headline ?? UNVERIFIED_HEADLINE}${note}`,
    });
  }
  if (error.code === "E_STALE_ANCHOR") {
    const { headline, cause } = error.payload as DomainError<"E_STALE_ANCHOR">["payload"];
    return new DomainError("E_STALE_ANCHOR", {
      ...rest,
      cause,
      headline: `${relabelHeadline(headline, toCurrentLine)}${note}`,
    });
  }
  return error;
}

/**
 * Re-anchors a producer headline's working-buffer line numbers to the current-file lines they map
 * to. A headline built inside the changed buffer names buffer lines that no longer exist in the
 * current file; the rowless refusal must name current-file coordinates only. Only the `line N` and
 * `line N-M` forms the producers emit are rewritten; a line with no baseline keeps the original
 * text, and a range whose end has no baseline drops the end (never a buffer number).
 */
function relabelHeadline(
  headline: string,
  toCurrentLine: (bufferLine: number) => number | undefined,
): string {
  return headline.replace(/\bline (\d+)(?:-(\d+))?\b/g, (whole, start, end) => {
    const mappedStart = toCurrentLine(Number(start));
    if (mappedStart === undefined) return whole;
    if (end === undefined) return `line ${mappedStart}`;
    const mappedEnd = toCurrentLine(Number(end));
    return mappedEnd === undefined ? `line ${mappedStart}` : `line ${mappedStart}-${mappedEnd}`;
  });
}

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

/**
 * The one exhaustive view of the payload union for text consumers: the noop-loop tracker discriminates
 * its noop episodes with this, so a new union arm must add a case here or `assertNever` fails typecheck.
 * The `reference` arm renders as its span's anchors with the mode word, never a placeholder empty text —
 * the copied content is not known here, and collapsing every non-literal arm to "" would fuse distinct
 * noop episodes into one count.
 */
function replacementTextForPayload(payload: DesiredContent): string {
  switch (payload.kind) {
    case "literal":
      return payload.text;
    case "reference":
      return `span:${payload.span.anchor_from}..${payload.span.anchor_to}:${payload.mode === "cut" ? "move" : "copy"}`;
    case "empty":
      return "";
    default:
      return assertNever(payload);
  }
}

/**
 * An `empty` payload with `"before"`/`"after"` parses to a NO-OP marker, not an `HEdit`: the mutate loop
 * counts the item as a noop and warns, so it never reaches `applyEdit` and never consults the noop-loop
 * tracker — no bytes are rewritten, so there is no repeated-content episode to count.
 */
type ParsedItem = { edit: HEdit } | { noopInsert: true };

/**
 * Parse aggregates like the span gate: one malformed item must not mask another, so the model fixes every
 * malformed item in one resubmission. Parsing is pure, so atomicity is trivial here.
 *
 * The empty-`literal` guard lives at this seam because `execute()` never runs `assertReq`: a directly
 * constructed `{ kind: "literal", text: "" }` would otherwise delete the span and report success. The
 * mode travels twice (`payload.mode` and `span.mode`) and only the top-level one is consumed; a
 * disagreement is refused rather than silently resolved, because admission folds the wire `text_ref`.
 */
function parseEdits(items: NormalizedEditRequest["edits"], path: string): ParsedItem[] {
  const parsed: ParsedItem[] = [];
  const failures: { error: Error; index: number }[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    try {
      const payload = item.payload;
      let text: string;
      let source: { anchor_from: string; anchor_to: string; retire: boolean } | undefined;
      switch (payload.kind) {
        case "literal":
          if (payload.text === "") {
            throw new DomainError("E_INTERNAL_INVARIANT", {
              message:
                `Edit request edits[${index}] "text" must carry at least one line; ` +
                `"text": "" is the deletion payload. Nothing was written.`,
            });
          }
          text = payload.text;
          break;
        case "reference":
          if (payload.span.mode !== payload.mode) {
            throw new DomainError("E_INTERNAL_INVARIANT", {
              message:
                'The "text_ref" payload is inconsistent: its "mode" disagrees with the mode carried by the span it names. Nothing was written.',
            });
          }
          source = {
            anchor_from: payload.span.anchor_from,
            anchor_to: payload.span.anchor_to,
            retire: payload.mode === "cut",
          };
          text = "";
          break;
        case "empty":
          if (item.at !== "in-place") {
            parsed.push({ noopInsert: true });
            continue;
          }
          text = "";
          break;
        default:
          assertNever(payload);
      }
      parsed.push({
        edit: resEdit({
          anchor_from: item.target.anchor_from,
          anchor_to: item.target.anchor_to,
          text,
          ...(item.at !== "in-place" ? { placement: item.at } : {}),
          ...(source ? { source } : {}),
        }),
      });
    } catch (error) {
      if (items.length === 1) throw error;
      failures.push({ error: error instanceof Error ? error : new Error(String(error)), index });
    }
  }
  if (failures.length === 1) {
    const only = failures[0]!;
    throw wrapParseFailure(only.error, only.index, path);
  }
  if (failures.length > 1) {
    throw batchAbortForMany({ failures, path });
  }
  return parsed;
}

/**
 * Foreign-vs-same-file is a resolved-path question, not a spelling one: `./target.txt` and `target.txt`
 * name one file, so a same-file `cut` takes the intra-file path.
 */
async function sameResolvedPath(a: string, b: string, cwd: string): Promise<boolean> {
  const [resolvedA, resolvedB] = await Promise.all([
    resolveTarget(toCwd(a, cwd)),
    resolveTarget(toCwd(b, cwd)),
  ]);
  return resolvedA === resolvedB;
}

async function foreignRefFileOf(
  item: NormalizedEditItem,
  input: { cwd: string; file: string },
): Promise<string | undefined> {
  const payload = item.payload;
  if (payload.kind !== "reference" || payload.span.file === undefined) return undefined;
  return (await sameResolvedPath(payload.span.file, input.file, input.cwd))
    ? undefined
    : payload.span.file;
}

/** The three never-served codes pass through UNCHANGED however many rows a producer attaches: §0's
 * length proxy holds only because no producer carries rows there, so a code set is honest. */
const NEVER_SERVED_FOREIGN_CODES: ReadonlySet<DomainErrorCode> = new Set([
  "E_UNKNOWN_ANCHOR",
  "E_FOREIGN_ANCHOR",
  "E_STALE_ANCHOR",
]);

/** These codes hold a lease, so retirement or drift must surface with the code that means it: an
 * `E_STALE_ANCHOR` rewrite would name the wrong cause and serve no rows this call holds. */
const LEASED_FOREIGN_PASSTHROUGH_CODES: ReadonlySet<DomainErrorCode> = new Set([
  "E_UNVERIFIED_RANGE",
  "E_STALE_RANGE",
  "E_TARGET_LOST",
]);

/**
 * A foreign-source rejection never renders unleased rows: the rows a leased-range rejection names belong to the FOREIGN file's
 * mirror, and this call must not lease anything it did not write (`loadForeignServedView` is the read-only authority). Rows are
 * therefore SERVED or ABSENT — the leased codes are re-wrapped HERE with their rows dropped and `refFile` named, except
 * `E_TARGET_LOST`, whose format already names the file and carries no rows, so it passes through. §0's never-served pass-through
 * below stays (its exact-code pins ride it); the length guard in it is SHADOWED by the code-set check and is NOT the enforcement point.
 * A never-served foreign anchor is ticketed to the `W_NEVER_SERVED_SHAPE` soft hint but surfaces as a hard
 * rejection here, and that deviation is structural: `[W_*]` codes are the APPLIED tier — `warnBlock` renders
 * them only on a result that mutated — and a foreign failure aborts before any apply, so the channel that
 * would carry the hint never exists for this call. The fallback's `cause` prefers the inner typed cause,
 * so a retirement or drift shape never reports `"never-served"` dishonestly.
 */
function foreignRejection(error: unknown, refFile: string): DomainError {
  if (error instanceof DomainError) {
    if (
      (error.code === "E_UNKNOWN_ANCHOR" ||
        error.code === "E_FOREIGN_ANCHOR" ||
        error.code === "E_STALE_ANCHOR") &&
      error.servedRows.length === 0
    ) {
      return error;
    }
    if (NEVER_SERVED_FOREIGN_CODES.has(error.code)) return error;
    if (LEASED_FOREIGN_PASSTHROUGH_CODES.has(error.code)) {
      if (error.code === "E_TARGET_LOST") return error;
      return foreignLeasedWrap(error, refFile);
    }
    const cause = error.cause ?? error.details.cause ?? "never-served";
    return new DomainError("E_STALE_ANCHOR", {
      headline:
        `the foreign-source reference to ${refFile} does not resolve against that file's served state ` +
        `(rejection: ${error.code}). Nothing was written; no rows of ${refFile} were served by this call.`,
      cause,
    });
  }
  return new DomainError("E_STALE_ANCHOR", {
    headline: `the foreign-source reference to ${refFile} did not resolve. Nothing was written.`,
    cause: "never-served",
  });
}

/**
 * The lease code survives verbatim: retirement or drift must surface under the code that means it — an
 * `E_STALE_ANCHOR` rewrite would name the wrong cause and offer no rows. Any other code throws: the
 * caller's set admits only the two arms above plus `E_TARGET_LOST`.
 */
function foreignLeasedWrap(error: DomainError, refFile: string): DomainError {
  const headline =
    `the foreign-source reference to ${refFile} no longer resolves against that file's served ` +
    `state (rejection: ${error.code}). No rows of ${refFile} were served by this call. Nothing ` +
    `was written.`;
  const cause = error.cause ?? error.details.cause ?? "never-served";
  const firstOffending =
    error.firstOffendingLine !== undefined ? { firstOffendingLine: error.firstOffendingLine } : {};
  if (error.code === "E_UNVERIFIED_RANGE") {
    return new DomainError("E_UNVERIFIED_RANGE", {
      headline,
      servedRows: [],
      servedBlock: "",
      cause,
      ...firstOffending,
    });
  }
  if (error.code === "E_STALE_RANGE") {
    return new DomainError("E_STALE_RANGE", {
      headline,
      servedRows: [],
      servedBlock: "",
      cause,
      ...firstOffending,
    });
  }
  throw error;
}

/**
 * Foreign-source copy (ticket-04 §3.3) and the cut record (ticket-04b): a `text_ref` naming another served file is read from that
 * file's CURRENT content through the READ-ONLY half of the lease seam and collapsed to a `literal` payload BEFORE the mutate loop,
 * so a foreign resolution failure aborts the whole call atomically (nothing has been mutated yet) and every downstream gate runs on
 * the bytes that will be written. The assembly is `loadForeignServedView` (edit-source.ts), memoized by `materializeForeignReferences`.
 *
 * SAFETY: the pre-pass read is read-only by construction, not by convention: `loadForeignServedView` is built on
 * `readNormFile(..., { noPersist: true })`, which gates every snapshotIO.upsert (snapshot, lineage, leases) behind that flag;
 * `leaseSpanSource` exposes only `leaseFor`/`rebasedLineOf`/`anchorHomes`, so resolution never re-stamps a lease and never writes
 * `retired_at`; the loop never calls `recordServeFeedback`/`record`/`retire`/`grant` for the foreign path, which `mode: "copy"`
 * never writes, and `mode: "cut"` (ticket-04b) edits LATER under `runCutTransaction` as a first-class transaction member.
 */
async function materializeForeignItem(
  item: NormalizedEditItem,
  refFile: string,
  view: ForeignServedView,
  cuts: ForeignCutRecord[],
): Promise<NormalizedEditItem> {
  const payload = item.payload;
  if (payload.kind !== "reference") return item;
  if (payload.span.mode !== payload.mode) {
    throw new DomainError("E_INTERNAL_INVARIANT", {
      message:
        'The "text_ref" payload is inconsistent: its "mode" disagrees with the mode carried by the span it names. Nothing was written.',
    });
  }
  // Ref: docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md
  const { fileLines } = view;
  const snapshot: FileSnapshotContext = {
    fileLines,
    fileHashes: view.fileHashes,
    filePath: refFile,
  };
  const spanEdit: HEdit = {
    content_lines: [],
    hash_bounds: [{ hash: payload.span.anchor_from }, { hash: payload.span.anchor_to }],
  };
  let resolution;
  try {
    resolution = resolveLeasedEdit({
      edit: spanEdit,
      snapshot,
      served: view.served,
      source: view.source,
    });
  } catch (error) {
    throw foreignRejection(error, refFile);
  }
  const l1 = resolution.resolved.hash_bounds[0].line;
  const l2 = resolution.resolved.hash_bounds[1].line;
  if (payload.mode === "cut") {
    cuts.push({
      refFile,
      absolutePath: view.absolutePath,
      spanFrom: payload.span.anchor_from,
      spanTo: payload.span.anchor_to,
    });
  }
  return {
    ...item,
    payload: { kind: "literal", text: collapseSpanToText(fileLines.slice(l1 - 1, l2)) },
  };
}

/**
 * `parseText` maps `""` → `[]` and N newlines → N blank lines (`src/hashline/parse.ts:76-77`), the inverse
 * of `join("\n")`: joining an all-blank span would lose exactly one line, so the all-blank case reuses the
 * wire's own convention. Mixed spans join exactly.
 */
function collapseSpanToText(span: string[]): string {
  if (span.length > 0 && span.every((line) => line.length === 0)) {
    return "\n".repeat(span.length);
  }
  return span.join("\n");
}

/**
 * One read+load+lease per RESOLVED path per batch: without the memo, a foreign file that changes on disk
 * between two items would materialize two revisions into one call with no diagnostic — correctness, not
 * performance. The map is batch-scoped, because a global cache would go stale.
 */
async function materializeForeignReferences(
  items: NormalizedEditItem[],
  input: { cwd: string; file: string; store: HashStore; sessionKey: string },
): Promise<{ items: NormalizedEditItem[]; cuts: ForeignCutRecord[] }> {
  const refFiles = await Promise.all(items.map((item) => foreignRefFileOf(item, input)));
  const cuts: ForeignCutRecord[] = [];
  if (!refFiles.some((refFile) => refFile !== undefined)) return { items, cuts };
  const views = new Map<string, Promise<ForeignServedView>>();
  const out: NormalizedEditItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const refFile = refFiles[index];
    if (refFile === undefined) {
      out.push(item);
      continue;
    }
    const key = await resolveTarget(toCwd(refFile, input.cwd));
    let view = views.get(key);
    if (view === undefined) {
      view = loadForeignServedView({
        path: refFile,
        cwd: input.cwd,
        store: input.store,
        sessionKey: input.sessionKey,
      });
      views.set(key, view);
    }
    out.push(await materializeForeignItem(item, refFile, await view, cuts));
  }
  return { items: out, cuts };
}

/**
 * The batch mutate loop. Its buffer is the preceding-delta rebase: each edit applies to the previous
 * edit's output (`p_buffer = s'_k + Δ_k`), which the disjoint baseline spans keep well-defined.
 * `batchBlockedHashes` starts from the store snapshot and grows with each applied item's removals, so
 * later items still observe earlier removals with no store write before `writeAtomic` (#117).
 * A move's retired source is an edited interval too, so the drift scan sees its negative delta and the
 * union covers the removed lines. A span-ref item splices its two regions in DESCENDING start order, so
 * each region's coordinates still name pre-item lines; it reports its own counts because
 * `countLineChanges` sees only the target span. The final `persist: false` keeps S_final in memory,
 * because persisting it there retired anchors a batch that wrote nothing still validly held.
 * The never-served soft hint is once per call (#146); a noop insert never contributes, because a noop writes nothing.
 */
async function runMutations(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<ProcessedEditFile> {
  const path = request.file;
  const mode = request.mode ?? "general";
  const spanMode = resolveSpanMode(cwd);
  const hashStore = options?.store ?? (await loadHashStore());
  const sessionKey = requireSessionKey(options?.sessionKey);
  const { items, cuts: foreignCuts } = await materializeForeignReferences(request.edits, {
    cwd,
    file: path,
    store: hashStore,
    sessionKey,
  });
  const warnings: string[] = [];
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
  const realEdits: HEdit[] = [];
  for (const one of parsed) {
    if ("edit" in one) realEdits.push(one.edit);
  }

  const {
    normalized: originalNormalized,
    bom,
    originalEnding,
    fileHashes: originalHashes,
    hadUtf8DecodeErrors,
    absolutePath,
    served,
    endingCounts,
    retiredHashes: loadedRetiredHashes,
  } = await loadEditFile({
    path,
    cwd,
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    ...(options?.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    sessionKey,
    store: hashStore,
    ...(options?.noPersist !== undefined ? { noPersist: options.noPersist } : {}),
  });

  const effectiveEnding = resolveEffectiveEolFromCounts(endingCounts, cwd);
  // Ref: docs/reference/error-and-warning-contract.md
  if (hadUtf8DecodeErrors) {
    throw new DomainError("E_LOSSY_TEXT", { path });
  }

  if (realEdits.length > 1) {
    await assertBatchSpansDisjoint(realEdits, {
      served,
      identity: leaseSpanSource({
        store: hashStore,
        sessionKey,
        absolutePath,
        content: originalNormalized,
      }),
      sessionKey,
      absolutePath,
      spanMode,
      isPreview,
      path,
      originalHashes,
      originalNormalized,
      recordRejectionServe,
    });
  }

  let currentContent = originalNormalized;
  let currentHashes = originalHashes;
  let currentIds: (number | null)[] = isPreview
    ? []
    : workingBufferIds(hashStore, absolutePath, originalNormalized);
  const baselineLineById = new Map<number, number>();
  currentIds.forEach((id, i) => {
    if (id !== null) baselineLineById.set(id, i + 1);
  });
  const baselineLineOf = (bufferLine: number): number | undefined => {
    const id = currentIds[bufferLine - 1];
    return id === null || id === undefined ? undefined : baselineLineById.get(id);
  };
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
  let baseCanonDigests: (string | null)[] = [];
  try {
    baseCanonDigests = await createSessionHandle(
      sessionKey,
      absolutePath,
      hashStore,
    ).loadCanonDigests();
  } catch (error) {
    reportDiagnostic("mutation-engine", "Failed to load served canon digests for batch:", error);
    baseCanonDigests = [];
  }
  const batchBlockedHashes = new Set<string>(loadedRetiredHashes);
  try {
    for (const hash of await createSessionHandle(
      sessionKey,
      absolutePath,
      hashStore,
    ).loadBlockedHashes()) {
      batchBlockedHashes.add(hash);
    }
  } catch (error) {
    reportDiagnostic("mutation-engine", "Failed to load legacy blocked hashes for batch:", error);
  }
  const accumulatedRemoved = new Set<string>(loadedRetiredHashes);

  for (let index = 0; index < items.length; index++) {
    abortIf(options?.signal);
    const item = items[index]!;
    const parsedItem = parsed[index]!;
    if ("noopInsert" in parsedItem) {
      noopCount += 1;
      warnings.push(
        formatWarning("W_NOOP_INSERT", {
          ref: `edit[${index}] (${path})`,
          removeFrom: item.target.anchor_from,
          removeTo: item.target.anchor_to,
        }),
      );
      continue;
    }
    const edit = parsedItem.edit;

    const outcome = await applyOneEdit({
      content: currentContent,
      hashes: currentHashes,
      edit,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      served,
      blockedHashes: batchBlockedHashes,
      canonDigests: baseCanonDigests,
      sessionKey,
      absolutePath,
      store: hashStore,
      isPreview,
      mode,
      spanMode,
      ...(isPreview ? {} : { currentIds }),
      ...(!isPreview && currentContent !== originalNormalized ? { baselineLineOf } : {}),
      onRejected: async (error) => {
        if (items.length === 1) throw error;
        throw batchAbortFor({ error, index, path });
      },
    });

    const range = outcome.range;
    const coveredRanges: ResolvedRange[] =
      outcome.kind === "applied" && outcome.sourceRange ? [range, outcome.sourceRange] : [range];
    editedIntervals.push(...coveredRanges);
    for (const covered of coveredRanges) {
      if (covered.startLine < unionStartLine) {
        unionStartLine = covered.startLine;
        unionStartHash = covered.startHash;
      }
      if (covered.endLine > unionEndLine) {
        unionEndLine = covered.endLine;
        unionEndHash = covered.endHash;
      }
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
        removeFrom: item.target.anchor_from,
        removeTo: item.target.anchor_to,
        replacementText: replacementTextForPayload(item.payload),
        ref: `edit[${index}] (${path})`,
        batch: items.length > 1,
        range,
        hashes: currentHashes,
        lines: splitLines(currentContent),
        sessionKey,
        contentHash: snapshotHashFor(currentContent),
        ...(!isPreview && currentContent !== originalNormalized ? { baselineLineOf } : {}),
      });
      if (decision.action === "reject") {
        if (items.length === 1) throw decision.error;
        throw batchAbortFor({ error: decision.error, index, path });
      }
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
    const stats = outcome.mutationStats;
    const { totalAddedLines: added, totalRemovedLines: removed } = stats
      ? { totalAddedLines: stats.addedLines, totalRemovedLines: stats.removedLines }
      : countLineChanges(edit, originalHashes, false);
    totalAddedLines += added;
    totalRemovedLines += removed;
    for (const hash of outcome.removedHashes) {
      batchBlockedHashes.add(hash);
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
      if (outcome.mutationSpans) {
        for (const span of [...outcome.mutationSpans].sort((a, b) => b.startLine - a.startLine)) {
          currentIds = spliceWorkingBufferIds(
            currentIds,
            span.startLine,
            span.endLine,
            currentIds.length - (span.endLine - span.startLine + 1) + span.inserted,
          );
        }
      } else {
        currentIds = spliceWorkingBufferIds(
          currentIds,
          range.startLine,
          range.endLine,
          splitLines(outcome.content).length,
        );
      }
    }
    pushAppliedWarnings(outcome.anchorWarnings, outcome.neverServedCount);
  }

  if (neverServedTotal > 0) {
    warnings.push(buildNeverServedEditHint({ count: neverServedTotal }));
  }

  const changed = changedTerminatorCount(endingCounts, effectiveEnding.value);
  const eolRewriteWarning =
    changed > 0
      ? formatWarning("W_EOL_REWRITTEN", {
          target: endingName(effectiveEnding.value),
          source: effectiveEnding.source,
          changed,
        })
      : undefined;

  const result = currentContent;
  let resultHashes = currentHashes;
  if (appliedCount > 0 && lastApplied) {
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
      batchBlockedHashes,
    );
    // Ref: docs/spec/content-addressed-line-identity-mvcc.md — the snapshot committed for this exact content is the identity every read serves, so it outranks an anchor a tombstone just forced away from.
    // Ref: docs/spec/content-addressed-line-identity-mvcc.md — a preview reads the same identity but never cleans up: the corrupt-row policy is "keep", so an unpersisted turn cannot delete a row it never owned.
    const committed = getSnapshot(hashStore, absolutePath, result, isPreview ? "keep" : "delete");
    if (committed !== undefined && committed.length === resultHashes.length) {
      resultHashes = committed;
      // Ref: docs/spec/content-addressed-line-identity-mvcc.md — the identity names the ADOPTED snapshot, not the working buffer's spliced ids, because downstream leases and undo claims read `line_id` against the committed rows. `workingBufferIds` IS the `positionsByIdentity` inversion.
      currentIds = workingBufferIds(hashStore, absolutePath, result);
    }
  }
  const resultLineIds = isPreview ? [] : currentIds;

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
      reportDiagnostic("mutation-engine", "Failed to compute drift notice:", error);
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
    effectiveEnding: effectiveEnding.value,
    preImageMixed: terminatorKindsUsed(endingCounts) >= 2,
    eolRewriteWarning,
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
    foreignCuts,
    ...(spanMode === "hint" ? { served } : {}),
  };
}

export async function previewEdits(
  request: NormalizedEditRequest,
  cwd: string,
  options?: Omit<PipelineOptions, "noPersist">,
) {
  return runMutations(request, cwd, { ...options, noPersist: true });
}

/**
 * The one projection of a file's change (#326): the commit helper and both `apply` sites read their
 * rendered rows here, so no response re-projects a file the pipeline already rendered. Context 1 is
 * the applied-diff fold every apply result has used; the pre-batch served mirror goes in so a removal
 * the caller never saw keeps its blank gutter, which the retired fallback omitted.
 */
function renderedDiffFor(file: ProcessedEditFile): ReturnType<typeof genDiff> {
  return genDiff(
    file.originalNormalized,
    file.result,
    1,
    file.resultHashes,
    file.originalHashes,
    undefined,
    file.served,
  );
}

/**
 * The post-write commit for ONE file whose bytes are already on disk: the refusal/noop-loop
 * tally clears, the legacy retire mirror, and the authoritative snapshot/lineage/lease/served-
 * mirror transaction. Shared verbatim by the single-file path and `runCutTransaction` — one
 * materialization owner for every committed file. Returns the diff info for the batch section.
 * Only bytes on disk retire the tally and the leases: a rejected batch, `E_UNDO_UNAVAILABLE` or a
 * `writeAtomic` rollback never reaches this site, so its counters and leases survive the resubmission.
 * The served mirror's truncation shape reproduces `recordDiff`'s plan (`planServeRecording`) exactly.
 */
async function finishCommittedFile(
  file: ProcessedEditFile,
  options: PipelineOptions | undefined,
  sessionKey: string,
): Promise<ReturnType<typeof genDiff>> {
  clearServedRefusals(sessionKey, file.absolutePath);
  clearNoopLoop(sessionKey, file.absolutePath);

  if (file.removedHashes.size > 0) {
    try {
      const legacyHandle =
        options?.store === undefined
          ? createSessionHandle(sessionKey, file.absolutePath)
          : createSessionHandle(sessionKey, file.absolutePath, options.store);
      await legacyHandle.retire(file.removedHashes);
    } catch (error) {
      reportDiagnostic(
        "mutation-engine",
        "Failed to retire legacy blocked hashes after write:",
        error,
      );
      file.warnings.push(DEFERRED_STORE_SYNC_WARNING);
    }
  }
  const resultLineCount = visLines(file.result).length;
  const diffInfo = renderedDiffFor(file);
  if (diffInfo.unservedRemovedLines.length > 0) {
    file.warnings.push(
      formatWarning("W_UNSERVED_INTERIOR", {
        unservedLines: diffInfo.unservedRemovedLines,
        replacedLineCount: diffInfo.removedLineCount,
      }),
    );
  }
  const denseRows = denseServeRows(file.resultHashes);
  try {
    // Ref: docs/.archive_adrs/0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md
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
        servedMirror: {
          sessionKey,
          rows: denseRows,
          shape: {
            lineCount: resultLineCount,
            clearFrom: diffInfo.firstChangedLine !== undefined ? diffInfo.firstChangedLine - 1 : 0,
          },
        },
      },
    );
  } catch (error) {
    reportDiagnostic(
      "mutation-engine",
      "Failed to commit post-write snapshot materialization:",
      error,
    );
    file.warnings.push(DEFERRED_STORE_SYNC_WARNING);
  }
  return diffInfo;
}

/**
 * The foreign-source cut as one correlated multi-file transaction (`docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md`);
 * NO filesystem atomicity is claimed: `writeAtomic` is per-path, so two files mean two renames with a real crash window between them.
 * ORDERED COMMIT: the target insert is durable BEFORE the destructive source retirement, so a crash between the renames leaves
 * duplication — recoverable — where the inverse ordering would lose the span. DURABLE INTENT: the `cut_intent` row and the
 * transaction-tagged undo rows land before the first rename, so a half-applied call is detectable. REPAIR: `repairCutIntents`
 * (src/cut-repair.ts, run on every live apply) resolves an orphaned intent to complete-the-cut or restore-both from the stored
 * pre/post bytes. A source's retirement reuses the ordinary deletion-edit shape, so it loads, lease-verifies and span-gates like any
 * edit; the raw pre-images are captured before the first rename, so the undo rows and a ROLLBACK write those same bytes, never the
 * canonical fold; and a stale intent row left after a full commit resolves to all-committed and drops itself.
 */
async function runCutTransaction(
  file: ProcessedEditFile,
  cwd: string,
  options: PipelineOptions | undefined,
  sessionKey: string,
) {
  const groups = new Map<string, ForeignCutRecord[]>();
  for (const cut of file.foreignCuts) {
    const list = groups.get(cut.absolutePath);
    if (list) list.push(cut);
    else groups.set(cut.absolutePath, [cut]);
  }
  const sourcePlans: ProcessedEditFile[] = [];
  for (const absolutePath of [...groups.keys()].sort()) {
    const cuts = groups.get(absolutePath)!;
    const req: NormalizedEditRequest = {
      file: cuts[0]!.refFile,
      edits: cuts.map((cut) => ({
        target: { anchor_from: cut.spanFrom, anchor_to: cut.spanTo },
        at: "in-place" as const,
        payload: { kind: "empty" as const },
      })),
    };
    sourcePlans.push(
      await runMutations(req, cwd, {
        ...options,
        sessionKey,
        accessMode: options?.accessMode ?? constants.R_OK | constants.W_OK,
      }),
    );
  }

  const plans = [file, ...sourcePlans];
  const txnId = randomUUID();

  const rawPreBytes = new Map<string, Buffer>();
  for (const plan of plans) {
    rawPreBytes.set(plan.absolutePath, await readBytes(plan.absolutePath));
  }
  const saved: { restore: () => Promise<void> }[] = [];
  for (const plan of plans) {
    const undo = await saveUndo(plan.absolutePath, {
      content: plan.originalNormalized,
      bom: plan.bom,
      originalEnding: plan.originalEnding,
      effectiveEnding: plan.effectiveEnding,
      hashes: plan.originalHashes,
      resultContent: plan.result,
      transactionId: txnId,
      rawPre: rawPreBytes.get(plan.absolutePath)!.toString("utf-8"),
    });
    if (!undo.persisted) {
      for (const prior of saved) await prior.restore();
      throw new DomainError("E_UNDO_UNAVAILABLE", { path: plan.path });
    }
    saved.push(undo);
  }
  try {
    await saveCutIntent(txnId, file.absolutePath);
  } catch (error) {
    for (const prior of saved) await prior.restore();
    throw error;
  }

  const written: ProcessedEditFile[] = [];
  try {
    if (options?.onBeforeFirstCutWrite) {
      await options.onBeforeFirstCutWrite();
    }
    abortIf(options?.signal);
    await writeAtomic(
      file.absolutePath,
      file.bom + restoreEndings(file.result, file.effectiveEnding),
    );
    if (file.eolRewriteWarning !== undefined) file.warnings.push(file.eolRewriteWarning);
    written.push(file);
    for (const plan of sourcePlans) {
      if (options?.onCutBetweenWrites) {
        await options.onCutBetweenWrites(written[written.length - 1]!.absolutePath);
      }
      abortIf(options?.signal);
      await writeAtomic(
        plan.absolutePath,
        plan.bom + restoreEndings(plan.result, plan.effectiveEnding),
      );
      if (plan.eolRewriteWarning !== undefined) plan.warnings.push(plan.eolRewriteWarning);
      written.push(plan);
    }
  } catch (error) {
    let rolledBack = true;
    for (const plan of written) {
      try {
        await writeAtomic(plan.absolutePath, rawPreBytes.get(plan.absolutePath)!);
      } catch (rollbackError) {
        rolledBack = false;
        reportDiagnostic(
          "mutation-engine",
          "Failed to roll back a cut-transaction file:",
          rollbackError,
        );
      }
    }
    if (rolledBack) {
      for (const prior of saved) await prior.restore();
      try {
        await dropCutIntent(txnId);
      } catch (dropError) {
        reportDiagnostic(
          "mutation-engine",
          "Failed to drop the cut intent after rollback:",
          dropError,
        );
      }
    }
    // Ref: docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md
    throw error;
  }

  try {
    await dropCutIntent(txnId);
  } catch (error) {
    reportDiagnostic("mutation-engine", "Failed to clear the cut intent after commit:", error);
  }

  const sections = [];
  for (const plan of plans) {
    sections.push(toSection(plan, await finishCommittedFile(plan, options, sessionKey)));
  }
  const toolResult = buildBatchResult(sections);
  const drift = plans
    .map((p) => p.driftNotice)
    .filter((d): d is string => d !== undefined)
    .join("\n\n");
  return {
    result: file.result,
    diff: toolResult.details.diff ?? "",
    drift: drift === "" ? undefined : drift,
    metrics: toolResult.details.metrics,
    raw: file,
    toolResult,
  };
}

/**
 * Repair runs first: a previous run that crashed inside a cut's two-rename window left a durable intent, and
 * it must be resolved before this call layers undo rows and leases over that state. A cut transaction
 * serializes EVERY file it will rename for the whole plan+commit, and the queues are taken in sorted order so
 * two calls with swapped target/source cannot deadlock; copy items never widen the lock set, because a copy's
 * foreign file stays read-only.
 */
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
    const toolResult = buildBatchResult([toSection(file, renderedDiffFor(file))]);
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

  await repairCutIntents(options?.store);

  const path = request.file;
  const absolutePath = toCwd(path, cwd);
  const mutationTargetPath = await resolveTarget(absolutePath);
  const sessionKey = requireSessionKey(options?.sessionKey);

  const cutSourcePaths: string[] = [];
  for (const item of request.edits) {
    if (item.payload.kind !== "reference" || item.payload.mode !== "cut") continue;
    const refFile = await foreignRefFileOf(item, { cwd, file: path });
    if (refFile === undefined) continue;
    cutSourcePaths.push(await resolveTarget(toCwd(refFile, cwd)));
  }

  return withSortedMutationQueues([mutationTargetPath, ...cutSourcePaths], async () => {
    abortIf(options?.signal);

    const file = await runMutations(request, cwd, {
      ...options,
      sessionKey,
      accessMode: options?.accessMode ?? constants.R_OK | constants.W_OK,
    });

    if (file.appliedCount === 0) {
      const toolResult = buildBatchResult([toSection(file, renderedDiffFor(file))]);
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

    if (file.foreignCuts.length > 0) {
      return await runCutTransaction(file, cwd, options, sessionKey);
    }

    const undo = await saveUndo(mutationTargetPath, {
      content: file.originalNormalized,
      bom: file.bom,
      originalEnding: file.originalEnding,
      effectiveEnding: file.effectiveEnding,
      preImageMixed: file.preImageMixed,
      hashes: file.originalHashes,
      resultContent: file.result,
    });
    if (!undo.persisted) {
      throw new DomainError("E_UNDO_UNAVAILABLE", { path });
    }
    try {
      abortIf(options?.signal);
      await writeAtomic(
        file.absolutePath,
        file.bom + restoreEndings(file.result, file.effectiveEnding),
      );
      if (file.eolRewriteWarning !== undefined) file.warnings.push(file.eolRewriteWarning);
    } catch (error) {
      await undo.restore();
      throw error;
    }
    const diffInfo = await finishCommittedFile(file, options, sessionKey);

    const toolResult = buildBatchResult([toSection(file, diffInfo)]);
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
