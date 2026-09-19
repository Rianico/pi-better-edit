import { abortIf, rejectUnknownFields, clipLine } from "../utils.js";
import { DomainError, formatReversedAnchorsHealed } from "../domain-errors.js";
import { HASH_CLASS } from "./hash-identity.js";
import { parseHashRef, parseText, type Anchor } from "./parse.js";
import type { ServedRow } from "./served.js";
import type { FileSnapshotContext } from "./served-verification.js";

type RAnchor = {
  line: number;
  hash: string;
  hashMatched: boolean;
};

// WHY: ---------------------------------------------------------------------------
// WHY: Line-identity MVCC lease resolution (spec §3.1, §3.5)
// WHY: ---------------------------------------------------------------------------

/**
 * The immutable identity a session holds for one served anchor (spec §3.1.1). It is a plain view
 * over one `served_leases` row; the edit path only ever reads it.
 */
export interface LeaseIdentityView {
  lineId: number;
  canonHash: string;
  servedSnapshotHash: string;
  servedLineNumber: number;
  retiredAt: number | null;
}

/**
 * Read-only identity seam the edit path resolves anchors through (spec §3.1.1). Production wires it
 * to `served_leases` + `line_lineage`; tests inject plain maps. Nothing here writes a lease: the
 * authoritative `retired_at` writer is materialization, never resolution.
 */
export interface LeaseSpanSource {
  /** `CANON_VERSION:xxh64(content)` of the buffer being edited — the `C` of the fast-path predicate. */
  currentSnapshotHash: string;
  /** The session's lease for one anchor, if any (spec §3.1.1 step 1). */
  leaseFor(anchor: string): LeaseIdentityView | undefined;
  /** Current line of a leased `line_id` in `line_lineage(C)`; undefined when deleted/retired (spec §3.1.1 steps 3-4). */
  rebasedLineOf(lineId: number): number | undefined;
  /**
   * Other files this session served one anchor for, excluding the file being edited.
   * Backed by its own `served_leases` query on `(session_id, anchor)`; it runs
   * on the failure path only, so the happy path pays nothing. A path-level
   * clear deletes rows, so a previously served anchor then reads as holding
   * no lease anywhere — re-reading is the correct recovery either way, so no
   * special case is kept.
   */
  anchorHomes?(anchor: string): string[];
}

/**
 * The O(1) fast path qualifies **iff** both anchors were leased from the content now on disk —
 * `S_from === C ∧ S_to === C ∧ S_from === S_to` (spec §3.5). Any mixed-snapshot span, any drift
 * (`S !== C`), takes the dynamic rebase path through `line_lineage`, so a stale lease can never be
 * applied at its old coordinates.
 */
export function isUniformLeaseFastPath(
  from: LeaseIdentityView,
  to: LeaseIdentityView,
  currentSnapshotHash: string,
): boolean {
  return (
    from.servedSnapshotHash === currentSnapshotHash &&
    to.servedSnapshotHash === currentSnapshotHash &&
    from.servedSnapshotHash === to.servedSnapshotHash
  );
}

/**
 * Per-lease line-identity decision: where the leased line lives now, or that the leased identity is
 * gone and the edit fails closed with `E_STALE_RANGE`.
 */
export type LineIdentityDecision = { kind: "line"; line: number } | { kind: "stale"; line: number };

/**
 * Resolves one leased anchor against the current content (spec §3.1.1 steps 2-4).
 *
 * A live lease is authoritative about *where* its line is; the answer is `stale` — fail-closed
 * `E_STALE_RANGE` — when the lease is retired, when its `line_id` has no coordinate in
 * `line_lineage(C)`, or when it no longer lives where it was served. Content is never consulted as a
 * resolution: an anchor whose line identity is gone is a stale range, never `E_STALE_ANCHOR` (the
 * code reserved for an anchor the session holds no lease for, spec §5.3).
 */
