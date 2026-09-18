/**
 * SAFETY: ServedVerification — deep module owning all served-range verification.
 *
 * This module absorbs the served-range verification sprawl previously in served.ts:
 *  - served span resolve (servedPositionsOf + candidate enumeration)
 *  - length mismatch and never-served checks
 *  - rebased-span contiguity gate for the MVCC dynamic rebase path (spec §3.1.1 / Probe J)
 *  - serve-block building (buildRangeServeRows/fmtServedRows/paginationHint/retryHint)
 *  - E_RANGE_* branching via decision table
 *
 * ADR-0008 heuristic canon healing is retired (spec §3.3): un-rebased coordinates reject
 * fail-closed with E_UNSERVED_RANGE. Coordinate realignment is owned exclusively by MVCC
 * `pairSnapshots` + `line_lineage` upstream in the edit path.
 *
 * Canon resolution is instance-scoped via CanonStore (injected), not global.
 * Production uses globalCanonStore; tests inject createCanonStore() for isolation.
 *
 * CONTEXT.md terms preserved: serve, served state, served span, served-range
 * staleness, never-served, reject-and-serve, drift, orphaned serve, orphaning
 * re-serve, relocated line keeps its hash.
 */
import { HASH_SEP, canon, globalCanonStore, type CanonStore } from "./hash.js";
import { SERVED_ROWS_CAP } from "../constants.js";
import type { LeaseIdentityView } from "./resolve.js";

// WHY: ---------------------------------------------------------------------------
// WHY: Public contracts — mirrors served.ts so it can re-export without identity split
// WHY: ---------------------------------------------------------------------------

export type ServedCode = "E_STALE_RANGE" | "E_UNSERVED_RANGE" | "E_TARGET_LOST";

export interface ServedRow {
  position: number;
  hash: string;
}

export interface FileSnapshotContext {
  fileHashes: string[];
  fileLines: string[];
  filePath?: string;
}

export class ServedRejectionError extends Error {
  readonly code: ServedCode;
  readonly firstOffendingLine: number | undefined;
  readonly servedRows: ServedRow[];
  readonly servedBlock: string;

  constructor(opts: {
    code: ServedCode;
    message: string;
    firstOffendingLine?: number;
    servedRows: ServedRow[];
    servedBlock: string;
  }) {
    super(opts.message);
    this.name = "ServedRejectionError";
    this.code = opts.code;
    this.firstOffendingLine = opts.firstOffendingLine;
    this.servedRows = opts.servedRows;
    this.servedBlock = opts.servedBlock;
  }
}

function isServedRejection(error: unknown): error is ServedRejectionError {
  return error instanceof ServedRejectionError;
}

export class AnchorMismatchError extends Error {
  readonly servedRows: ServedRow[];
  readonly servedBlock?: string;

  constructor(message: string, servedRows: ServedRow[], servedBlock?: string) {
    super(message);
    this.name = "AnchorMismatchError";
    this.servedRows = servedRows;
    this.servedBlock = servedBlock;
  }
}

function _isAnchorMismatch(error: unknown): error is AnchorMismatchError {
  return error instanceof AnchorMismatchError;
}

// WHY: ---------------------------------------------------------------------------
// WHY: Shared formatting helpers — owned by verification (reject-and-serve contract)
// WHY: ---------------------------------------------------------------------------

