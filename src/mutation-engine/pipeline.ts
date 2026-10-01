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
 *       on write failure: restore undo
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
import { denseServeRows, type ResolvedRange } from "../hashline/served.js";
import { DomainError } from "../domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "../served-spans.js";
import { createSessionHandle } from "../served-session/session.js";
import { scanDrift } from "../drift.js";
import { clearNoopLoop, runNoopPolicy } from "../noop-guard.js";
import { clearServedRefusals } from "../hashline/served-guard.js";
import { saveUndo } from "../edit-undo.js";
import { resolveTarget, writeAtomic } from "../fs-write.js";
import { toCwd } from "../paths.js";
import type { DesiredText, NormalizedEditRequest } from "../payload-contract.js";
import {
  batchAbortFor,
  batchAbortForMany,
  buildBatchResult,
  toSection,
  wrapParseFailure,
} from "../edit-response.js";
import { DEFERRED_STORE_SYNC_WARNING } from "../constants.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PipelineOptions, ProcessedEditFile } from "./types.js";
import { loadEditFile, leaseSpanSource, requireSessionKey } from "./edit-source.js";
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
  filePath: string;
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
      filePath: input.filePath,
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
      headline:
        "missing previous hashes for stable anchoring. Re-read the full file and copy fresh 3-char anchors (before │), then retry.",
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
 * WHY: (ticket-01 hardening) the single exhaustive view of the payload union for text consumers —
 * WHY: the noop-loop tracker discriminates its noop episodes with this. A new union arm must add
 * WHY: a case here or `assertNever` fails `pnpm run typecheck`. The `span-ref` arm renders as its
 * WHY: span's anchors, never a placeholder empty text: the copied content is not known here, and
 * WHY: collapsing every non-hand-written arm to "" would fuse distinct noop episodes into one count.
 */
function replacementTextForPayload(payload: DesiredText): string {
  switch (payload.kind) {
    case "hand-written":
      return payload.text;
    case "span-ref":
      return `span:${payload.span.anchor_from}..${payload.span.anchor_to}:${payload.retireSource ? "move" : "copy"}`;
    case "none":
      return "";
    default:
      return assertNever(payload);
  }
}

function parseEdits(items: NormalizedEditRequest["edits"], path: string): HEdit[] {
  const parsed: HEdit[] = [];
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
        case "hand-written":
          // WHY: the `hand-written` arm owns its invariant at the one place the union is parsed
          // WHY: into engine lines: it must carry at least one line.
          if (payload.text.length === 0) {
            throw new DomainError("E_BAD_PAYLOAD", {
              message:
                'A "hand-written" payload must carry at least one line. Nothing was written.',
            });
          }
          text = payload.text;
          break;
        case "span-ref":
          // WHY: the copied lines are content the caller does not hold — `applyEdit` materializes
          // WHY: them from the resolved source span before any gate or splice runs, so the parse
          // WHY: seam carries the span, never a placeholder text.
          source = {
            anchor_from: payload.span.anchor_from,
            anchor_to: payload.span.anchor_to,
            retire: payload.retireSource,
          };
          text = "";
          break;
        case "none":
          if (item.at !== "replace") {
            throw new DomainError("E_BAD_PAYLOAD", {
              message:
                'An insertion ("before"/"after") requires "hand-written" text. Nothing was written.',
            });
          }
          text = "";
          break;
        default:
          assertNever(payload);
      }
      parsed.push(
        resEdit({
          anchor_from: item.target.anchor_from,
          anchor_to: item.target.anchor_to,
          text,
          ...(item.at !== "replace" ? { placement: item.at } : {}),
          ...(source ? { source } : {}),
        }),
      );
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

async function runMutations(
  request: NormalizedEditRequest,
  cwd: string,
  options?: PipelineOptions,
): Promise<ProcessedEditFile> {
  // WHY: the file was answered at admission (assertReq); the narrowed type carries it here.
  const path = request.file;
  const items = request.edits;
  const mode = request.mode ?? "general";
  const hashStore = options?.store ?? (await loadHashStore());
  const sessionKey = requireSessionKey(options?.sessionKey);
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
    const edit = parsed[index]!;

    const outcome = await applyOneEdit({
      content: currentContent,
      hashes: currentHashes,
      edit,
      signal: options?.signal,
      filePath: path,
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

  // WHY: the file was answered at admission (assertReq); the narrowed type carries it here.
  const path = request.file;
  const absolutePath = toCwd(path, cwd);
  const mutationTargetPath = await resolveTarget(absolutePath);
  const sessionKey = requireSessionKey(options?.sessionKey);

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
              clearFrom:
                diffInfo.firstChangedLine !== undefined ? diffInfo.firstChangedLine - 1 : 0,
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