export function resolveLineIdentity(
  lease: LeaseIdentityView,
  source: LeaseSpanSource,
): LineIdentityDecision {
  // WHY: a dead lease can never be applied, and a live lease is authoritative about *where* its
  // WHY: line is: content-derived anchors can be re-assigned to a colliding line in the new
  // WHY: snapshot, but §7.1.5 forbids committing to any line whose `line_id` is not the leased one.
  // WHY: `retired_at` is set -> `E_STALE_RANGE` even when the anchor string is gone from the content
  // WHY: entirely (spec §3.1.1 line 89 / §5.3): the leased line was retired, so nothing has changed
  // WHY: about *which* line identity is missing, only about whether it still has a coordinate.
  // WHY: stale coordinates stay lease-derived only (`lease.servedLineNumber`): no content lookup
  // WHY: ever names the headline or the window for a retired bound (stale-identity D5, Probe P).
  if (lease.retiredAt !== null) {
    return { kind: "stale", line: lease.servedLineNumber };
  }
  const rebased = source.rebasedLineOf(lease.lineId);
  if (rebased === undefined) {
    return { kind: "stale", line: lease.servedLineNumber };
  }
  return { kind: "line", line: rebased };
}

/**
 * The single 1-based position of `item` in `items`, or `undefined` when it is absent or occurs
 * more than once. A repeated anchor is ambiguous, so it is never resolved by guessing.
 */
function uniqueItemPosition<T>(items: readonly T[], item: T): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < items.length; i++) {
    if (items[i] !== item) continue;
    if (found !== undefined) return undefined;
    found = i + 1;
  }
  return found;
}

/**
 * The unique 1-based positions of `first` and `second` in one column, each `undefined` when that
 * value is absent or ambiguous. A span's two bounds are always asked for together, so the pair
 * scan keeps both answers on the same "exactly once" rule.
 */
export function uniqueItemPositions<T>(
  items: readonly T[],
  first: T,
  second: T,
): [number | undefined, number | undefined] {
  const firstPosition = uniqueItemPosition(items, first);
  const secondPosition = uniqueItemPosition(items, second);
  return [firstPosition, secondPosition];
}

/** The unique 1-based line an anchor resolves to, or undefined when absent/ambiguous. */
export function uniqueAnchorLine(fileHashes: string[], anchor: string): number | undefined {
  return uniqueItemPosition(fileHashes, anchor);
}

/** The unique 1-based position an anchor was served at, or undefined when absent/ambiguous. */
export function uniqueServedPosition(
  served: readonly (string | null)[],
  anchor: string,
): number | undefined {
  return uniqueItemPosition(served, anchor);
}

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
  content_lines: string[];
  hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
  ref: Anchor;
  kind: "not_found" | "ambiguous";
  candidates?: number[];
  context?: RAnchor;
}

export interface NEdit {
  loc: string;
  currentContent: string;
}

export type HTEdit = {
  replace_with: string;
  anchor_from: string;
  anchor_to: string;
};

function resAnchorFromMap(ref: Anchor, hashIndex: Map<string, number[]>): RAnchor | HMismatch {
  const hashMatches = hashIndex.get(ref.hash);
  if (!hashMatches || hashMatches.length === 0) {
    return { ref, kind: "not_found" };
  }
  if (hashMatches.length === 1) {
    return {
      line: hashMatches[0]!,
      hash: ref.hash,
      hashMatched: true,
    };
  }
  return { ref, kind: "ambiguous", candidates: hashMatches };
}

