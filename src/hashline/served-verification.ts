/**
 * SAFETY: ServedVerification — deep module owning all served-range verification.
 *
 * This module absorbs the served-range verification sprawl previously in served.ts:
 *  - served span resolve (servedPositionsOf + candidate enumeration)
 *  - length mismatch and never-served checks
 *  - rebased-span contiguity gate for the MVCC dynamic rebase path (spec §3.1.1 / Probe J)
 *  - serve-block building (buildRangeServeRows/fmtServedRows/paginationHint)
 *  - E_RANGE_* branching via decision table
 *
 * ADR-0008 heuristic canon healing is retired (spec §3.3): un-rebased coordinates reject
 * fail-closed with E_STALE_RANGE. Coordinate realignment is owned exclusively by MVCC
 * `pairSnapshots` + `line_lineage` upstream in the edit path.
 *
 * The lease seam owns verification for every edit it resolves (#151): `verifyRebasedSpan` checks the
 * whole served window by lease identity, so this module's mirror-vs-mirror decision table serves only
 * the library-level seam — a caller with a served mirror and no lease source. Canon evidence there is
 * a digest parallel to the mirror (`String(xxh32(canon(line)))`), because no canon text is stored
 * (issue #151). There is no process-wide hash->canon map either (issue #149: a 3-char hash is unique
 * only inside one file, so such a map would serve another file's content as this file's canon).
 *
 * CONTEXT.md terms preserved: serve, served state, served span, served-range
 * staleness, never-served, reject-and-serve, drift, orphaned serve, orphaning
 * re-serve, relocated line keeps its hash.
 */
import { HASH_SEP, canonDigest } from "./hash.js";
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

// WHY: the ad-hoc rejection subclasses are retired (spec D1): every rejection
// WHY: below is a `DomainError` whose code selects the range-family payload shape, so
// WHY: `toFailure` and downstream consumers keep `servedRows`, `servedBlock`, `cause`,
// WHY: and `details`.
type RangeRejection = DomainError<"E_STALE_RANGE" | "E_UNVERIFIED_RANGE" | "E_TARGET_LOST">;

