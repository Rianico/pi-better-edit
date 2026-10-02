/**
 * SAFETY: served-verification — deep module owning the shared serve-row/rejection surface.
 *
 * This module absorbs the served-range verification sprawl previously in served.ts:
 *  - served span position lookup (servedPositionsOf)
 *  - rebased-span contiguity gate for the MVCC dynamic rebase path (spec §3.1.1 / Probe J)
 *  - serve-block building (buildRangeServeRows/fmtServedRows/paginationHint)
 *  - the dense serve-row projection (denseServeRows) — the single owner of the serve-record row shape
 *  - the reject-and-serve rejection builders (makeServedRejection / makeTargetLostRejection /
 *    makeStaleAnchorRejection)
 *
 * ADR-0008 heuristic canon healing is retired (spec §3.3): un-rebased coordinates reject
 * fail-closed with E_STALE_RANGE. Coordinate realignment is owned exclusively by MVCC
 * `pairSnapshots` + `line_lineage` upstream in the edit path.
 *
 * The lease seam owns verification for every edit it resolves (#151): `verifyRebasedSpan` checks the
 * whole served window by lease identity. The module's former mirror-vs-mirror decision table
 * (`ServedVerification`, `verifyServedRange`) served only the library-level seam — a caller with a
 * served mirror and no lease source — and had no live caller, so it is retired (#10).
 *
 * CONTEXT.md terms preserved: serve, served state, served span, served-range
 * staleness, never-served, reject-and-serve, drift, orphaned serve, orphaning
 * re-serve, relocated line keeps its hash.
 */
import { HASH_SEP } from "./hash.js";
import { SERVED_ROWS_CAP } from "../constants.js";
import {
  DomainError,
  FRESH_READ_HEADING,
  TARGET_LOST_RECOVERY,
  UNVERIFIED_HEADLINE,
  type RangeCause,
  type ServedRow,
} from "../domain-errors.js";
import type { LeaseIdentityView } from "./resolve.js";

// WHY: ---------------------------------------------------------------------------
// WHY: Public contracts — mirrors served.ts so it can re-export without identity split
// WHY: ---------------------------------------------------------------------------

export type ServedCode = "E_STALE_RANGE" | "E_UNVERIFIED_RANGE" | "E_TARGET_LOST";

export {
  FRESH_READ_HEADING,
  TARGET_LOST_RECOVERY,
  UNVERIFIED_HEADLINE,
  type RangeCause,
  type ServedRow,
};

export interface FileSnapshotContext {
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
}

// WHY: ---------------------------------------------------------------------------
// WHY: Shared formatting helpers — owned by verification (reject-and-serve contract)
// WHY: ---------------------------------------------------------------------------

/**
 * WHY: rows carry position and hash only. Canon evidence is never stored: it is derived on demand
 * WHY: from the session's leases (`served_leases.canon_hash`), so a producer holding the file's lines
 * WHY: has nothing extra to stamp (issue #151).
 */
export function buildRangeServeRows(
  startLine: number,
  endLine: number,
  fileHashes: string[],
): ServedRow[] {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, SERVED_ROWS_CAP);
  const rows: ServedRow[] = [];
  for (let ln = startLine; ln < startLine + shown; ln++) {
    const position = ln - 1;
    const hash = fileHashes[position]!;
    rows.push({ position, hash });
  }
  return rows;
}

// WHY: the serve-record shape has no owner; this is it — the dense projection of a file's whole
// WHY: hash array to serve rows: position is the 0-based array index, hash the anchor at that index.
export function denseServeRows(hashes: readonly string[]): ServedRow[] {
  return hashes.map((hash, position) => ({ position, hash }));
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
  return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}

function paginationHint(nextOffset: number, more: number): string {
  return `[... ${more} more — read offset=${nextOffset}]`;
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < served.length; i++) {
    if (served[i] === hash) out.push(i);
  }
  return out;
}

// WHY: ---------------------------------------------------------------------------
// WHY: Reject-and-serve builders + MVCC rebased-span contiguity gate (spec §3.1.1)
// WHY: ---------------------------------------------------------------------------

/** Builds the reject-and-serve served rows + rendered block for a current on-disk range. */
function buildRangeServeBlock(
  startLine: number,
  endLine: number,
  fileHashes: string[],
  fileLines: string[],
): { servedRows: ServedRow[]; rendered: string } {
  const len = fileHashes.length;
  const first = Math.max(1, Math.min(startLine, Math.max(len, 1)));
  const last = Math.max(first, Math.min(endLine, Math.max(len, first)));
  const servedRows = buildRangeServeRows(first, last, fileHashes);
  const totalLen = endLine - startLine + 1;
  const tail =
    first === startLine && servedRows.length < totalLen
      ? `\n${paginationHint(startLine + servedRows.length, totalLen - servedRows.length)}`
      : "";
  return { servedRows, rendered: fmtServedRows(servedRows, fileLines) + tail };
}

