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
 * A retired identity whose named window collapses or misses the file rejects with no rows;
 * the surviving-bound-live-and-unshifted case serves the named window as a fresh read
 * (no retry hint) with the rows leased as today; any other retired identity with an
 * identifiable window rejects with that window served for a retry.
 *
 * INVARIANT (spec §3.1.1, §5.3, ADR-0016) — a served anchor is never resolved by content. `apply.ts`
 * routes EVERY edit that has a lease source here, so a boundary anchor either has a live lease or its
 * identity is lost: a missing lease is an unknown or foreign anchor (the session-wide lookup
 * decides which), a retired identity with no live unshifted survivor and no identifiable window
 * carries no rows, and the one-bound-retired survivor-live-and-unshifted case serves a fresh
 * read to decide from, never a content question.
 * A never-served interior line strictly between the anchors is caught by the span gates
 * (`[E_STALE_RANGE]`, spec §5.3).
 */
import {
  isUniformLeaseFastPath,
  resolveLineIdentity,
  uniqueServedPosition,
  type HEdit,
  type LeaseSpanSource,
  type RHEdit,
} from "./resolve.js";
import { DomainError } from "../domain-errors.js";
import {
  makeServedRejection,
  makeTargetLostRejection,
  UNVERIFIED_HEADLINE,
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
  throw new DomainError("E_REVERSED_ANCHORS", {
    startLine,
    endLine,
    fromAnchor: edit.hash_bounds[0].hash,
    toAnchor: edit.hash_bounds[1].hash,
  });
}

/**
 * Refuses anchors the lease seam cannot place: the session holds no lease for them in this file.
 *
 * Deterministic precedence, one condition per code: a lease held for another file wins over
 * holding no lease anywhere. Homes come from the session-wide `(session_id, anchor)` lookup;
 * the lookup runs here on the failure path only. Neither rejection serves rows: with no lease
 * for this file no range can be identified, so there is nothing trustworthy to retry with.
 */
function throwUnknownOrForeign(args: {
  edit: HEdit;
  snapshot: FileSnapshotContext;
  refusedFrom: boolean;
  refusedTo: boolean;
  source: LeaseSpanSource;
}): never {
  const { edit, snapshot, source } = args;
  const path = snapshot.filePath ?? "this file";
  const refused = [
    ...new Set(
      [
        args.refusedFrom ? edit.hash_bounds[0].hash : undefined,
        args.refusedTo ? edit.hash_bounds[1].hash : undefined,
      ].filter((hash): hash is string => hash !== undefined),
    ),
  ];
  const homes = [
    ...new Set(refused.flatMap((anchor) => source.anchorHomes?.(anchor) ?? [])),
  ].sort();
  if (homes.length > 0) {
    throw new DomainError("E_FOREIGN_ANCHOR", { path, anchors: refused, homes });
  }
  throw new DomainError("E_UNKNOWN_ANCHOR", { path, anchors: refused });
}

/**
 * Resolves an edit's anchors through the session's immutable leases.
 *
 * The caller (`apply.ts`) routes every edit that has a served mirror and a lease source here — a
 * boundary anchor with no lease is lost identity (`[E_STALE_ANCHOR]`), never a content question; a
 * never-served interior line is caught by the span gates (`[E_STALE_RANGE]`, spec §5.3).
 */
export function resolveLeasedEdit(args: {
  edit: HEdit;
  snapshot: FileSnapshotContext;
  served: (string | null)[];
  source: LeaseSpanSource;
}): LeasedEditResolution {
  const { edit, snapshot, served, source } = args;
  const { fileHashes } = snapshot;
  const fromAnchor = edit.hash_bounds[0].hash;
  const toAnchor = edit.hash_bounds[1].hash;
  const fromLease = source.leaseFor(fromAnchor);
  const toLease = source.leaseFor(toAnchor);

  // WHY: a boundary anchor with no lease for this file is never satisfied by content:
  // WHY: the lookup is the edit's first step, so a colliding content anchor cannot stand
  // WHY: in for the missing lease — that substitution is the silent rebind this seam removes.
  if (!fromLease || !toLease) {
    throwUnknownOrForeign({
      edit,
      snapshot,
      refusedFrom: !fromLease,
      refusedTo: !toLease,
      source,
    });
  }

  const fromDecision = resolveLineIdentity(fromLease, source);
  const toDecision = resolveLineIdentity(toLease, source);

  // WHY: a retired or identity-absent leased line has no coordinate to apply (spec §3.1.1
  // WHY: line 89 / §5.3, stale-identity-reject-and-serve D1/D5/D6, ADR-0018 decisions 1-3). The
  // WHY: boundary rule owns the payload: rows are served ONLY when the surviving bound is live
  // WHY: AND unshifted (its rebased coordinate equals its served coordinate — evidence no shift
  // WHY: occurred). That single case serves the named window as a fresh read with no retry hint,
  // WHY: and the rows are leased through the normal seam so the model decides from them. Every
  // WHY: other stale case carries no rows. The named coordinate is always lease-derived
  // WHY: (`lease.servedLineNumber`); content placement never places a window and never names a
  // WHY: coordinate for a retired bound (Probe P).
  if (fromDecision.kind === "stale" || toDecision.kind === "stale") {
    const fromLiveUnshifted =
      fromDecision.kind === "line" && fromDecision.line === fromLease.servedLineNumber;
    const toLiveUnshifted =
      toDecision.kind === "line" && toDecision.line === toLease.servedLineNumber;
    const staleServedLine =
      fromDecision.kind === "stale" ? fromLease.servedLineNumber : toLease.servedLineNumber;
    const exactlyOneStale = (fromDecision.kind === "stale") !== (toDecision.kind === "stale");
    const survivorLiveUnshifted =
      fromDecision.kind === "stale" ? toLiveUnshifted : fromLiveUnshifted;
    if (exactlyOneStale && survivorLiveUnshifted) {
      const rawStart = Math.min(fromLease.servedLineNumber, toLease.servedLineNumber);
      const rawEnd = Math.max(fromLease.servedLineNumber, toLease.servedLineNumber);
      const len = fileHashes.length;
      const startLine = Math.max(1, rawStart);
      const endLine = Math.min(len, rawEnd);
      // WHY: collapsed-window guard: clamp to the file and fail closed when the named window
      // WHY: collapses (e.g. served startLine 10 against a 4-line file) or misses the file.
      if (len > 0 && startLine <= endLine && rawEnd >= 1 && rawStart <= len) {
        throw makeServedRejection({
          code: "E_UNVERIFIED_RANGE",
          headline: UNVERIFIED_HEADLINE,
          startLine,
          endLine,
          snapshot,
          firstOffendingLine: staleServedLine,
          cause: "retirement",
        });
      }
    }
    throw makeTargetLostRejection({
      servedLine: staleServedLine,
      ...(snapshot.filePath !== undefined ? { path: snapshot.filePath } : {}),
      cause: "retirement",
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
