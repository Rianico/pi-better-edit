/**
 * SAFETY: Edit-path lease resolution — the MVCC identity seam for `edit` (spec §3.1.1, §3.5).
 *
 * Two lease paths, chosen by ONE predicate:
 *
 *  - **Fast path** (`S_from === C ∧ S_to === C ∧ S_from === S_to`): the anchors were leased from
 *    the content now on disk, so the caller keeps applying at the served coordinates and verifies
 *    contiguity against the served mirror.
 *  - **Dynamic rebase path**: the caller resolved each leased `line_id` in `line_lineage(C)` (an
 *    on-demand materialization through `pairSnapshots`) and this module verifies the whole served
 *    span remapped rigidly, then applies at the rebased coordinate.
 *
 * Resolution is strictly READ-ONLY on `served_leases`: it never re-stamps `line_id` and never
 * writes `retired_at`. The authoritative retirement update belongs to materialization.
 *
 * Fail-closed semantics (never weakened): an unleased anchor, a retired/absent leased `line_id`, a
 * coordinate that no longer carries the leased identity, or an external insert/delete strictly
 * inside the span all reject before any write, so a rejection leaves the file byte-identical.
 *
 * INVARIANT (spec §3.1.1, §5.3, ADR-0016) — a served anchor is never resolved by content. `apply.ts`
 * routes EVERY edit that has a lease source here, so a boundary anchor either has a live lease or its
 * identity is lost: lost identity is `[E_STALE_ANCHOR]` (no lease) or `[E_STALE_RANGE]`
 * (retired/deleted leased line), never a content question. `[E_UNSERVED_RANGE]` stays reserved for an
 * interior line strictly between the anchors that the model was never shown.
 */
import {
  fmtMismatchWithServes,
  isUniformLeaseFastPath,
  resolveLineIdentity,
  uniqueAnchorLine,
  uniqueServedPosition,
  valEdit,
  type HEdit,
  type LeaseSpanSource,
  type RHEdit,
} from "./resolve.js";
import {
  AnchorMismatchError,
  makeServedRejection,
  makeStaleAnchorRejection,
  verifyRebasedSpan,
  type FileSnapshotContext,
} from "./served-verification.js";

export type LeasedEditResolution =
  | { status: "fast"; resolved: RHEdit }
  | {
      status: "rebased";
      resolved: RHEdit;
      /**
       * 1-based first row of the served window the rebased span remapped from. The rigid remap makes
       * `servedStart + k` the anchor served for the line replacement line `k` replaces, so a caller
       * comparing a replacement against served state stays range-relative against the mirror.
       */
      servedStart: number;
    };

/**
 * The resolved edit for a leased span: the caller applies it verbatim, so the lease path never hands
 * an unleased anchor to content resolution (spec §3.1.1 step 2 / §5.3).
 */
function resolvedAt(edit: HEdit, fileHashes: string[], fromLine: number, toLine: number): RHEdit {
  return {
    content_lines: edit.content_lines,
    hash_bounds: [
      { line: fromLine, hash: fileHashes[fromLine - 1]!, hashMatched: true },
      { line: toLine, hash: fileHashes[toLine - 1]!, hashMatched: true },
    ],
  };
}

function throwReversed(edit: HEdit, startLine: number, endLine: number): never {
  throw new Error(
    `[MODEL] [E_REVERSED_ANCHORS] Refused: range start line ${startLine} is after end line ${endLine} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}). Nothing was written; swap anchor_from/anchor_to and retry.`,
  );
}

/**
 * Refuses an anchor the lease seam cannot resolve: the session holds no lease for it at all.
 *
 * SPEC §5.3: the unleased-anchor rejection is reject-and-serve like the others — it serves the FULL
 * current range of the targeted span (the rows are themselves serves), never a narrow +/-1 context
 * window, so the model retries with the served anchors and needs no `read`.
 *
 * INVARIANT: content resolution is a DIAGNOSTIC here, never a resolution — the coordinates it finds
 * are not returned to the caller, so an unleased anchor can never be satisfied by a colliding
 * content anchor. That silent miswrite is the class this seam exists to remove.
 *
 * WHY: when neither content nor a lease can place a boundary, no targeted range exists to serve; the
 * WHY: diagnostic falls back to the narrow context around the one boundary that IS placeable.
 */
function throwStaleAnchor(args: {
  edit: HEdit;
  snapshot: FileSnapshotContext;
  refusedFrom: boolean;
  refusedTo: boolean;
  /** Current-content or served coordinate of each boundary; `undefined` when neither can place it. */
  fromLine: number | undefined;
  toLine: number | undefined;
}): never {
  const { edit, snapshot, fromLine, toLine } = args;
  const { filePath } = snapshot;
  const refused = [
    ...new Set(
      [
        args.refusedFrom ? edit.hash_bounds[0].hash : undefined,
        args.refusedTo ? edit.hash_bounds[1].hash : undefined,
      ].filter((hash): hash is string => hash !== undefined),
    ),
  ];
  // WHY: parity — the spec's `E_STALE_ANCHOR` serve is the current range, so a boundary placed by
  // WHY: content or by the surviving lease is enough to name the range the model targeted.
  if (fromLine !== undefined && toLine !== undefined) {
    const label = refused.length > 1 ? "anchors" : "anchor";
    const list = refused.map((hash) => `"${hash}"`).join(", ");
    throw makeStaleAnchorRejection({
      headline:
        `${label} ${list} ${refused.length > 1 ? "are" : "is"} not present in the served leases ` +
        `for ${filePath ?? "this path"}; nothing was written.`,
      startLine: Math.min(fromLine, toLine),
      endLine: Math.max(fromLine, toLine),
      snapshot,
    });
  }
  // WHY: at least one boundary is placeable by NEITHER content nor a lease, so no targeted range
  // WHY: exists to serve; `valEdit` cannot resolve both bounds either and its own diagnostic names
  // WHY: the refused anchor(s) with the narrow context of the one boundary we can place.
  const content = valEdit(edit, snapshot, undefined);
  const { message, servedRows } = fmtMismatchWithServes(content.mismatches, snapshot);
  throw new AnchorMismatchError(`[MODEL] ${message}`, servedRows);
}