/**
 * One reject-and-serve assembly shared by the retry-code entry points: the block build lives
 * here so the served rows cannot drift between codes. The `[MODEL] [CODE]` prefix, the
 * `Current range (fresh read):` heading renders in the domain-errors registry formats, so this
 * helper returns rows and block only. Every code that routes here serves the rows as a fresh read
 * the model decides from — never a blind-retry mandate (issue #149).
 */
function assembleRejectAndServe(args: {
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
}): { servedRows: ServedRow[]; servedBlock: string } {
  const { servedRows, rendered } = buildRangeServeBlock(
    args.startLine,
    args.endLine,
    args.snapshot.fileHashes,
    args.snapshot.fileLines,
  );
  return { servedRows, servedBlock: rendered };
}

/**
 * Builds an `[E_TARGET_LOST]` rejection for a retired leased identity whose range cannot be
 * identified (spec stale-identity-reject-and-serve D1/D6, ADR-0018 decisions 1-2). The payload
 * carries no rows, no `Current range` heading and no retry hint. §D6's row-shape phrasing is
 * superseded in part by ADR-0021 d4: the code alone selects the remedy and row presence is a
 * payload detail — target-side `[E_STALE_RANGE]`/`[E_UNVERIFIED_RANGE]` producers serve rows,
 * the foreign leased wrap renders those codes with none, and consumers dispatch on the code.
 */
export function makeTargetLostRejection(opts: {
  servedLine: number;
  path?: string;
  cause: RangeCause;
}): DomainError<"E_TARGET_LOST"> {
  return new DomainError("E_TARGET_LOST", {
    servedLine: opts.servedLine,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    cause: opts.cause,
    // WHY: the retired line is the offending line — preserved so `verify()` and
    // WHY: downstream consumers keep the coordinate without a second lookup.
    firstOffendingLine: opts.servedLine,
  });
}

/**
 * Builds a `ServedRejectionError` whose rows are the current on-disk range. Both `E_STALE_RANGE`
 * and `E_UNVERIFIED_RANGE` serve under `Current range (fresh read):` with no retry hint and no
 * mandate — the model decides from those rows. `E_TARGET_LOST` never routes here (see
 * `makeTargetLostRejection`).
 */
export function makeServedRejection(opts: {
  code: "E_STALE_RANGE" | "E_UNVERIFIED_RANGE";
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
  firstOffendingLine?: number;
  cause: RangeCause;
}): DomainError<"E_STALE_RANGE" | "E_UNVERIFIED_RANGE"> {
  if (opts.code === "E_UNVERIFIED_RANGE") {
    // WHY: the unverified payload renders the general headline, never the
    // WHY: caller-supplied clause: the bound is unplaceable, so naming
    // WHY: per-anchor positions would narrate lines never targeted.
    const { servedRows, rendered } = buildRangeServeBlock(
      opts.startLine,
      opts.endLine,
      opts.snapshot.fileHashes,
      opts.snapshot.fileLines,
    );
    return new DomainError("E_UNVERIFIED_RANGE", {
      servedRows,
      servedBlock: rendered,
      cause: opts.cause,
      ...(opts.firstOffendingLine !== undefined
        ? { firstOffendingLine: opts.firstOffendingLine }
        : {}),
    });
  }
  const { servedRows, servedBlock } = assembleRejectAndServe({
    startLine: opts.startLine,
    endLine: opts.endLine,
    snapshot: opts.snapshot,
  });
  return new DomainError("E_STALE_RANGE", {
    headline: opts.headline,
    servedRows,
    servedBlock,
    cause: opts.cause,
    ...(opts.firstOffendingLine !== undefined
      ? { firstOffendingLine: opts.firstOffendingLine }
      : {}),
  });
}

/**
 * Builds the `[E_STALE_ANCHOR]` reject-and-serve rejection for a boundary anchor the session holds
 * no lease for. It serves the rows under `Current range:` with the retry hint (spec §5.3): the
 * served rows are themselves serves, so the retry needs no `read`. Distinct from the range-family
 * codes, which serve a fresh read with no mandate (issue #149).
 */
export function makeStaleAnchorRejection(opts: {
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
  cause: RangeCause;
}): DomainError<"E_STALE_ANCHOR"> {
  const { servedRows, servedBlock } = assembleRejectAndServe({
    startLine: opts.startLine,
    endLine: opts.endLine,
    snapshot: opts.snapshot,
  });
  return new DomainError("E_STALE_ANCHOR", {
    headline: opts.headline,
    servedRows,
    servedBlock,
    cause: opts.cause,
  });
}