export function buildRangeServeRows(
  startLine: number,
  endLine: number,
  fileHashes: string[],
): ServedRow[] {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, SERVED_ROWS_CAP);
  const rows: ServedRow[] = [];
  for (let ln = startLine; ln < startLine + shown; ln++) {
    rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
  }
  return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
  return rows.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`).join("\n");
}

function retryHint(): string {
  return "Retry with these anchors (no read needed).";
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
 * One reject-and-serve assembly shared by both rejection entry points: the block build and the
 * payload assembly live here, so the `[MODEL] [CODE]` prefix, the `Current range:` contract, the
 * retry hint, and the served rows cannot drift between codes.
 */
function assembleRejectAndServe(args: {
  code: ServedCode | "E_STALE_ANCHOR";
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
}): { message: string; servedRows: ServedRow[]; servedBlock: string } {
  const { servedRows, rendered } = buildRangeServeBlock(
    args.startLine,
    args.endLine,
    args.snapshot.fileHashes,
    args.snapshot.fileLines,
  );
  const hint = `\n${retryHint()}`;
  return {
    message: `[MODEL] [${args.code}] ${args.headline}\nCurrent range:\n${rendered}${hint}`,
    servedRows,
    servedBlock: rendered,
  };
}

/**
 * Recovery sentence for a target-lost rejection (spec stale-identity-reject-and-serve D3):
 * the submitted anchors describe a version of the file that no longer exists, so only a
 * read restores the grounding. Carried instead of the retry hint.
 */
export const TARGET_LOST_RECOVERY =
  "The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.";

/**
 * Builds an `[E_TARGET_LOST]` rejection for a retired leased identity whose region cannot be
 * identified (spec stale-identity-reject-and-serve D1/D6, ADR-0018 decisions 1-2). The payload
 * carries no rows, no `Current range:` heading and no retry hint, so the two codes stay disjoint
 * by payload shape: `[E_STALE_RANGE]` always renders rows, `[E_TARGET_LOST]` never does.
 */
export function makeTargetLostRejection(opts: {
  headline: string;
  servedLine: number;
}): ServedRejectionError {
  const message = `[MODEL] [E_TARGET_LOST] ${opts.headline}\n${TARGET_LOST_RECOVERY}`;
  return new ServedRejectionError({
    code: "E_TARGET_LOST",
    message,
    firstOffendingLine: opts.servedLine,
    servedRows: [],
    servedBlock: "",
  });
}

/** Builds a reject-and-serve `ServedRejectionError` whose rows are the current on-disk range. */
export function makeServedRejection(opts: {
  code: ServedCode;
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
  firstOffendingLine?: number;
}): ServedRejectionError {
  const { message, servedRows, servedBlock } = assembleRejectAndServe(opts);
  return new ServedRejectionError({
    code: opts.code,
    message,
    firstOffendingLine: opts.firstOffendingLine,
    servedRows,
    servedBlock,
  });
}

/**
 * Builds the `[E_STALE_ANCHOR]` reject-and-serve rejection for a boundary anchor the session holds
 * no lease for. It emits the SAME `Current range:` serve contract as the other reject-and-serve
 * rejections (spec §5.3): the served rows are themselves serves, so the retry needs no `read`.
 */
export function makeStaleAnchorRejection(opts: {
  headline: string;
  startLine: number;
  endLine: number;
  snapshot: FileSnapshotContext;
}): AnchorMismatchError {
  const { message, servedRows, servedBlock } = assembleRejectAndServe({
    code: "E_STALE_ANCHOR",
    headline: opts.headline,
    startLine: opts.startLine,
    endLine: opts.endLine,
    snapshot: opts.snapshot,
  });
  return new AnchorMismatchError(message, servedRows, servedBlock);
}

/**
 * Contiguity + identity gate for the dynamic rebase path (spec §3.1.1 / Probe J). The caller resolved
 * each end anchor's leased `line_id` in `line_lineage(C)`; this verifies the whole served window
 * remapped **rigidly** onto `rebasedStart..rebasedEnd`:
 *
 *  - a different window length means an external insert/delete landed strictly inside the range
 *    (Probe J) -> `E_STALE_RANGE`;
 *  - a served line with no mirror row or no lease -> `E_UNSERVED_RANGE`;
 *  - a served line whose lease is retired, or whose `line_id` no longer lives at its expected
 *    rebased coordinate, -> `E_STALE_RANGE` (Probes A/E/K: never apply at a coordinate whose
 *    immutable `line_id` is not the one leased).
 *
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
    });
  }
  for (let k = 0; k < servedLen; k++) {
    const servedAnchor = served[servedStart - 1 + k];
    const currentLine = rebasedStart + k;
    if (servedAnchor === null || servedAnchor === undefined) {
      throw makeServedRejection({
        code: "E_UNSERVED_RANGE",
        headline: `line ${currentLine}${where} was never served.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
      });
    }
    const lease = leaseFor(servedAnchor);
    if (lease === undefined) {
      throw makeServedRejection({
        code: "E_UNSERVED_RANGE",
        headline: `line ${currentLine}${where} has no served line identity.`,
        startLine: rebasedStart,
        endLine: rebasedEnd,
        snapshot,
        firstOffendingLine: currentLine,
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
  servedCanons?: (string | null)[];
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
    };

// WHY: ---------------------------------------------------------------------------
// WHY: ServedVerification — the deep module
// WHY: ---------------------------------------------------------------------------

export class ServedVerification {
  private readonly store: CanonStore;

  constructor(canonStore?: CanonStore) {
    this.store = canonStore ?? globalCanonStore;
  }

  // WHY: -- public: pure result -------------------------------------------------

  verify(input: VerificationInput): VerificationResult {
    try {
      this.verifyOrThrow(input);
      return { ok: true };
    } catch (error) {
      if (isServedRejection(error)) {
        // WHY: the serve block travels as a typed readonly field populated at construction,
        // WHY: so no rebuild is needed here.
        return {
          ok: false,
          code: error.code,
          servedRows: error.servedRows,
          servedBlock: error.servedBlock,
          message: error.message,
          firstOffendingLine: error.firstOffendingLine,
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
      servedCanons: inputServedCanons,
    } = input;
    const tombstone = inputTombstone ?? new Set<string>();
    const servedCanons = inputServedCanons;
    const where = filePath ? ` in ${filePath}` : "";
    const { startHash, endHash, startLine, endLine } = range;

    this.ensureCanonsPopulated(fileHashes, fileLines, served);

    const { servedRows, rendered } = this.buildServeBlock(
      startLine,
      endLine,
      fileHashes,
      fileLines,
    );
    const currentLen = endLine - startLine + 1;

    // WHY: Early tombstone boundary check (whole-span S@3==S@3) — gated on canon inequality to avoid false positive on same-line re-read
    if ((tombstone.has(startHash) || tombstone.has(endHash)) && servedCanons) {
      const tombstonedHash = tombstone.has(startHash) ? startHash : endHash;
      const pos = fileHashes.indexOf(tombstonedHash);
      if (pos >= 0) {
        const servedIdx = served.indexOf(tombstonedHash);
        const expected = servedIdx >= 0 ? servedCanons[servedIdx] : undefined;
        const actual = canon(fileLines[pos] ?? "");
        if (expected !== undefined && expected !== null && expected !== actual) {
          this.throwStale({
            message: `[MODEL] [E_STALE_RANGE] anchor "${tombstonedHash}" no longer matches the current file (its line changed since you saw it).\nCurrent range:\n${rendered}\n${retryHint()}`,
            firstOffendingLine: pos + 1,
            servedRows,
            rendered,
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

    // WHY: --- decision table entry 1: no span could be resolved -> E_UNSERVED_RANGE ---
    // WHY: ADR-0008 canon healing is retired (spec §3.3): an unresolvable span is never relocated
    // WHY: by scanning for matching canons. It fails closed; coordinate realignment is owned
    // WHY: exclusively by MVCC `pairSnapshots` + `line_lineage` in the edit path.
    const from: number | undefined = span.from;
    const to: number | undefined = span.to;

    if (from === undefined || to === undefined) {
      this.throwUnverified({
        served,
        startHash,
        endHash,
        currentLen,
        rendered,
        servedRows,
        where,
        startPositions: servedPositionsOf(served, startHash),
        endPositions: servedPositionsOf(served, endHash),
      });
    }

    // WHY: Canon check for same-pos different content (collision)
    if (servedCanons && from !== undefined && to !== undefined) {
      const servedLen = to - from + 1;
      for (let k = 0; k < servedLen; k++) {
        const expected = servedCanons[from + k];
        if (expected !== null && expected !== undefined) {
          const actual = canon(fileLines[startLine - 1 + k] ?? "");
          if (expected !== actual) {
            this.throwStale({
              message: `[MODEL] [E_STALE_RANGE] line ${startLine + k}${where} differs from what was served (expected "${expected}" vs actual "${actual}").\nCurrent range:\n${rendered}\n${retryHint()}`,
              firstOffendingLine: startLine + k,
              servedRows,
              rendered,
            });
          }
        }
      }
      // WHY: Tombstone interior check (whole-span) — gated on canon inequality (fail-closed only for different canon)
      for (let k = 0; k < servedLen; k++) {
        const h = fileHashes[startLine - 1 + k];
        if (h && tombstone.has(h)) {
          const expectedCanon = servedCanons?.[from + k] ?? undefined;
          const actualCanon = canon(fileLines[startLine - 1 + k] ?? "");
          if (
            expectedCanon !== undefined &&
            expectedCanon !== null &&
            expectedCanon !== actualCanon
          ) {
            this.throwStale({
              message: `[MODEL] [E_STALE_RANGE] line ${startLine + k}${where} no longer matches what was served (its anchor "${h}" changed since you saw it).\nCurrent range:\n${rendered}\n${retryHint()}`,
              firstOffendingLine: startLine + k,
              servedRows,
              rendered,
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

  // WHY: -- private: canon population -------------------------------------------

  private ensureCanonsPopulated(
    fileHashes: string[],
    fileLines: string[],
    served: (string | null)[],
  ): void {
    for (let i = 0; i < fileHashes.length; i++) {
      const h = fileHashes[i]!;
      if (this.store.get(h) === undefined) this.store.set(h, canon(fileLines[i] ?? ""));
    }
    for (let i = 0; i < served.length; i++) {
      const h = served[i];
      if (h !== null && this.store.get(h) === undefined) {
        const pos = fileHashes.indexOf(h);
        if (pos >= 0) this.store.set(h, canon(fileLines[pos] ?? ""));
      }
    }
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

    // WHY: Decision: never-served gap inside served span
    for (let i = from; i <= to; i++) {
      if (served[i] === null) {
        this.throwUnserved({
          message: `[MODEL] [E_UNSERVED_RANGE] line ${i + 1}${where} was never served.\nCurrent range:\n${rendered}\n${retryHint()}`,
          firstOffendingLine: i + 1,
          servedRows,
          rendered,
        });
      }
    }

    // WHY: Decision: length mismatch (served span vs current range). Heuristic length healing is
    // WHY: retired (spec §3.3): a mismatched span is fail-closed, never resized by a canon scan.
    const servedLen = to - from + 1;
    if (servedLen !== currentLen) {
      this.throwStale({
        message: `[MODEL] [E_STALE_RANGE] served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}.\nCurrent range:\n${rendered}\n${retryHint()}`,
        firstOffendingLine: startLine,
        servedRows,
        rendered,
      });
    }

    // WHY: Decision: hash mismatch (stale interior)
    for (let k = 0; k < servedLen; k++) {
      if (served[from + k] !== fileHashes[startLine - 1 + k]) {
        const offendingLine = startLine + k;
        this.throwStale({
          message: `[MODEL] [E_STALE_RANGE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${rendered}\n${retryHint()}`,
          firstOffendingLine: offendingLine,
          servedRows,
          rendered,
        });
      }
    }
  }

  // WHY: -- private: throws with decision-table mapping -------------------------

  private throwUnverified(args: {
    served: (string | null)[];
    startHash: string;
    endHash: string;
    currentLen: number;
    rendered: string;
    servedRows: ServedRow[];
    where: string;
    startPositions: number[];
    endPositions: number[];
  }): never {
    const {
      startHash,
      endHash,
      currentLen,
      rendered,
      servedRows,
      where,
      startPositions,
      endPositions,
    } = args;
    const problems: string[] = [];
    if (startPositions.length === 0) {
      problems.push(`anchor_from "${startHash}" has no served position`);
    } else if (startPositions.length > 1) {
      problems.push(`anchor_from "${startHash}" was served at ${startPositions.length} positions`);
    }
    if (endPositions.length === 0) {
      problems.push(`anchor_to "${endHash}" has no served position`);
    } else if (endPositions.length > 1) {
      problems.push(`anchor_to "${endHash}" was served at ${endPositions.length} positions`);
    }
    const err = new ServedRejectionError({
      code: "E_UNSERVED_RANGE",
      message:
        `[MODEL] [E_UNSERVED_RANGE] cannot verify range against served state${where}: ${problems.join("; ")}. ` +
        `No served span matched the current range (${currentLen} lines). ` +
        `A full read will re-sync the served mirror — the served range below is current content, ` +
        `but retrying without re-reading cannot clear a stale duplicate outside the served window.\n` +
        `Current range:\n${rendered}`,
      servedRows: servedRows,
      servedBlock: rendered,
    });
    throw err;
  }

  private throwStale(args: {
    message: string;
    firstOffendingLine: number;
    servedRows: ServedRow[];
    rendered: string;
  }): never {
    const err = new ServedRejectionError({
      code: "E_STALE_RANGE",
      message: args.message,
      firstOffendingLine: args.firstOffendingLine,
      servedRows: args.servedRows,
      servedBlock: args.rendered,
    });
    throw err;
  }

  private throwUnserved(args: {
    message: string;
    firstOffendingLine: number;
    servedRows: ServedRow[];
    rendered: string;
  }): never {
    const err = new ServedRejectionError({
      code: "E_UNSERVED_RANGE",
      message: args.message,
      firstOffendingLine: args.firstOffendingLine,
      servedRows: args.servedRows,
      servedBlock: args.rendered,
    });
    throw err;
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
  canonStore?: CanonStore;
  tombstone?: ReadonlySet<string>;
  servedCanons?: (string | null)[];
}): void {
  const verifier = args.canonStore ? new ServedVerification(args.canonStore) : defaultVerifier;
  verifier.verifyOrThrow({
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
    servedCanons: args.servedCanons,
  });
}

/** SAFETY: Pure result variant — does not throw for expected rejections. */
export function verifyServedRangeResult(
  input: VerificationInput,
  canonStore?: CanonStore,
): VerificationResult {
  const verifier = canonStore ? new ServedVerification(canonStore) : defaultVerifier;
  return verifier.verify(input);
}

export interface ResolvedRange {
  startLine: number;
  endLine: number;
  startHash: string;
  endHash: string;
  delta: number;
}