function isRangeRejection(error: unknown): error is RangeRejection {
  return (
    error instanceof DomainError &&
    (error.code === "E_STALE_RANGE" ||
      error.code === "E_UNVERIFIED_RANGE" ||
      error.code === "E_TARGET_LOST")
  );
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
 * carries no rows, no `Current range` heading and no retry hint, so the codes stay disjoint
 * by payload shape: `[E_STALE_RANGE]` and `[E_UNVERIFIED_RANGE]` always render rows,
 * `[E_TARGET_LOST]` never does.
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
 *  - a served line with no mirror row or no lease -> `E_STALE_RANGE` (never-served interior:
 *    the remedy is identical — retry with the served rows — so no separate code is kept);
 *  - a served line whose lease is retired, or whose `line_id` no longer lives at its expected
 *    rebased coordinate, -> `E_STALE_RANGE` (Probes A/E/K: never apply at a coordinate whose
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
    if (servedAnchor === null || servedAnchor === undefined) {
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
    if (lease.retiredAt !== null || rebasedLineOf(lease.lineId) !== currentLine) {
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
// WHY: Decision-table types
// WHY: ---------------------------------------------------------------------------

interface VerificationRange {
  startHash: string;
  endHash: string;
  startLine: number;
  endLine: number;
}

export interface VerificationInput {
  range: VerificationRange;
  served: (string | null)[];
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
  tombstone?: ReadonlySet<string>;
  /**
   * SAFETY: canon digests parallel to `served` — `String(xxh32(canon(line)))`, the value the served
   * line's lease recorded. Absent means no evidence, so every canon comparison stays silent.
   */
  canonDigests?: (string | null)[];
}

/** SAFETY: Result shape requested in the task: {ok} | {code, servedRows, servedBlock}. */
export type VerificationResult =
  | { ok: true }
  | {
      ok: false;
      code: ServedCode;
      servedRows: ServedRow[];
      servedBlock: string;
      message: string;
      firstOffendingLine?: number;
      cause: RangeCause;
      details: { cause: RangeCause };
    };

// WHY: ---------------------------------------------------------------------------
// WHY: ServedVerification — the deep module
// WHY: ---------------------------------------------------------------------------

export class ServedVerification {
  // WHY: -- public: pure result -------------------------------------------------

  verify(input: VerificationInput): VerificationResult {
    try {
      this.verifyOrThrow(input);
      return { ok: true };
    } catch (error) {
      if (isRangeRejection(error)) {
        // WHY: every range-family builder pins its own evidence cause (G3: no borrowed
        // WHY: defaults) — a missing cause is a builder defect, so surface it loud by
        // WHY: rethrowing the original instead of inventing one here.
        if (error.cause === undefined) throw error;
        const cause = error.cause;
        // WHY: the serve block travels as a typed readonly field populated at construction,
        // WHY: so no rebuild is needed here.
        return {
          ok: false,
          code: error.code,
          servedRows: error.servedRows,
          servedBlock: error.servedBlock,
          message: error.message,
          ...(error.firstOffendingLine !== undefined
            ? { firstOffendingLine: error.firstOffendingLine }
            : {}),
          cause,
          details: { cause },
        };
      }
      throw error;
    }
  }

  // WHY: -- public: throwing variant (compat with verifyServedRange) ------------

  verifyOrThrow(input: VerificationInput): void {
    const {
      range,
      served,
      fileHashes,
      fileLines,
      filePath,
      tombstone: inputTombstone,
      canonDigests: inputCanonDigests,
    } = input;
    const tombstone = inputTombstone ?? new Set<string>();
    const canonDigests = inputCanonDigests;
    const where = filePath ? ` in ${filePath}` : "";
    const { startHash, endHash, startLine, endLine } = range;
    const { servedRows, rendered } = this.buildServeBlock(
      startLine,
      endLine,
      fileHashes,
      fileLines,
    );
    const currentLen = endLine - startLine + 1;

    // WHY: Early tombstone boundary check (whole-span S@3==S@3) — gated on canon-digest inequality
    // WHY: to avoid a false positive on a same-line re-read. A tombstoned boundary hash is exactly
    // WHY: what cannot be trusted: the lease is terminal for this window, so the rejection serves the
    // WHY: current range for a retry.
    if ((tombstone.has(startHash) || tombstone.has(endHash)) && canonDigests) {
      const tombstonedHash = tombstone.has(startHash) ? startHash : endHash;
      const pos = fileHashes.indexOf(tombstonedHash);
      if (pos >= 0) {
        const servedIdx = served.indexOf(tombstonedHash);
        const expected = servedIdx >= 0 ? canonDigests[servedIdx] : undefined;
        const actual = canonDigest(fileLines[pos] ?? "");
        if (expected !== undefined && expected !== null && expected !== actual) {
          this.throwStaleForTombstone({
            tombstonedHash,
            startLine,
            endLine,
            snapshot: { fileHashes, fileLines, ...(filePath !== undefined ? { filePath } : {}) },
            firstOffendingLine: pos + 1,
          });
        }
      }
    }

    const span = this.resolveServedSpan({
      served,
      startHash,
      endHash,
      startLine,
      currentLen,
      fileHashes,
    });

    // WHY: --- decision table entry 1: no span could be resolved -> unknown anchor ---
    // WHY: ADR-0008 canon healing is retired (spec §3.3): an unresolvable span is never relocated
    // WHY: by scanning for matching canon digests. It fails closed; coordinate realignment is owned
    // WHY: exclusively by MVCC `pairSnapshots` + `line_lineage` in the edit path.
    const from: number | undefined = span.from;
    const to: number | undefined = span.to;

    if (from === undefined || to === undefined) {
      this.throwUnknownForMissingSpan({
        startHash,
        endHash,
        filePath,
        startPositions: servedPositionsOf(served, startHash),
        endPositions: servedPositionsOf(served, endHash),
      });
    }

    // WHY: Canon check for same-pos different content (collision)
    if (canonDigests && from !== undefined && to !== undefined) {
      const servedLen = to - from + 1;
      for (let k = 0; k < servedLen; k++) {
        const expected = canonDigests[from + k];
        if (expected !== null && expected !== undefined) {
          const actual = canonDigest(fileLines[startLine - 1 + k] ?? "");
          if (expected !== actual) {
            this.throwStale({
              headline: `line ${startLine + k}${where} differs from what was served (expected "${expected}" vs actual "${actual}").`,
              firstOffendingLine: startLine + k,
              servedRows,
              rendered,
              cause: "served-range staleness",
            });
          }
        }
      }
      // WHY: Tombstone interior check (whole-span) — gated on canon-digest inequality (fail-closed
      // WHY: only for a different canon digest)
      for (let k = 0; k < servedLen; k++) {
        const h = fileHashes[startLine - 1 + k];
        if (h && tombstone.has(h)) {
          const expectedCanon = canonDigests?.[from + k] ?? undefined;
          const actualCanon = canonDigest(fileLines[startLine - 1 + k] ?? "");
          if (
            expectedCanon !== undefined &&
            expectedCanon !== null &&
            expectedCanon !== actualCanon
          ) {
            // WHY: unified with the canon-mismatch clause above: ONE clause plus
            // WHY: cause, keeping the first mismatching line (expected vs actual)
            // WHY: and dropping the per-line anchor-changed narration. The cause
            // WHY: (`tombstone`) is what distinguishes the signal.
            this.throwStale({
              headline: `line ${startLine + k}${where} differs from what was served (expected "${expectedCanon}" vs actual "${actualCanon}").`,
              firstOffendingLine: startLine + k,
              servedRows,
              rendered,
              cause: "tombstone",
            });
          }
        }
      }
    }

    // WHY: --- decision table entries 2..5: validate resolved span ---
    this.validateResolvedSpan({
      served,
      from: from!,
      to: to!,
      startLine,
      currentLen,
      fileHashes,
      rendered,
      servedRows,
      where,
    });
  }

  // WHY: -- private: serve block --------------------------------------------------------

  private buildServeBlock(
    startLine: number,
    endLine: number,
    fileHashes: string[],
    fileLines: string[],
  ): { servedRows: ServedRow[]; rendered: string } {
    const servedRows = buildRangeServeRows(startLine, endLine, fileHashes);
    const totalLen = endLine - startLine + 1;
    const tail =
      servedRows.length < totalLen
        ? `\n${paginationHint(startLine + servedRows.length, totalLen - servedRows.length)}`
        : "";
    const rendered = fmtServedRows(servedRows, fileLines) + tail;
    return { servedRows, rendered };
  }

  // WHY: -- private: span resolve ------------------------------------------------

  private resolveServedSpan(args: {
    served: (string | null)[];
    startHash: string;
    endHash: string;
    startLine: number;
    currentLen: number;
    fileHashes: string[];
  }): { from?: number; to?: number } {
    const { served, startHash, endHash, startLine, currentLen, fileHashes } = args;
    const startPositions = servedPositionsOf(served, startHash);
    const endPositions = servedPositionsOf(served, endHash);

    if (startPositions.length === 1 && endPositions.length === 1) {
      return {
        from: Math.min(startPositions[0]!, endPositions[0]!),
        to: Math.max(startPositions[0]!, endPositions[0]!),
      };
    }

    const candidates = this.enumerateExactCandidates({
      served,
      startPositions,
      endPositions,
      currentLen,
      fileHashes,
      startLine,
    });

    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      candidates.sort(
        (a, b) => Math.abs(a.from - (startLine - 1)) - Math.abs(b.from - (startLine - 1)),
      );
      return candidates[0]!;
    }
    return {};
  }

  private enumerateExactCandidates(args: {
    served: (string | null)[];
    startPositions: number[];
    endPositions: number[];
    currentLen: number;
    fileHashes: string[];
    startLine: number;
  }): Array<{ from: number; to: number }> {
    const { served, startPositions, endPositions, currentLen, fileHashes, startLine } = args;
    const out: Array<{ from: number; to: number }> = [];
    for (const s of startPositions) {
      for (const e of endPositions) {
        const candFrom = Math.min(s, e);
        const candTo = Math.max(s, e);
        if (candTo - candFrom + 1 !== currentLen) continue;
        let ok = true;
        for (let k = 0; k < currentLen; k++) {
          if (served[candFrom + k] !== fileHashes[startLine - 1 + k]) {
            ok = false;
            break;
          }
        }
        if (ok) out.push({ from: candFrom, to: candTo });
      }
    }
    return out;
  }

  // WHY: -- private: validation via decision table -------------------------------

  private validateResolvedSpan(args: {
    served: (string | null)[];
    from: number;
    to: number;
    startLine: number;
    currentLen: number;
    fileHashes: string[];
    rendered: string;
    servedRows: ServedRow[];
    where: string;
  }): void {
    const { served, from, to, startLine, currentLen, fileHashes, rendered, servedRows, where } =
      args;

    // WHY: Decision: never-served gap inside served span — collapses into E_STALE_RANGE:
    // WHY: the remedy is identical (retry with the served rows), so no separate code is kept.
    for (let i = from; i <= to; i++) {
      if (served[i] === null) {
        this.throwStale({
          headline: `line ${i + 1}${where} was never served.`,
          firstOffendingLine: i + 1,
          servedRows,
          rendered,
          cause: "never-served",
        });
      }
    }

    // WHY: Decision: length mismatch (served span vs current range). Heuristic length healing is
    // WHY: retired (spec §3.3): a mismatched span is fail-closed, never resized by a canon scan.
    const servedLen = to - from + 1;
    if (servedLen !== currentLen) {
      this.throwStale({
        headline: `served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}.`,
        firstOffendingLine: startLine,
        servedRows,
        rendered,
        cause: "served-range staleness",
      });
    }

    // WHY: Decision: hash mismatch (stale interior)
    for (let k = 0; k < servedLen; k++) {
      if (served[from + k] !== fileHashes[startLine - 1 + k]) {
        const offendingLine = startLine + k;
        this.throwStale({
          headline: `line ${offendingLine}${where} differs from what was served.`,
          firstOffendingLine: offendingLine,
          servedRows,
          rendered,
          cause: "served-range staleness",
        });
      }
    }
  }

  // WHY: -- private: throws with decision-table mapping -------------------------

  private throwUnknownForMissingSpan(args: {
    startHash: string;
    endHash: string;
    filePath?: string;
    startPositions: number[];
    endPositions: number[];
  }): never {
    const missing = [
      ...new Set(
        [
          args.startPositions.length === 0 ? args.startHash : undefined,
          args.endPositions.length === 0 ? args.endHash : undefined,
        ].filter((hash): hash is string => hash !== undefined),
      ),
    ];
    const anchors = missing.length > 0 ? missing : [...new Set([args.startHash, args.endHash])];
    throw new DomainError("E_UNKNOWN_ANCHOR", {
      path: args.filePath ?? "this file",
      anchors,
    });
  }

  private throwStaleForTombstone(args: {
    tombstonedHash: string;
    startLine: number;
    endLine: number;
    snapshot: FileSnapshotContext;
    firstOffendingLine: number;
  }): never {
    throw makeStaleAnchorRejection({
      headline:
        `anchor "${args.tombstonedHash}" no longer resolves to the line identity ` +
        `it was served with; nothing was written.`,
      startLine: args.startLine,
      endLine: args.endLine,
      snapshot: args.snapshot,
      cause: "tombstone",
    });
  }

  private throwStale(args: {
    headline: string;
    firstOffendingLine: number;
    servedRows: ServedRow[];
    rendered: string;
    cause: RangeCause;
  }): never {
    throw new DomainError("E_STALE_RANGE", {
      headline: args.headline,
      firstOffendingLine: args.firstOffendingLine,
      servedRows: args.servedRows,
      servedBlock: args.rendered,
      cause: args.cause,
    });
  }
}

// WHY: ---------------------------------------------------------------------------
// WHY: Convenience top-level functions (stateless, global store)
// WHY: ---------------------------------------------------------------------------

const defaultVerifier = new ServedVerification();

export function verifyServedRange(args: {
  served: (string | null)[];
  startHash: string;
  endHash: string;
  startLine: number;
  endLine: number;
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
  tombstone?: ReadonlySet<string>;
  canonDigests?: (string | null)[];
}): void {
  defaultVerifier.verifyOrThrow({
    range: {
      startHash: args.startHash,
      endHash: args.endHash,
      startLine: args.startLine,
      endLine: args.endLine,
    },
    served: args.served,
    fileHashes: args.fileHashes,
    fileLines: args.fileLines,
    filePath: args.filePath,
    tombstone: args.tombstone,
    canonDigests: args.canonDigests,
  });
}

/** SAFETY: Pure result variant — does not throw for expected rejections. */
export function verifyServedRangeResult(input: VerificationInput): VerificationResult {
  return defaultVerifier.verify(input);
}

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
}
