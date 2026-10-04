/**
 * SAFETY: EditPipeline — Strong, in-process atomic mutation seam.
 *
 * Deepened pipeline that hoists the whole edit mutation behind one
 * seam: load → parse → span gate (batches) → mutate loop → finalize
 * hashes → drift → persist. Cohesive stage owners live beside the
 * orchestration: `edit-source.ts` (file load, lease identity source,
 * session-key boundary), `batch-span-gate.ts` (baseline span
 * resolution, batch disjointness, working-buffer identity), and
 * `edit-response.ts` (model-facing batch envelope: abort wrappers,
 * atomicity trailer, batch sections). `recordRejectionServe` and the
 * mutate loop stay here with the orchestration.
 *
 * Phase ordering is load-bearing — do not reorder without updating
 * drift/undo/serve invariants:
 *
 *   Admission (edit.ts: TypeBox + assertReq)
 *     → Foreign pre-pass (`materializeForeignReferences`: when any item names
 *       another served file, that SECOND file is read and lease-resolved here,
 *       memoized per resolved path — a read-only load ahead of Load whose
 *       refusal aborts the whole call before the target is even read)
 *     → Load (edit-source: readNorm + served state)
 *     → Parse & Validate (resEdit; warnings local, no servePolicy)
 *     → Span gate (batches only: baseline spans resolved through
 *       `resolveLeasedEdit`, disjointness asserted)
 *     → Mutate loop, for each HEdit: applyEdit → resolveLeasedEdit
 *         ├─ reject: recordRejectionServe (handle.recordServeFeedback)
 *         │          + batch-abort envelope
 *         ├─ noop:   runNoopPolicy
 *         └─ applied: lineHashes (in-memory) + per-edit intervals
 *     → Finalize: dense lineHashes when anything applied
 *       (`persist: false` — the working buffer commits only in `apply`)
 *     → Drift: scanDrift over the per-edit intervals (one statement
 *       below — interval-aware, no union-gap caveat)
 *     → Persist (live only, in `apply`): saveUndo → writeAtomic;
 *       on write failure: restore undo. A foreign-source `mode: "cut"` (ticket-04b) extends this
 *       to an ORDERED multi-file commit: undo rows for every file plus a durable intent record
 *       before the first rename, the target insert committed BEFORE the destructive source
 *       retirement, best-effort rollback otherwise, and next-run repair for anything in
 *       between (ADR-0028 — no filesystem atomicity is claimed anywhere).
 *     → Serve (live only, in `apply`): upsertSnapshotFor (snapshot +
 *       lineage + retirement + diff leases + dense serve mirror rows in
 *       ONE transaction — CAND-3); rejection serves were already
 *       recorded on the reject path
 *
 * Atomic guarantee: if any mutate step throws (anchor/served/noop-loop)
 * persist is skipped and the file is unchanged. Warnings are owned
 * locally — not passed by ref across modules. servePolicy string is
 * internal (live vs preview) and not exposed.
 *
 * Drift is interval-aware: the pipeline tracks per-edit ResolvedRange[]
 * (editedIntervals) and Drift scans per-interval (not union). Gaps
 * between disjoint edits are correctly reported as drift; no
 * Batch drift note warning is emitted. Per-interval deltaBefore
 * maps served positions to current positions.
 *
 * Vocabulary (CONTEXT.md): range, span, served span, drift, drift
 * notice, reject-and-serve, payload contract — preserved.
 */

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { genDiff, restoreEndings } from "../edit-diff.js";
import { abortIf, assertNever, splitLines, visLines } from "../utils.js";
import type { HashStore } from "../hash-store.js";
import { loadHashStore } from "../hash-store.js";
import { snapshotIOFor, upsertSnapshotFor, snapshotHashFor } from "../snapshot-store";
import {
  applyEdit,
  buildNeverServedEditHint,
  resEdit,
  type HEdit,
  type NEdit,
} from "../hashline/index.js";
import { defaultHashIdentity, lineHashes } from "../hashline/hash-identity.js";
import { HASH_LEN } from "../hashline/alphabet.js";
import { denseServeRows, type ResolvedRange } from "../hashline/served.js";
import { resolveLeasedEdit } from "../hashline/lease-resolve.js";
import type { FileSnapshotContext } from "../hashline/served-verification.js";
import { DomainError, formatWarning, type DomainErrorCode } from "../domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "../served-spans.js";
import { createSessionHandle } from "../served-session/session.js";
import { scanDrift } from "../drift.js";
import { clearNoopLoop, runNoopPolicy } from "../noop-guard.js";
import { clearServedRefusals } from "../hashline/served-guard.js";
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
  // WHY: an insertion removes no line — treating its target span as removed would retire the
  // WHY: identity of a line that survives byte-identical next to the splice point.
  if (edit.placement !== "before" && edit.placement !== "after") {
    addSpan(edit.hash_bounds[0].hash, edit.hash_bounds[1].hash);
  }
  // WHY: (ticket-02, invariant 7) a move's retired source span joins the removed-hash union
  // WHY: regardless of the target's placement; a copy (retire false) removes nothing.
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
    // WHY: an insertion adds its lines and removes none (see `collectRemovedHashes`).
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
  /**
   * The working buffer's own `line_id` map (spec §3.2.4 step 1), entry `i` naming line `i + 1`.
   * Present for a live batch: identity resolution reads it directly instead of re-deriving positions
   * by pairing the intermediate buffer against `S_latest`, which cannot tell two byte-identical lines
   * apart. Absent for preview, where no identity map is in flight.
   */
  currentIds?: (number | null)[];
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
      // WHY: read/write agreement — the verify path is literally the same
      // WHY: canonical absolute path the `hashesFor` call below uses (one field).
      filePath: input.absolutePath,
      absolutePath: input.absolutePath,
      sessionKey: input.sessionKey,
      served: input.served,
      ...(input.canonDigests !== undefined ? { canonDigests: input.canonDigests } : {}),
      identity,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    });
  } catch (error) {
    if (error instanceof DomainError) {
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
  const nextHashes = await defaultHashIdentity.hashesFor(nextContent, {
    path: input.absolutePath,
    prior: { content: input.content, hashes: input.hashes, removedHashes },
    // WHY: the working buffer is strictly in-memory (spec §3.2.4): no snapshot is written and no
    // WHY: lease is retired until the batch commits S_final to disk. Persisting here made a batch
    // WHY: that wrote nothing retire every anchor the session still validly held.
    persist: false,
    snapshotIO: snapshotIOFor(input.store),
    // SAFETY: blockedHashes passed as ReadonlySet via unknown for HashIdentity compatibility — input.blockedHashes is already typed, cast preserves immutability
    blockedHashes: input.blockedHashes as unknown as ReadonlySet<string> | undefined,
    // SAFETY: the options object is typed by HashIdentity's internal parameter shape, which the
    // SAFETY: caller never sees; every field above is already typed, so the cast widens nothing.
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
 * Records the reject-and-serve rows a rejected edit owes the model, so the anchors it serves are
 * usable without a re-read (README reject-and-serve contract). The pre-mutation span gate and the
 * sequential mutate loop share it, so a rejection records the same serves whichever one catches it.
 */
async function recordRejectionServe(args: {
  error: DomainError;
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
  // WHY: a preview is a containment boundary — its served rows are a rehearsal of the same edit, so
  // WHY: mirroring them would let an edit that was never applied satisfy the read guard.
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
 * WHY: (ticket-01 hardening, ticket-04 rename) the single exhaustive view of the payload union for
 * WHY: text consumers — the noop-loop tracker discriminates its noop episodes with this. A new
 * WHY: union arm must add a case here or `assertNever` fails `pnpm run typecheck`. The `reference`
 * WHY: arm renders as its span's anchors with the mode word, never a placeholder empty text: the
 * WHY: copied content is not known here, and collapsing every non-literal arm to "" would fuse
 * WHY: distinct noop episodes into one count.
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
 * WHY: (ticket-04 §3.6) an `empty` payload with `"before"`/`"after"` parses to a NO-OP marker, not
 * WHY: to an HEdit: the mutate loop counts the item as a noop and warns the model channel; it
 * WHY: never reaches `applyEdit` and never consults the noop-loop tracker (no bytes are rewritten,
 * WHY: so there is no repeated-content episode to count).
 */
type ParsedItem = { edit: HEdit } | { noopInsert: true };

function parseEdits(items: NormalizedEditRequest["edits"], path: string): ParsedItem[] {
  const parsed: ParsedItem[] = [];
  // WHY: payload parsing aggregates like the span gate — one malformed item must not mask another,
  // WHY: so the model fixes every malformed item in a single resubmission. Parsing is pure (no
  // WHY: mutation runs before it), so collecting every failure preserves atomicity trivially.
  const failures: { error: Error; index: number }[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    try {
      const payload = item.payload;
      let text: string;
      let source: { anchor_from: string; anchor_to: string; retire: boolean } | undefined;
      switch (payload.kind) {
        case "literal":
          // WHY: (remediation-2 B4) the min-line guard must sit where the destructive behaviour is
          // WHY: reachable: `execute()` never calls `assertReq`, so a directly-constructed
          // WHY: `{kind:"literal", text:""}` used to delete the span and report success (the wire
          // WHY: folds `"text": ""` into the deletion payload and can never produce this shape —
          // WHY: only engine-seam construction can). Mirror item (iv): refuse LOUD at the seam,
          // WHY: naming the wire field `"text"` with the admission message verbatim.
          if (payload.text === "") {
            throw new DomainError("E_BAD_PAYLOAD", {
              message:
                `Edit request edits[${index}] "text" must carry at least one line; ` +
                `"text": "" is the deletion payload. Nothing was written.`,
            });
          }
          text = payload.text;
          break;
        case "reference":
          // WHY: (keel F3) the `reference` payload carries the mode twice — `payload.mode` and
          // WHY: `span.mode` — and only the top-level one is consumed below; a disagreement is
          // WHY: refused, not silently resolved in favor of one arm. Admission always folds the
          // WHY: wire `text_ref` verbatim, so this fires only on a directly-constructed payload.
          if (payload.span.mode !== payload.mode) {
            throw new DomainError("E_BAD_PAYLOAD", {
              message:
                'The "text_ref" payload is inconsistent: its "mode" disagrees with the mode carried by the span it names. Nothing was written.',
            });
          }
          // WHY: the copied lines are content the caller does not hold — `applyEdit` materializes
          // WHY: them from the resolved source span before any gate or splice runs, so the parse
          // WHY: seam carries the span, never a placeholder text. A foreign-source span (a
          // WHY: `text_ref` naming another served file) has already been materialized to a
          // WHY: `literal` payload by the pre-pass in `runMutations`, so this span names THIS file.
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

// WHY: (§9.4, review-3 P3-3) foreign-vs-same-file is a RESOLVED-PATH question, not a spelling
// WHY: question: `./target.txt` and `target.txt` name one file, so a legal same-file `mode:"cut"`
// WHY: must take the intra-file path and a same-file copy must keep the `text_ref` metrics.
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

// WHY: (item (ii)) the three never-served codes pass through UNCHANGED regardless of how many
// WHY: rows a producer attaches: the payload-length proxy below (§0's pinned pass-through) is
// WHY: correct today only because no producer carries rows there — a code set is the honest rule.
const NEVER_SERVED_FOREIGN_CODES: ReadonlySet<DomainErrorCode> = new Set([
  "E_UNKNOWN_ANCHOR",
  "E_FOREIGN_ANCHOR",
  "E_STALE_ANCHOR",
]);

// WHY: (item (ii)) these codes HOLD a lease — retirement or drift must surface with the code that
// WHY: means it, never rewritten as E_STALE_ANCHOR with its "no read is needed" remedy.
const LEASED_FOREIGN_PASSTHROUGH_CODES: ReadonlySet<DomainErrorCode> = new Set([
  "E_UNVERIFIED_RANGE",
  "E_STALE_RANGE",
  "E_TARGET_LOST",
]);

/**
 * A foreign-source rejection never renders unleased rows: the rows a leased-range rejection names
 * belong to the FOREIGN file's mirror, and this call must not lease anything it did not write
 * (`loadForeignServedView` is the read-only authority). Rows are therefore SERVED or ABSENT —
 * the leased codes are re-wrapped HERE with their rows dropped and `refFile` named, except
 * `E_TARGET_LOST`, whose format already names the file and carries no rows, so it passes through.
 * §0's never-served pass-through below stays (its exact-code pins ride it); the length guard in
 * it is SHADOWED by the code-set check and is NOT the enforcement point.
 * WHY: (B6, ISSUE-6 repo half — second recurrence) a never-served foreign anchor is ticketed to
 * WHY: the `W_NEVER_SERVED_SHAPE` soft hint, but it surfaces as a hard rejection here, and that
 * WHY: deviation is structural: `[W_*]` codes are the APPLIED tier — `warnBlock` renders them only
 * WHY: on a result that mutated — and a foreign failure aborts before any apply, so the channel
 * WHY: that would carry the hint never exists for this call.
 */
function foreignRejection(error: unknown, refFile: string): DomainError {
  if (error instanceof DomainError) {
    // WHY: (§0) kept per §0, but FULLY SHADOWED by the code-set check below (mutation M9 → 0 red):
    // WHY: every code it matches is already in `NEVER_SERVED_FOREIGN_CODES`. It is not the
    // WHY: enforcement point — do not describe it as one.
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
      // WHY: (item A) `E_TARGET_LOST` already satisfies served-or-absent: its format names the
      // WHY: file (the foreign snapshot always carries `filePath`) and renders no rows.
      if (error.code === "E_TARGET_LOST") return error;
      return foreignLeasedWrap(error, refFile);
    }
    // WHY: (§9.9) the fallback claims `cause: "never-served"` — that is only honest for failures
    // WHY: with no lease behind them. Derive the inner typed cause when it has one, so a
    // WHY: retirement/drift shape that reaches here can never surface a dishonest cause in the
    // WHY: envelope-validated RangeCause union.
    const cause = error.cause ?? error.details.cause ?? "never-served";
    return new DomainError("E_STALE_ANCHOR", {
      headline:
        `the foreign-source reference to ${refFile} does not resolve against that file's served state ` +
        `(rejection: ${error.code}). Nothing was written; read ${refFile} and copy fresh anchors from its served rows.`,
      cause,
    });
  }
  return new DomainError("E_STALE_ANCHOR", {
    headline: `the foreign-source reference to ${refFile} did not resolve. Nothing was written.`,
    cause: "never-served",
  });
}

// WHY: (remediation-2 item A) served-or-absent for a foreign leased failure: the inner fresh-read
// WHY: rows belong to the FOREIGN file and were never leased by this call, so they are dropped and
// WHY: the headline names `refFile` — the model re-reads the foreign file itself. The code is
// WHY: preserved verbatim (§0's exact-code pins): retirement or drift must still surface under the
// WHY: code that means it, never rewritten as `E_STALE_ANCHOR` with its "no read is needed" remedy.
function foreignLeasedWrap(error: DomainError, refFile: string): DomainError {
  const headline =
    `the foreign-source reference to ${refFile} no longer resolves against that file's served ` +
    `state (rejection: ${error.code}). No rows of ${refFile} were served by this call. Nothing ` +
    `was written; read ${refFile} and copy fresh anchors from that read.`;
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
  // WHY: fail closed — the caller's code set admits only the two arms above plus `E_TARGET_LOST`,
  // WHY: which passes through untouched; a set edited without extending this wrap must be loud.
  throw error;
}

/**
 * Foreign-source copy (ticket-04 §3.3) and the cut record (ticket-04b): a `text_ref` naming
 * another served file is read from that file's CURRENT content through the READ-ONLY half of the
 * lease seam and collapsed to a `literal` payload BEFORE the mutate loop, so a foreign resolution
 * failure aborts the whole call atomically (nothing has been mutated yet) and every downstream
 * gate runs on the bytes that will be written. The read+load+lease assembly is
 * `loadForeignServedView` (edit-source.ts) — one entry, memoized per resolved path by
 * `materializeForeignReferences`.
 *
 * SAFETY: the pre-pass read is read-only by construction, not by convention:
 *  - `loadForeignServedView` is built on `readNormFile(..., { noPersist: true })` — the loader
 *    gates every snapshotIO.upsert (snapshot, lineage, leases) behind that flag;
 *  - `leaseSpanSource` exposes only `leaseFor`/`rebasedLineOf`/`anchorHomes` — resolution never
 *    re-stamps a lease and never writes `retired_at`;
 *  - the loop never calls `recordServeFeedback`/`record`/`retire`/`grant` for the foreign path.
 * For `mode: "copy"` that is the whole story: the foreign path is never written. For
 * `mode: "cut"` (ticket-04b) the file is instead edited LATER as a first-class transaction
 * member — its own `runMutations` load, verification, undo row, and store commit — under
 * `runCutTransaction`; this pre-pass itself still persists nothing.
 */
async function materializeForeignItem(
  item: NormalizedEditItem,
  refFile: string,
  view: ForeignServedView,
  cuts: ForeignCutRecord[],
): Promise<NormalizedEditItem> {
  const payload = item.payload;
  if (payload.kind !== "reference") return item;
  // WHY: (keel F3) same agreement rule as the parse seam — check before anything else consumes
  // WHY: the mode, so a disagreement can never decide between the arms implicitly.
  if (payload.span.mode !== payload.mode) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'The "text_ref" payload is inconsistent: its "mode" disagrees with the mode carried by the span it names. Nothing was written.',
    });
  }
  // WHY: (ticket-04b) ticket-04 item (iv) refused a foreign `mode: "cut"` here because the
  // WHY: pre-pass had no retirement target — enabling cut without a transaction would report
  // WHY: success and leave the source behind. That refusal is DELETED deliberately: the
  // WHY: correlated multi-file transaction (`runCutTransaction`, ADR-0028) is the missing half,
  // WHY: and the cut's retirement now rides the recorded entry below. `edit.foreign-cut.test.ts`
  // WHY: and `edit.wire-contract.test.ts` witness both halves of that history.
  const { fileLines } = view;
  const snapshot: FileSnapshotContext = {
    fileLines,
    fileHashes: view.fileHashes,
    filePath: refFile,
  };
  // WHY: the SAME seam as every served span: leased identity first, fail-closed on a missing or
  // WHY: retired lease, whole-window verified — the foreign half is read-only, the semantics are
  // WHY: identical to an intra-file `text_ref`.
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
    // WHY: the SUBMITTED span anchors are recorded, not the resolved line numbers: the source
    // WHY: transaction re-resolves them through its own leases, so a shift between this read and
    // WHY: that load rebases honestly and any real drift fails closed BEFORE the first rename.
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

// WHY: (ticket-04 item (i)) `parseText` maps "" → [] and N newlines → N blank lines
// WHY: (`src/hashline/parse.ts:76-77`) — the INVERSE of `join("\n")` — so joining an all-blank
// WHY: span loses exactly one line (two blanks → one) and a single blank collapses to "" (zero
// WHY: lines). Emitting the wire's own all-blank convention reuses the already-pinned
// WHY: serialization instead of inventing a third encoding; mixed spans join exactly, as before.
function collapseSpanToText(span: string[]): string {
  if (span.length > 0 && span.every((line) => line.length === 0)) {
    return "\n".repeat(span.length);
  }
  return span.join("\n");
}

async function materializeForeignReferences(
  items: NormalizedEditItem[],
  input: { cwd: string; file: string; store: HashStore; sessionKey: string },
): Promise<{ items: NormalizedEditItem[]; cuts: ForeignCutRecord[] }> {
  const refFiles = await Promise.all(items.map((item) => foreignRefFileOf(item, input)));
  const cuts: ForeignCutRecord[] = [];
  if (!refFiles.some((refFile) => refFile !== undefined)) return { items, cuts };
  // WHY: (item (v), §10) one read+load+lease per RESOLVED absolute path per batch: without the
  // WHY: memo, each item performs its own fresh disk read and store SELECT, so a foreign file
  // WHY: changing on disk BETWEEN two items materializes TWO revisions into one call with no
  // WHY: diagnostic — correctness, not performance. The map is batch-scoped (this call only); a
  // WHY: global cache would serve stale served state across calls.
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

async function runMutations(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<ProcessedEditFile> {
  // WHY: the file was answered at admission (assertReq); the narrowed type carries it here.
  const path = request.file;
  const mode = request.mode ?? "general";
  const hashStore = options?.store ?? (await loadHashStore());
  const sessionKey = requireSessionKey(options?.sessionKey);
  // WHY: (ticket-04 §3.3) the foreign-source pre-pass runs before ANY parse or mutation: a
  // WHY: `text_ref` naming another served file is materialized to a `literal` payload here, so a
  // WHY: foreign resolution failure aborts the call atomically with the target not yet loaded.
  const { items, cuts: foreignCuts } = await materializeForeignReferences(request.edits, {
    cwd,
    file: path,
    store: hashStore,
    sessionKey,
  });
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
  // WHY: (ticket-04 §3.6) noop-insert markers mutate nothing, so they are not part of the batch
  // WHY: span gate — the gate compares regions the call will rewrite.
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
  } = await loadEditFile({
    path,
    cwd,
    signal: options?.signal,
    accessMode: options?.accessMode,
    sessionKey,
    store: hashStore,
    noPersist: options?.noPersist,
  });

  // WHY: (04b-rem P2-3) the admission round-trip guard: anchors were derived from the DECODED
  // WHY: text, so bytes that do not re-encode identically cannot be restored by any line-
  // WHY: addressed write — refuse before anything mutates, making every later byte-identity
  // WHY: claim in this module true by construction. The read path keeps disclosing such files;
  // WHY: only the edit path refuses.
  if (hadUtf8DecodeErrors) {
    throw new DomainError("E_LOSSY_TEXT", { path });
  }

  if (realEdits.length > 1) {
    // WHY: the baseline identity seam is built from the pre-batch `S_curr`, so a span the gate
    // WHY: compares is the `s'_k` the apply path would rewrite — one source for both (spec §3.2.1).
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
      isPreview,
      path,
      originalHashes,
      originalNormalized,
      recordRejectionServe,
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
  // WHY: in-memory during the batch. `batchBlockedHashes` starts from the store snapshot and grows
  // WHY: with each applied item's removals, so later items still observe earlier removals for
  // WHY: hash-allocation and verification without any store write before `writeAtomic`.
  // WHY: `accumulatedRemoved` is the post-commit payload, retired once after the bytes are on disk.
  let baseCanonDigests: (string | null)[] = [];
  try {
    baseCanonDigests = await createSessionHandle(
      sessionKey,
      absolutePath,
      hashStore,
    ).loadCanonDigests();
  } catch (error) {
    console.error("Failed to load served canon digests for batch:", error);
    baseCanonDigests = [];
  }
  const batchBlockedHashes = new Set<string>();
  try {
    for (const hash of await createSessionHandle(
      sessionKey,
      absolutePath,
      hashStore,
    ).loadBlockedHashes()) {
      batchBlockedHashes.add(hash);
    }
  } catch (error) {
    console.error("Failed to load legacy blocked hashes for batch:", error);
  }
  const accumulatedRemoved = new Set<string>();

  for (let index = 0; index < items.length; index++) {
    abortIf(options?.signal);
    const item = items[index]!;
    const parsedItem = parsed[index]!;
    if ("noopInsert" in parsedItem) {
      // WHY: (ticket-04 §3.6) an empty "before"/"after" writes nothing by construction: bytes
      // WHY: unchanged, counted as a noop, model channel warned. It skips `applyEdit` AND the
      // WHY: noop-loop tracker — that tracker counts repeated content REWRITES, not this.
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
      signal: options?.signal,
      served,
      blockedHashes: batchBlockedHashes,
      canonDigests: baseCanonDigests,
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
    // WHY: (ticket-02) a move's retired source is an edited interval too: the drift scan must
    // WHY: see its negative delta, and the union must cover the lines it removed.
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
      });
      // WHY: a looping item of a multi-item call rejects through the same
      // WHY: batch envelope as every other rejection — the failing item, its
      // WHY: own `[E_NOOP_LOOP]` diagnostic, and the atomicity trailer — so the
      // WHY: model knows the earlier items were rolled back too. Single-item
      // WHY: calls keep the direct rejection path.
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
    // WHY: (ticket-02, invariant 8) a span-ref item reports its own honest counts — inserted
    // WHY: lines and retired-source-plus-replaced-target removals — because `countLineChanges`
    // WHY: can only see the target span.
    const stats = outcome.mutationStats;
    const { totalAddedLines: added, totalRemovedLines: removed } = stats
      ? { totalAddedLines: stats.addedLines, totalRemovedLines: stats.removedLines }
      : countLineChanges(edit, originalHashes, false);
    totalAddedLines += added;
    totalRemovedLines += removed;
    // WHY: (#117, spec §3.2.4 step 4) no store mutation before `writeAtomic`. The removed hashes
    // WHY: accumulate in-memory for the post-commit legacy retire; `batchBlockedHashes` keeps later
    // WHY: items observing earlier removals without touching the store, so a failed batch retires
    // WHY: nothing.
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
        // WHY: (ticket-02) a span-ref item mutates up to two regions of the same pre-item buffer
        // WHY: (target, retired source), so each is spliced into the identity map in descending
        // WHY: start order — every region's coordinates then still name the pre-item lines, and a
        // WHY: region the item skipped as a noop never shifts the map.
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
  };
}

export async function previewEdits(
  request: NormalizedEditRequest,
  cwd: string,
  options?: Omit<PipelineOptions, "noPersist">,
) {
  return runMutations(request, cwd, { ...options, noPersist: true });
}

// WHY: (ticket-04b §2) nested queues in deterministic SORTED order (`withSortedMutationQueues`,
// WHY: src/mutation-queue.ts): the cut transaction holds a lock for every file it will rename
// WHY: across the whole plan+commit, and two calls whose file sets overlap in different orders
// WHY: can never deadlock. Dedup first: a same-file cut shape (resolved equal) collapses to one
// WHY: queue and takes the intra-file path anyway.

/**
 * The post-write commit for ONE file whose bytes are already on disk: the refusal/noop-loop
 * tally clears, the legacy retire mirror, and the authoritative snapshot/lineage/lease/served-
 * mirror transaction. Shared verbatim by the single-file path and `runCutTransaction` — one
 * materialization owner for every committed file. Returns the diff info for the batch section.
 */
async function finishCommittedFile(
  file: ProcessedEditFile,
  options: PipelineOptions | undefined,
  sessionKey: string,
): Promise<ReturnType<typeof genDiff>> {
  // WHY: the clear side of the tally, separated from verification: the refusal count was
  // WHY: recorded while the edit was still uncommitted, and only this committed write —
  // WHY: bytes on disk — retires it, per session, so another session's tally stays its own.
  clearServedRefusals(sessionKey, file.absolutePath);
  // WHY: the noop-loop tracker clears only here, after the bytes are on disk, beside the
  // WHY: served-refusal tracker — the counters reflect committed reality. An edit that writes
  // WHY: nothing (rejected batch, E_UNDO_UNAVAILABLE, writeAtomic rollback) never reaches this
  // WHY: site, so its counters survive for the resubmission to trip on.
  clearNoopLoop(sessionKey, file.absolutePath);

  // WHY: S_final is the edit path's only authoritative materialization (spec §3.2.4 step 4): it is
  // WHY: deliberately deferred to here, after the bytes are on disk, so an edit that writes nothing
  // WHY: (rejected batch, E_UNDO_UNAVAILABLE, writeAtomic rollback) can never retire a lease the
  // WHY: session still validly holds. Retirement must not happen in runMutations, which materializes
  // WHY: the working buffer while saveUndo/writeAtomic can still fail.
  // WHY: (#117) the legacy v6 `served.retired` mirror retires once here, after the bytes are on
  // WHY: disk, from the batch's in-memory accumulation. A failed batch never reaches this point,
  // WHY: so it retires no blocked hashes. Best-effort with context on failure: the bytes already
  // WHY: committed, so the edit succeeds with a deferred-sync warning, never a silent swallow.
  if (file.removedHashes.size > 0) {
    try {
      const legacyHandle =
        options?.store === undefined
          ? createSessionHandle(sessionKey, file.absolutePath)
          : createSessionHandle(sessionKey, file.absolutePath, options.store);
      await legacyHandle.retire(file.removedHashes);
    } catch (error) {
      console.error("Failed to retire legacy blocked hashes after write:", error);
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
  const denseRows = denseServeRows(file.resultHashes);
  try {
    // WHY: the served diff rows are step 5 of the commit transaction (spec §3.2.4 step 4):
    // WHY: snapshot + lineage + retirement + leases share one `BEGIN IMMEDIATE`, so a lease
    // WHY: failure rolls the snapshot back instead of leaving snapshot-without-leases behind.
    // WHY: CAND-3 adds step 6 — the served mirror write (`servedMirror`) — to the same
    // WHY: transaction: a lease committed with the mirror missing (false `E_STALE_RANGE` at the
    // WHY: boundary gate) or mirror rows without a lease (ADR-0023: no evidence at all) are now
    // WHY: structurally unreachable; one failure means one full rollback and the one
    // WHY: DEFERRED_STORE_SYNC_WARNING below — never a half-committed store.
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
        // WHY: the mirror shape reproduces `recordDiff`'s truncation plan
        // WHY: (`planServeRecording({resultLineCount, firstChangedLine})`) exactly — the same
        // WHY: clamp/clear/patch, the same displaced-anchor retirement — inside this transaction.
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
    // SAFETY: best-effort post-write materialization — the edit already committed; a store failure
    // SAFETY: leaves the in-memory hashes authoritative and the next read re-materializes and
    // SAFETY: retires. SPEC §3.6.2: the bytes are on disk, so the tool reports success but must
    // SAFETY: warn that store synchronization is deferred.
    console.error("Failed to commit post-write snapshot materialization:", error);
    file.warnings.push(DEFERRED_STORE_SYNC_WARNING);
  }
  return diffInfo;
}

/**
 * (ticket-04b §2) The foreign-source cut as one correlated multi-file transaction (ADR-0028). NO
 * FILESYSTEM ATOMICITY IS CLAIMED: `writeAtomic` is per-path, so two files mean two renames
 * with a real crash window between them. The honest guarantee is three-part:
 *
 *  1. ORDERED COMMIT — the target insert is durably committed BEFORE the destructive source
 *     retirement. A crash between the renames leaves the copy at the target and the span still
 *     at the source — duplication, recoverable; the inverse ordering would be data loss. This
 *     ordering is the spine of the design.
 *  2. DURABLE INTENT — every file's undo row carries the transaction id and a `cut_intent` row
 *     names the transaction before the first rename, so a half-applied transaction is
 *     detectable on the next run.
 *  3. REPAIR — `repairCutIntents` (src/cut-repair.ts, run on every live apply) resolves an
 *     orphaned intent to complete-the-cut OR restore-both-files from the rows' pre/post bytes,
 *     losing no content in either resolution.
 *
 * Every failure before the first rename leaves every file untouched (the plans run in-memory
 * first and any throw aborts the call); failures inside the window roll back the written files
 * best-effort, and a rollback that does not hold LEAVES THE INTENT ROW for repair.
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
    // WHY: the retirement is a deletion payload over the SUBMITTED anchors — the ordinary edit
    // WHY: shape — so the source gets its own load, its own lease verification, and its own
    // WHY: batch-span gate: overlapping retire spans in one source abort the WHOLE call before
    // WHY: any rename, which is §5's disjointness-across-both-files requirement.
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

  // WHY: STEP 1 durable pre-images: undo rows for EVERY file (pre bytes + post bytes + the
  // WHY: shared transaction id), then the intent record — all BEFORE the first rename.
  // WHY: (04b-rem P2-2/P2-3) the RAW pre-images are captured FIRST, so every consumer below — the
  // WHY: rows' `raw_pre` and the rollback — reads the SAME bytes that were on disk before the
  // WHY: first rename. Byte identity is not promised by this read, it is PROVEN upstream: the
  // WHY: admission round-trip guard refused any file whose decoded text re-encodes differently,
  // WHY: so decode/encode here is lossless by construction, stray line-break spellings included
  // WHY: (ticket-04b §11: after an abort BOTH files are byte-identical to their pre bytes).
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

  // WHY: STEP 2 ordered commit: the target insert first, then each source retirement, using the
  // WHY: raw pre-images captured in STEP 1 above. The commit path serializes canonically (one
  // WHY: convention, no third path); a ROLLBACK is not a commit and must not smuggle in the
  // WHY: canonical fold as if it were the restore — it writes the captured BUFFERS (ticket-04b
  // WHY: §11: after an abort BOTH files are byte-identical to the pre-transaction contents).
  const written: ProcessedEditFile[] = [];
  try {
    if (options?.onBeforeFirstCutWrite) {
      // WHY: test-only observation seam (04b-rem2 R2): fires BEFORE the first rename so the
      // WHY: write-ahead ordering of the intent record is OBSERVED, not asserted after the fact.
      await options.onBeforeFirstCutWrite();
    }
    abortIf(options?.signal);
    await writeAtomic(
      file.absolutePath,
      file.bom + restoreEndings(file.result, file.originalEnding),
    );
    written.push(file);
    for (const plan of sourcePlans) {
      if (options?.onCutBetweenWrites) {
        // WHY: test-only fault-injection seam (ticket-04b §3): fires INSIDE the two-rename
        // WHY: window, after the previous file's rename is durable.
        await options.onCutBetweenWrites(written[written.length - 1]!.absolutePath);
      }
      abortIf(options?.signal);
      await writeAtomic(
        plan.absolutePath,
        plan.bom + restoreEndings(plan.result, plan.originalEnding),
      );
      written.push(plan);
    }
  } catch (error) {
    let rolledBack = true;
    for (const plan of written) {
      try {
        await writeAtomic(plan.absolutePath, rawPreBytes.get(plan.absolutePath)!);
      } catch (rollbackError) {
        rolledBack = false;
        console.error("Failed to roll back a cut-transaction file:", rollbackError);
      }
    }
    if (rolledBack) {
      for (const prior of saved) await prior.restore();
      try {
        await dropCutIntent(txnId);
      } catch (dropError) {
        console.error("Failed to drop the cut intent after rollback:", dropError);
      }
    }
    // WHY: a rollback that did not hold LEAVES the intent row and the transaction-tagged undo
    // WHY: rows: next-run repair resolves to complete-the-cut or restore-both from the stored
    // WHY: pre/post bytes (ADR-0028) — never a silent loss, never a fake atomicity claim.
    throw error;
  }

  try {
    await dropCutIntent(txnId);
  } catch (error) {
    // SAFETY: every byte is committed; a stale intent row resolves to "all == post" on the next
    // SAFETY: run and drops itself — repair owns that path, the edit result stands.
    console.error("Failed to clear the cut intent after commit:", error);
  }

  // WHY: STEP 3 store commit per file — the same `finishCommittedFile` the single-file path
  // WHY: runs, then ONE response whose sections cover BOTH files (§5).
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

  // WHY: (ticket-04b §2) repair before work: a previous run that crashed inside the two-rename
  // WHY: window left a durable intent; resolve it now — complete the cut or restore both files,
  // WHY: never lose content — BEFORE this call layers its own undo rows and leases over the
  // WHY: state. Best-effort: an ambiguous member keeps its intent untouched (src/cut-repair.ts)
  // WHY: and the scan is one indexed SELECT. Previews skip it: they write nothing and repair is
  // WHY: a write path.
  await repairCutIntents(options?.store);

  // WHY: the file was answered at admission (assertReq); the narrowed type carries it here.
  const path = request.file;
  const absolutePath = toCwd(path, cwd);
  const mutationTargetPath = await resolveTarget(absolutePath);
  const sessionKey = requireSessionKey(options?.sessionKey);

  // WHY: (ticket-04b §2) a cut transaction serializes EVERY file it will rename for the whole
  // WHY: plan+commit, and the queues are taken in deterministic sorted order so two calls with
  // WHY: swapped target/source cannot deadlock. COPY items never widen the lock set — a copy's
  // WHY: foreign file stays read-only.
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

    // WHY: (ticket-04b) a foreign-source cut commits as one correlated transaction (ADR-0028):
    // WHY: undo rows for every file + a durable intent record BEFORE the first rename, target
    // WHY: insert durably committed before the destructive source retirement, and next-run
    // WHY: repair for a half-applied window. Red-first witnessed by `edit.foreign-cut.test.ts`.
    if (file.foreignCuts.length > 0) {
      return await runCutTransaction(file, cwd, options, sessionKey);
    }

    const undo = await saveUndo(mutationTargetPath, {
      content: file.originalNormalized,
      bom: file.bom,
      originalEnding: file.originalEnding,
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
        file.bom + restoreEndings(file.result, file.originalEnding),
      );
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