/**
 * Contiguity + identity gate for every leased span (spec §3.1.1 / §3.5 / Probe J). The caller resolved
 * each end anchor's leased `line_id`; this verifies the whole served window remapped onto
 * `rebasedStart..rebasedEnd` — the dynamic rebase path's rigid remap, and the fast path's identity
 * remap (`rebasedStart === servedStart ∧ rebasedEnd === servedEnd`), which is why both paths reach
 * the same verdicts (#151):
 *
 *  - a different window length means an external insert/delete landed strictly inside the range
 *    (Probe J) -> `E_STALE_RANGE`;
 *  - a served line whose mirror row was truncated away, or an anchor holding no lease -> `E_STALE_RANGE`
 *    (the diagnosis separates the two: the served record cannot be reconciled, and no served identity);
 *  - an interior row the mirror never served (`null`) -> **accepted** (ADR-0024): it carries no identity
 *    to verify, and the span's extent is already pinned by the two boundary leases this gate verifies
 *    plus the window-length check above. Only rows `0` and `servedLen - 1` — the anchors the model
 *    named — stay fail-closed on a `null`, because with no served row there is nothing to verify them
 *    against;
 *  - a served line whose lease is retired -> `E_STALE_RANGE` with `details.cause: "retirement"`, and
 *    a live lease whose `line_id` no longer lives at its expected rebased coordinate -> the same code
 *    with `cause: "served-range staleness"` (Probes A/E/K: never apply at a coordinate whose
 *    immutable `line_id` is not the one leased).
 *
 * No canon data is consulted: identity comes from the mirror row's lease, so a same-anchor collision
 * between an old served line and unrelated current content cannot satisfy the gate (issue #151).
 * Identity — not anchor spelling — is authoritative: a surviving line may legitimately present a
 * different (content-derived) anchor in the new snapshot, so a string mismatch is not by itself a
 * failure. Throwing happens before any write, so a rejection leaves the file byte-identical.
 */
export function verifyRebasedSpan(args: {
  served: readonly (string | null)[];
  servedStart: number;
  servedEnd: number;
  rebasedStart: number;
  rebasedEnd: number;
  snapshot: FileSnapshotContext;
  leaseFor(anchor: string): LeaseIdentityView | undefined;
  rebasedLineOf(lineId: number): number | undefined;
}): void {
  const {
    served,
    servedStart,
    servedEnd,
    rebasedStart,
    rebasedEnd,
    snapshot,
    leaseFor,
    rebasedLineOf,
  } = args;
  const where = snapshot.filePath ? ` in ${snapshot.filePath}` : "";
  const servedLen = servedEnd - servedStart + 1;
  const rebasedLen = rebasedEnd - rebasedStart + 1;
  if (rebasedLen !== servedLen) {
    throw makeServedRejection({
      code: "E_STALE_RANGE",
      headline: `served span (${servedLen} lines) no longer matches the rebased range (${rebasedLen} lines)${where}.`,
      startLine: rebasedStart,
      endLine: rebasedEnd,
      snapshot,
      firstOffendingLine: rebasedStart,
      cause: "served-range staleness",
    });
  }
  for (let k = 0; k < servedLen; k++) {
    const servedAnchor = served[servedStart - 1 + k];
    const currentLine = rebasedStart + k;
    // WHY: the served window can come from the leases' own `served_line_number` because a truncated
    // WHY: serve dropped the mirror rows it no longer covers (spec §3.1.1): the lease outlives the
    // WHY: mirror. An absent slot is that missing record, never "this line was never served", so the
    // WHY: span fails closed on the truth (the served record cannot be reconciled) and the current
    // WHY: range is served for a fresh read.
    if (servedAnchor === undefined) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served mirror row left; the served window was truncated.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "served-range staleness",
      });
    }
    if (servedAnchor === null) {
      // WHY: ADR-0024 narrows informed destruction to the boundaries: an unread interior row has no
      // WHY: identity to check, and the two verified boundary leases already fix the span's extent, so
      // WHY: refusing it only taxed a correct edit. A `null` boundary is the named anchor itself —
      // WHY: unverifiable by construction — so it keeps the fail-closed diagnosis.
      if (k === 0 || k === servedLen - 1) {
        throw makeServedRejection({
          code: "E_STALE_RANGE",
          headline: `line ${currentLine}${where} was never served.`,
          startLine: rebasedStart,
          endLine: rebasedEnd,
          snapshot,
          firstOffendingLine: currentLine,
          cause: "never-served",
        });
      }
      continue;
    }
    const lease = leaseFor(servedAnchor);
    if (lease === undefined) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} has no served line identity.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "never-served",
      });
    }
    // WHY: two distinct diagnoses, one per condition (spec §5.3): a terminal lease is a
    // WHY: `retirement` — the identity is gone and only a re-read revives it — while a live lease
    // WHY: whose `line_id` no longer sits at its expected coordinate is drift between the served
    // WHY: record and the rebased span.
    if (lease.retiredAt !== null) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "retirement",
      });
    }
    if (rebasedLineOf(lease.lineId) !== currentLine) {
      throw makeServedRejection({
        code: "E_STALE_RANGE",
        headline: `line ${currentLine}${where} no longer resolves to the line identity it was served with.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
        cause: "served-range staleness",
      });
    }
  }
}

// WHY: ---------------------------------------------------------------------------
// WHY: Resolved-range contract (shared with apply/pipeline)
// WHY: ---------------------------------------------------------------------------

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
}