function assertAligned(fileLines: string[], fileHashes: string[], ctx: string): void {
  if (fileHashes.length !== fileLines.length) {
    throw new Error(
      `${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
    );
  }
}

function _fmtMismatch(mismatches: HMismatch[], snapshot: FileSnapshotContext): string {
  return fmtMismatchWithServes(mismatches, snapshot).message;
}

function formatNotFound(
  notFound: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath: string | undefined,
  pushRow: (ln: number) => void,
  out: string[],
): void {
  if (notFound.length === 0) return;
  const distinct = [...new Map(notFound.map((m) => [m.ref.hash, m])).values()];
  const refList = distinct.map((m) => `"${m.ref.hash}"`).join(", ");
  // WHY: the body carries no code tag — the registry owns the `[MODEL] [E_*]`
  // WHY: header when the caller wraps this in a `DomainError`.
  out.push(
    `${distinct.length} stale anchor${distinct.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp").`,
  );
  for (const m of distinct) {
    const ctx = m.context;
    if (!ctx) continue;
    const from = Math.max(1, ctx.line - 1);
    const to = Math.min(fileLines.length, ctx.line + 1);
    const rows: string[] = [];
    for (let ln = from; ln <= to; ln++) {
      rows.push(`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`);
      pushRow(ln);
    }
    out.push("");
    out.push(
      `  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`,
    );
  }
}
function formatAmbiguous(
  ambiguous: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath: string | undefined,
  pushRow: (ln: number) => void,
  out: string[],
): void {
  if (ambiguous.length === 0) return;
  if (out.length > 0) out.push("");
  const distinctAmbiguous = [...new Map(ambiguous.map((m) => [m.ref.hash, m])).values()];
  out.push(
    `${distinctAmbiguous.length} ambiguous anchor${distinctAmbiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp").`,
  );
  for (const m of distinctAmbiguous) {
    const sample = (m.candidates ?? []).slice(0, 5);
    const more =
      (m.candidates?.length ?? 0) > sample.length
        ? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
        : "";
    const lines = sample
      .map((line) => {
        const content = clipLine(fileLines[line - 1] ?? "");
        pushRow(line);
        return `    ${line}: ${fileHashes[line - 1]}│${content}`;
      })
      .join("\n");
    out.push(`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`);
  }
}
function buildHashIndex(fileHashes: string[]): Map<string, number[]> {
  const hashIndex = new Map<string, number[]>();
  for (let i = 0; i < fileHashes.length; i++) {
    const h = fileHashes[i]!;
    const list = hashIndex.get(h) ?? [];
    list.push(i + 1);
    hashIndex.set(h, list);
  }
  return hashIndex;
}
export function fmtMismatchWithServes(
  mismatches: HMismatch[],
  snapshot: FileSnapshotContext,
): { message: string; servedRows: ServedRow[] } {
  const { fileLines, fileHashes, filePath } = snapshot;
  assertAligned(fileLines, fileHashes, "fmtMismatch");

  const out: string[] = [];
  const servedRows: ServedRow[] = [];
  const seen = new Set<number>();
  const pushRow = (ln: number) => {
    if (ln < 1 || ln > fileLines.length) return;
    const position = ln - 1;
    if (seen.has(position)) return;
    seen.add(position);
    servedRows.push({ position, hash: fileHashes[ln - 1]! });
  };
  const notFound = mismatches.filter((m) => m.kind === "not_found");
  const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");
  formatNotFound(notFound, fileLines, fileHashes, filePath, pushRow, out);
  formatAmbiguous(ambiguous, fileLines, fileHashes, filePath, pushRow, out);

  return { message: out.join("\n"), servedRows };
}

const ITEM_KS = new Set(["replace_with", "anchor_from", "anchor_to"]);

function assertItem(edit: Record<string, unknown>): void {
  rejectUnknownFields(
    edit,
    ITEM_KS,
    "Edit",
    "The edit takes only { replace_with, anchor_from, anchor_to }.",
  );

  if ("anchor_from" in edit && typeof edit.anchor_from !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Field "anchor_from" must be a bare 3-char hash anchor copied from served output (before │). Nothing was written; fix the field and retry.',
    });
  }
  if ("anchor_to" in edit && typeof edit.anchor_to !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Field "anchor_to" must be a bare 3-char hash anchor copied from served output (before │). Nothing was written; fix the field and retry.',
    });
  }
  if (!("replace_with" in edit)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'The edit requires a "replace_with" field. Provide the replacement text (use "" to delete). Nothing was written.',
    });
  }
  if (typeof edit.replace_with !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        '"replace_with" must be a string with \\n line separators, not an array. Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range. Nothing was written.',
    });
  }
  if (typeof edit.anchor_from !== "string" || typeof edit.anchor_to !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'The edit requires "anchor_from" and "anchor_to" anchor strings (bare 3-char hashes from served output). Nothing was written.',
    });
  }
}

// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, linear row prefix — bounded, no user input, no ReDoS.
const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_CLASS})│`);
function firstHashFromBlock(block: string): string | undefined {
  for (const line of block.split("\n")) {
    const m = line.match(ANCHOR_ROW_RE);
    if (m) return m[2]!;
    // SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, bounded 3-char, linear search — no user-controlled pattern, no ReDoS.
    const bare = line.match(new RegExp(HASH_CLASS));
    if (bare) return bare[0]!;
  }
  return undefined;
}

export function resEdit(edit: HTEdit): HEdit {
  assertItem(edit as Record<string, unknown>);

  const editLines = parseText(edit.replace_with);
  const bounds = [edit.anchor_from, edit.anchor_to].map((ref) => {
    const trimmed = ref.trim();
    if (trimmed.includes("\n")) {
      const hash = firstHashFromBlock(trimmed);
      if (hash) {
        const lines = trimmed.split("\n").length;
        throw new DomainError("E_MALFORMED_ANCHOR", {
          rawAnchor: `${lines}-line block`,
          reason: `extracted first hash "${hash}" from a ${lines}-line block — use bare "${hash}" next time`,
        });
      }
    }
    const match = trimmed.match(ANCHOR_ROW_RE);
    if (match) {
      let reason: string;
      if (match[1] === "+") {
        reason = `anchor carries a diff-preview "+" marker ("${trimmed}"). Nothing was written; pass the bare 3-char anchor and retry.`;
      } else if (match[1] === "-") {
        reason = `anchor carries a leading "-" marker ("${trimmed}"). Nothing was written; pass the bare 3-char anchor and retry.`;
      } else {
        reason = `anchor carries a "HASH│" prefix ("${trimmed}"). Nothing was written; copy only the 3 chars before │ and retry.`;
      }
      throw new DomainError("E_MALFORMED_ANCHOR", { rawAnchor: trimmed, reason });
    }
    return ref;
  }) as [string, string];
  return {
    content_lines: editLines,
    hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
  };
}

function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
  if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
    warnings.push(
      "Literal \\uDDDD in edit content; no autocorrection applied. Verify whether this is a real Unicode escape or plain text.",
    );
  }
}

export function swapReversedRanges(edit: HEdit, fileHashes: string[], warnings: string[]): HEdit {
  const lineByHash = new Map<string, number>();
  for (let i = 0; i < fileHashes.length; i++) {
    lineByHash.set(fileHashes[i]!, i + 1);
  }
  const [startRef, endRef] = edit.hash_bounds;
  const startLine = lineByHash.get(startRef.hash);
  const endLine = lineByHash.get(endRef.hash);
  if (startLine === undefined || endLine === undefined || startLine <= endLine) {
    return edit;
  }
  warnings.push(formatReversedAnchorsHealed({ fromAnchor: startRef.hash, toAnchor: endRef.hash }));
  return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

export function valEdit(
  edit: HEdit,
  snapshot: FileSnapshotContext,
  signal: AbortSignal | undefined,
): {
  resolved: RHEdit | undefined;
  mismatches: HMismatch[];
} {
  const { fileLines, fileHashes } = snapshot;
  assertAligned(fileLines, fileHashes, "valEdit");
  const mismatches: HMismatch[] = [];

  const hashIndex = buildHashIndex(fileHashes);

  const tryResolve = (ref: Anchor): RAnchor | undefined => {
    const result = resAnchorFromMap(ref, hashIndex);
    if ("kind" in result) {
      mismatches.push(result);
      return undefined;
    }
    return result;
  };

  abortIf(signal);
  const startResolved = tryResolve(edit.hash_bounds[0]);
  const endResolved = tryResolve(edit.hash_bounds[1]);
  if (!startResolved || !endResolved) {
    if (!startResolved && endResolved) {
      const startMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[0]);
      if (startMismatch && startMismatch.kind === "not_found") startMismatch.context = endResolved;
    } else if (startResolved && !endResolved) {
      const endMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[1]);
      if (endMismatch && endMismatch.kind === "not_found") endMismatch.context = startResolved;
    }
    return { resolved: undefined, mismatches };
  }
  if (startResolved.line > endResolved.line) {
    throw new DomainError("E_REVERSED_ANCHORS", {
      startLine: startResolved.line,
      endLine: endResolved.line,
      fromAnchor: edit.hash_bounds[0].hash,
      toAnchor: edit.hash_bounds[1].hash,
    });
  }

  return {
    resolved: {
      content_lines: edit.content_lines,
      hash_bounds: [startResolved, endResolved],
    },
    mismatches,
  };
}

/**
 * Content-anchor resolution for a caller with NO served mirror and NO lease source — the
 * library-level `applyEdit` seam (tools embedding the resolver, unit tests of the pure anchor
 * algebra). A session edit never reaches this: `apply.ts` routes every edit that has a seam through
 * `resolveLeasedEdit`, so an anchor with no lease fails closed (`[E_STALE_ANCHOR]`) instead of being
 * satisfied by a colliding content anchor (spec §3.1.1, §5.3; ADR-0016 rejected "content equality as
 * a fallback when the lease is missing").
 */
export function resolveEditByContent(
  edit: HEdit,
  snapshot: FileSnapshotContext,
  signal: AbortSignal | undefined,
): { resolved: RHEdit | undefined; mismatches: Parameters<typeof fmtMismatchWithServes>[0] } {
  const { resolved, mismatches } = valEdit(edit, snapshot, signal);
  return { resolved, mismatches };
}

export { warnUnicodeEsc };