/**
 * Resolves an edit's anchors through the session's immutable leases.
 *
 * The caller (`apply.ts`) routes every edit that has a served mirror and a lease source here — a
 * boundary anchor with no lease is lost identity (`[E_STALE_ANCHOR]`), never a content question; a
 * never-served interior line is caught by the span gates (`[E_UNSERVED_RANGE]`, spec §5.3).
 */
export function resolveLeasedEdit(args: {
  edit: HEdit;
  snapshot: FileSnapshotContext;
  served: (string | null)[];
  source: LeaseSpanSource;
}): LeasedEditResolution {
  const { edit, snapshot, served, source } = args;
  const { fileHashes, filePath } = snapshot;
  const where = filePath ? ` in ${filePath}` : "";
  const fromAnchor = edit.hash_bounds[0].hash;
  const toAnchor = edit.hash_bounds[1].hash;
  const fromContent = uniqueAnchorLine(fileHashes, fromAnchor);
  const toContent = uniqueAnchorLine(fileHashes, toAnchor);
  const fromLease = source.leaseFor(fromAnchor);
  const toLease = source.leaseFor(toAnchor);

  // WHY: a boundary anchor with no lease at all is lost identity (spec §3.1.1 step 1 line 89 /
  // WHY: §5.3, ADR-0016): the lease lookup is the edit's first step, so content anchors can never
  // WHY: stand in for the missing lease — that substitution is the silent rebind this seam removes.
  if (!fromLease || !toLease) {
    throwStaleAnchor({
      edit,
      snapshot,
      refusedFrom: !fromLease,
      refusedTo: !toLease,
      // WHY: the targeted range is the span between the two boundaries, placed by content when the
      // WHY: anchor is on disk and by the surviving lease's served coordinate otherwise.
      fromLine: fromContent ?? fromLease?.servedLineNumber,
      toLine: toContent ?? toLease?.servedLineNumber,
    });
  }

  const fromDecision = resolveLineIdentity(fromLease, fromContent, source);
  const toDecision = resolveLineIdentity(toLease, toContent, source);

  // WHY: a retired or identity-absent leased line has no coordinate to apply: refuse at the same
  // WHY: seam by serving the current range, never `E_STALE_ANCHOR` (spec §3.1.1 line 89 / §5.3).
  if (fromDecision.kind === "stale" || toDecision.kind === "stale") {
    const staleLine = fromDecision.kind === "stale" ? fromDecision.line : undefined;
    const startLine = fromContent ?? fromLease.servedLineNumber;
    const endLine = toContent ?? toLease.servedLineNumber;
    throw makeServedRejection({
      code: "E_STALE_RANGE",
      headline: `line ${staleLine ?? Math.min(startLine, endLine)}${where} no longer resolves to the line identity it was served with.`,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      snapshot,
      firstOffendingLine: staleLine,
    });
  }

  const fromLine = fromDecision.line;
  const toLine = toDecision.line;
  if (fromLine > toLine) throwReversed(edit, fromLine, toLine);

  // WHY: the fast path is exactly the spec's predicate (spec §3.5):
  // WHY: `lease_from.served_snapshot_hash === C ∧ lease_to.served_snapshot_hash === C ∧
  // WHY: lease_from.served_snapshot_hash === lease_to.served_snapshot_hash`. Content coordinates are
  // WHY: NOT part of the qualification — a uniform-snapshot lease is authoritative about its own
  // WHY: coordinate, so an ambiguous/duplicated canon can neither satisfy nor block it.
  if (isUniformLeaseFastPath(fromLease, toLease, source.currentSnapshotHash)) {
    // WHY: the fast path applies at the served coordinates the lease itself names, so the edit is
    // WHY: resolved here too — the caller must never fall back to content resolution for a served
    // WHY: anchor (the mirror-only `valEdit` fallback this seam replaced).
    return { status: "fast", resolved: resolvedAt(edit, fileHashes, fromLine, toLine) };
  }

  // WHY: dynamic rebase (spec §3.1.1) — the served window comes from the mirror, falling back to the
  // WHY: lease's own `served_line_number` when a serve was truncated out of the mirror: the lease is
  // WHY: the authoritative record of where the anchor was served.
  const fromServed = uniqueServedPosition(served, fromAnchor) ?? fromLease.servedLineNumber;
  const toServed = uniqueServedPosition(served, toAnchor) ?? toLease.servedLineNumber;
  const servedStart = Math.min(fromServed, toServed);
  const servedEnd = Math.max(fromServed, toServed);

  verifyRebasedSpan({
    served,
    servedStart,
    servedEnd,
    rebasedStart: fromLine,
    rebasedEnd: toLine,
    snapshot,
    leaseFor: (anchor) => source.leaseFor(anchor),
    rebasedLineOf: (lineId) => source.rebasedLineOf(lineId),
  });

  return {
    status: "rebased",
    resolved: resolvedAt(edit, fileHashes, fromLine, toLine),
    servedStart,
  };
}
