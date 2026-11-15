import { abortIf, splitLines } from "../utils.js";
import { DomainError, formatWarning } from "../domain-errors.js";
import { HASH_SEP, defaultHashIdentity } from "./hash-identity.js";
import { type ResolvedRange } from "../served-session/serve-render.js";
import {
  findServedHashEcho,
  findServedPrefixMismatches,
  findNeverServedAnchorShapes,
  buildServedEditPrefixNote,
  trackServedEditRefusal,
  LITERAL_BYPASS_NOTICE,
} from "../served-session/serve-render.js";
import {
  resolveEditByContent,
  swapReversedRanges,
  warnUnicodeEsc,
  fmtMismatchWithServes,
  type RHEdit,
  type NEdit,
  type HEdit,
  type LeaseSpanSource,
} from "./resolve.js";
import { resolveLeasedEdit } from "./lease-resolve.js";

type LIdx = {
  fileLines: string[];
  lineStarts: number[];
};

function buildIdx(content: string): LIdx {
  const fileLines = splitLines(content);
  const lineStarts: number[] = [];
  let offset = 0;

  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index]!.length;
    if (index < fileLines.length - 1) {
      offset += 1;
    }
  }

  return {
    fileLines,
    lineStarts,
  };
}

type RESpan = {
  kind: "replace";
  start: number;
  end: number;
  replacement: string;
};

type NoopSpan = {
  kind: "noop";
  loc: string;
  currentContent: string;
};

/** SAFETY: served hash echo predicate lives in `../served-session/serve-render.js` — one evidence predicate for the edit apply path and the write hook. */
export { findServedHashEcho, ServedHashEchoError } from "../served-session/serve-render.js";

/**
 * The verification cluster that travels with an edit from the session pipeline
 * (issue #115): the file identity, the served mirror, and the read-only lease
 * source. One descriptor instead of positional booleans/arrays, so an
 * argument-order slip cannot silently rewire verification.
 */
export interface ApplyVerificationContext {
  filePath?: string;
  absolutePath?: string;
  served?: (string | null)[];
  /**
   * SAFETY: canon digests parallel to `served` — `String(xxh32(canon(line)))`, the value
   * `served_leases.canon_hash` persists. The session derives them from its leases; a caller with no
   * digest records no evidence, and an absent array keeps every canon scan silent (never a shape
   * refusal).
   */
  canonDigests?: (string | null)[];
  identity?: LeaseSpanSource;
  mode?: "general" | "literal";
  /**
   * SAFETY: the session that owns the served mirror this edit is verified against.
   * Omitted only by the library-level `applyEdit` seam, which has no session: its
   * refusal then carries count 1 and keeps no tally — a shared fallback bucket would
   * leak one caller's refusals into another's (#132).
   */
  sessionKey?: string;
}

function assertNotEmpty(originalContent: string, result: string): void {
  if (originalContent.length > 0 && result.length === 0) {
    throw new DomainError("E_EMPTY_RANGE", {});
  }
}

/**
 * The zero-width insertion splice (ticket-01): `before` lands between the preceding newline and
 * the span's first line, `after` lands after the span's last line's content and before the
 * existing separator — including at EOF with no trailing newline. Inserting at least one line
 * always changes the bytes, so an insertion never reaches the noop comparison.
 * WHY: (ticket-04 §3.4) `applyEdit` refuses an insertion whose resolved target spans more than one
 * WHY: line before reaching here, so both bounds name the same line.
 */
function insertionSpan(edit: RHEdit, lineIndex: LIdx): RESpan {
  const { fileLines, lineStarts } = lineIndex;
  const inserted = edit.content_lines.join("\n");
  if (edit.placement === "before") {
    const start = lineStarts[edit.hash_bounds[0].line - 1]!;
    return { kind: "replace", start, end: start, replacement: `${inserted}\n` };
  }
  const endLine = edit.hash_bounds[1].line;
  const end = lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length;
  return { kind: "replace", start: end, end, replacement: `\n${inserted}` };
}

function resToSpan(edit: RHEdit, content: string, lineIndex: LIdx): RESpan | NoopSpan {
  if (edit.placement === "before" || edit.placement === "after") {
    return insertionSpan(edit, lineIndex);
  }

  const { fileLines, lineStarts } = lineIndex;

  const startLine = edit.hash_bounds[0].line;
  const endLine = edit.hash_bounds[1].line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.content_lines.length &&
    originalLines.every((line, lineIndex) => line === edit.content_lines[lineIndex])
  ) {
    return {
      kind: "noop",
      loc: edit.hash_bounds[0].hash,
      currentContent: originalLines.join("\n"),
    };
  }

  if (edit.content_lines.length > 0) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
      replacement: edit.content_lines.join("\n"),
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      kind: "replace",
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  if (content.endsWith("\n")) {
    return {
      kind: "replace",
      start: lineStarts[startLine - 1]!,
      end: content.length,
      replacement: "",
    };
  }

  const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined;
  return {
    kind: "replace",
    start:
      prevLine !== undefined && prevLine.length === 0
        ? lineStarts[startLine - 1]!
        : Math.max(0, lineStarts[startLine - 1]! - 1),
    end: content.length,
    replacement: "",
  };
}

function assemble(content: string, sp: RESpan, signal: AbortSignal | undefined): string {
  abortIf(signal);
  return content.slice(0, sp.start) + sp.replacement + content.slice(sp.end);
}

/**
 * WHY: (ticket-02b P1-A) span-ref items assemble from LINE coordinates on the pre-item buffer: an
 * WHY: insertion point is a position BETWEEN lines, so the four legal touching spellings of one
 * WHY: position (`before T=s1` ≡ `after T=s1-1`, `after T=s2` ≡ `before T=s2+1`) compute the same
 * WHY: line list — a degenerate adjacent move is byte identity BY CONSTRUCTION, which the
 * WHY: byte-level clamp could not promise because `before`/`after` replacements carry opposite
 * WHY: newline shapes and never commute through a removal that eats a newline (falsified at
 * WHY: 108/189 clamp firings; the falsifying tests are the alias matrix in
 * WHY: `test/tools/mutation-engine.span-ref.test.ts` and the sweep in
 * WHY: `test/core/hashline.span-ref-sweep.test.ts`).
 */
function assembleLines(
  content: string,
  fileLines: string[],
  retired: { s1: number; s2: number } | undefined,
  placement: RHEdit["placement"],
  t1: number,
  t2: number,
  copied: string[],
): string {
  const out: string[] = [];
  for (let i = 1; i <= fileLines.length; i++) {
    if (placement === "before" && i === t1) out.push(...copied);
    const insideSource = retired !== undefined && i >= retired.s1 && i <= retired.s2;
    if (insideSource) {
      // WHY: a retired line contributes nothing, but the `after` point beside it still emits:
      // WHY: `after T=s2` is the legal alias of `before T=s2+1`.
    } else if (placement === undefined && i >= t1 && i <= t2) {
      if (i === t1) out.push(...copied);
    } else {
      out.push(fileLines[i - 1]!);
    }
    if (placement === "after" && i === t2) out.push(...copied);
  }
  return serializeLineList(content, fileLines, retired, out);
}

/**
 * SAFETY: one serialization rule for a line list produced by span-ref assembly — shared by
 * `assembleLines` and the sweep's reference oracle (`test/core/hashline.span-ref-sweep.test.ts`)
 * so the two can never silently fork it (ticket-02c F4). The pinned EOF-deletion convention lives
 * HERE and nowhere else: a retirement reaching EOF in a file with no trailing newline keeps a
 * surviving empty line's own terminator — the empty-preceding-line arm of `resToSpan`'s EOF
 * deletion, byte-asserted in `test/core/hashline.apply.test.ts` ("EOF deletion preserves an empty
 * preceding line"). For a non-empty file with a surviving line, `out`'s last line is empty without
 * an original trailing newline only when that arm fired (ticket-02c F1: the byte convention is
 * canonical, the line path conforms). The empty file is a shape that arm cannot describe: `splitLines("")` is one empty line, so a degenerate
 * retirement assembles `out = [""]` without the arm ever firing, and `content.length > 0` keeps that spelling the honest noop (ticket-02d P1).
 */
export function serializeLineList(
  content: string,
  fileLines: string[],
  retired: { s1: number; s2: number } | undefined,
  out: string[],
): string {
  const terminator =
    content.endsWith("\n") ||
    (content.length > 0 &&
      retired !== undefined &&
      retired.s2 === fileLines.length &&
      out[out.length - 1] === "")
      ? "\n"
      : "";
  return out.join("\n") + terminator;
}

function prepareEdit(fileHashes: string[], edit: HEdit, warnings: string[]): { fixed: HEdit } {
  return { fixed: swapReversedRanges(edit, fileHashes, warnings) };
}

/**
 * Anchor resolution seam: lease-first (MVCC, spec §3.1.1) for every edit the session has a lease
 * source for — `served_leases` is looked up before anything else, so an anchor with no lease is
 * `[E_STALE_ANCHOR]` and never re-anchored onto colliding content. The lease path is read-only on
 * `served_leases`; verification is owned by the lease seam for both its paths (`verifyRebasedSpan`
 * over the whole served window), so no coordinate the lease path returns is re-checked here.
 *
 * Content resolution is NOT a fallback here: `resolveEditByContent` is only for a caller that
 * presents no seam at all (the library-level `applyEdit`), and a session edit always presents one.
 */
function resolveEdit(
  edit: HEdit,
  fileLines: string[],
  fileHashes: string[],
  filePath: string | undefined,
  served: (string | null)[] | undefined,
  identity: LeaseSpanSource | undefined,
  signal: AbortSignal | undefined,
): {
  resolved: RHEdit | undefined;
  mismatches: Parameters<typeof fmtMismatchWithServes>[0];
  /** The healed swap when the resolved lines ran opposite the slot pair; narrated by the caller. */
  reversed: { fromHash: string; toHash: string } | undefined;
} {
  if (served && identity) {
    const leased = resolveLeasedEdit({
      edit,
      snapshot: {
        fileHashes,
        fileLines,
        ...(filePath !== undefined ? { filePath } : {}),
      },
      served,
      source: identity,
    });
    return {
      resolved: leased.resolved,
      mismatches: [],
      reversed: leased.reversed,
    };
  }
  // WHY: the no-seam branch is the library-level `applyEdit` case, where anchor algebra is the only
  // WHY: authority; a session edit carries both, and lost identity fails closed in the lease seam above.
  const byContent = resolveEditByContent(
    edit,
    { fileHashes, fileLines, ...(filePath !== undefined ? { filePath } : {}) },
    signal,
  );
  return {
    resolved: byContent.resolved,
    mismatches: byContent.mismatches,
    reversed: byContent.reversed,
  };
}
export function applyEdit(
  content: string,
  edit: HEdit,
  signal?: AbortSignal,
  precomputedHashes?: string[],
  verification?: ApplyVerificationContext,
): {
  content: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  range: ResolvedRange;
  warnings?: string[];
  noopEdit?: NEdit;
  literalBypass?: boolean;
  neverServedCount?: number;
  /** Present when a span-ref move retires its source: the retired span in pre-item coordinates. */
  sourceRange?: ResolvedRange;
  /**
   * Present for span-ref items: every line region the item actually mutates, in pre-item
   * coordinates, with the number of lines written there. The caller's identity bookkeeping
   * splices exactly these regions, so a target skipped as a noop can never shift the map.
   */
  mutationSpans?: { startLine: number; endLine: number; inserted: number }[];
  /** Present for span-ref items: honest per-item line counts (invariant 8). */
  mutationStats?: { addedLines: number; removedLines: number };
} {
  abortIf(signal);

  const {
    filePath,
    absolutePath,
    served,
    canonDigests,
    identity,
    mode = "general",
    sessionKey,
  } = verification ?? {};

  const lineIndex = buildIdx(content);
  // WHY: no pathless materialization — without precomputed hashes a path is required, so anchors
  // WHY: derive file-scoped and never content-only.
  const fileHashes =
    precomputedHashes ??
    (filePath === undefined
      ? (() => {
          throw new DomainError("E_INTERNAL_INVARIANT", {
            message: "applyEdit requires precomputed hashes or a file path.",
          });
        })()
      : defaultHashIdentity.hashesForSync(content, filePath));
  const warnings: string[] = [];
  let literalBypass = false;

  const prefixFixed = prepareEdit(fileHashes, edit, warnings).fixed;

  const { resolved, mismatches, reversed } = resolveEdit(
    prefixFixed,
    lineIndex.fileLines,
    fileHashes,
    filePath,
    served,
    identity,
    signal,
  );
  if (reversed) {
    warnings.push(formatWarning("W_REVERSED_ANCHORS", reversed));
  }
  if (mismatches.length || !resolved) {
    const anchors = [...new Set(mismatches.map((mismatch) => mismatch.ref.hash))];
    throw new DomainError("E_UNKNOWN_ANCHOR", {
      path: filePath ?? "this file",
      anchors,
    });
  }

  // WHY: (ticket-04 §3.4) a resolved multi-line target has no single zero-width insertion point, so
  // WHY: the placement is refused after resolution — a raw anchor-string comparison cannot see a
  // WHY: rebased span — and before assembly, covering literal, reference and foreign payloads alike.
  if (
    (resolved.placement === "before" || resolved.placement === "after") &&
    resolved.hash_bounds[0].line !== resolved.hash_bounds[1].line
  ) {
    const t1 = resolved.hash_bounds[0].line;
    const t2 = resolved.hash_bounds[1].line;
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        `Field "at" ("${resolved.placement}") requires a single-line target span: the anchors ` +
        `resolve to lines ${t1}-${t2}. Nothing was written; narrow the anchors to one line, or ` +
        'use "in-place" to rewrite the range.',
    });
  }

  // WHY: (ticket-02) the source resolves through the SAME seam and authority as the target, so an
  // WHY: unresolvable source records reject-and-serve rows exactly like a rejected target; both
  // WHY: spans are then measured on this one pre-item `lineIndex`.
  let resolvedSource: RHEdit | undefined;
  if (edit.source) {
    const sourceEdit: HEdit = { content_lines: [], hash_bounds: edit.source.bounds };
    const fixedSource = prepareEdit(fileHashes, sourceEdit, warnings).fixed;
    const source = resolveEdit(
      fixedSource,
      lineIndex.fileLines,
      fileHashes,
      filePath,
      served,
      identity,
      signal,
    );
    if (source.reversed) {
      warnings.push(formatWarning("W_REVERSED_ANCHORS", source.reversed));
    }
    if (!source.resolved || source.mismatches.length) {
      const anchors = [...new Set(source.mismatches.map((mismatch) => mismatch.ref.hash))];
      throw new DomainError("E_UNKNOWN_ANCHOR", {
        path: filePath ?? "this file",
        anchors,
      });
    }
    resolvedSource = source.resolved;
    const s1 = resolvedSource.hash_bounds[0].line;
    const s2 = resolvedSource.hash_bounds[1].line;
    if (edit.source.retire) {
      // WHY: (ticket-02b P1-B) the overlap question is placement-aware because an insertion point is
      // WHY: BETWEEN lines: `before` overlaps only (s1 < T <= s2), `after` only (s1 <= T < s2), and the
      // WHY: four touching spellings denote positions OUTSIDE the retired lines — invariant 10 makes
      // WHY: them honest noops, so refusing one spelling would refuse its alias.
      const t1 = resolved.hash_bounds[0].line;
      const t2 = resolved.hash_bounds[1].line;
      const overlap =
        resolved.placement === "before"
          ? s1 < t1 && t1 <= s2
          : resolved.placement === "after"
            ? s1 <= t2 && t2 < s2
            : Math.max(t1, s1) <= Math.min(t2, s2);
      if (overlap) {
        const target =
          resolved.placement === undefined
            ? `target (lines ${t1}-${t2})`
            : `target line ${t1} (at "${resolved.placement}")`;
        // WHY: (sweep (a)) the retired `copy_from`/`delete_source` spellings named wire fields that
        // WHY: no longer exist — the retrying party sends `"text_ref"` and its `"mode"`.
        throw new DomainError("E_BAD_PAYLOAD", {
          message:
            `A move's "text_ref" span (lines ${s1}-${s2}) overlaps its ${target} while "mode": "cut" is set. ` +
            'Nothing was written: keep the "text_ref" span disjoint from the target (touching is fine), or use "mode": "copy".',
        });
      }
    }
    // WHY: materialize before the evidence scan so every gate sees the lines that will be written
    // WHY: (invariant 9): copied and hand-written text are the same kind of input.
    // WHY: (ticket-02c AP4 ledger) no fail-closed guard for an empty retirement — the deleted
    // WHY: `slice(s1 - 1, s2).length === 0` throw — because no input reaches it: both seams heal a
    // WHY: reversed pair (`valEdit` in `resolve.ts`, `resolveLeasedEdit`) so `s1 <= s2`, and
    // WHY: `verifyRebasedSpan` refuses out-of-buffer coordinates with `E_STALE_RANGE`, so
    // WHY: `s2 <= fileLines.length`; instrumentation at 67a5812 saw 6,346 source-arm runs, 0 degenerate.
    resolved.content_lines = lineIndex.fileLines.slice(s1 - 1, s2);
  }

  warnUnicodeEsc(prefixFixed, warnings);

  if (served) {
    // WHY: evidence-only gate: one position-agnostic, content-matched scan of the lines that will be
    // WHY: written against the served mirror and its canon digests — never a shape refusal, so a served
    // WHY: prefix with a differing remainder stays accepted. Nothing rewrites `content_lines` between
    // WHY: resolution and the write, so one view suffices; no canon data means no evidence, and the scan
    // WHY: stays silent. A lease-resolved span needs no current-anchor scan: identity lives in the lease
    // WHY: seam, and the served hash echo condition only names served anchors — the evidence-only revision
    // WHY: is the archived 0009 record's.
    // Ref: docs/.archive_adrs/0009-bounded-hash-echo-guard.md
    const digests = canonDigests ?? [];
    const scan = { lines: resolved.content_lines, anchors: served, digests };
    const hit = findServedHashEcho(scan.lines, scan.anchors, scan.digests, 1);
    let servedCopy:
      | { k: number; hash: string; servedLine: number; offendingLine: string }
      | undefined;
    if (hit !== undefined) {
      servedCopy = {
        k: hit.k,
        hash: hit.hash,
        servedLine: hit.servedLine,
        offendingLine: resolved.content_lines[hit.k - 1] ?? "",
      };
    }
    if (servedCopy) {
      if (mode === "literal") {
        literalBypass = true;
        warnings.push(LITERAL_BYPASS_NOTICE);
      } else {
        const anchorFrom = edit.hash_bounds[0].hash;
        const anchorTo = edit.hash_bounds[1].hash;
        const counterPath = absolutePath ?? filePath ?? "(unknown file)";
        // WHY: the tally records on refusal, while the edit is still uncommitted, so a resubmission
        // WHY: still sees it; only a committed write clears it (`pipeline.ts` post-commit, `lifecycle-hooks` post-write).
        const count =
          sessionKey === undefined
            ? 1
            : trackServedEditRefusal(
                sessionKey,
                counterPath,
                anchorFrom,
                anchorTo,
                servedCopy.offendingLine,
              );
        throw new DomainError("E_SUSPICIOUS_TEXT", {
          target: "edit",
          path: filePath ?? "(unknown file)",
          line: servedCopy.k,
          hash: servedCopy.hash,
          servedLine: servedCopy.servedLine,
          count,
        });
      }
    }
    // WHY: no span verification happens here: `resolveLeasedEdit` runs `verifyRebasedSpan` for every
    // WHY: edit it resolves (#151); the library-level mirror self-check had no live caller and is
    // WHY: retired (#10).
  }

  // WHY: (ticket-02 invariant 5, ticket-02b) both splices of a span-ref item derive from the SAME
  // WHY: pre-item buffer (`lineIndex`), so an anchor made ambiguous by one splice can never change
  // WHY: what the other removes.
  const mutationSpans: { startLine: number; endLine: number; inserted: number }[] = [];
  let sourceRange: ResolvedRange | undefined;
  const targetRange = resolvedRange(resolved);
  let result: string;
  if (edit.source && resolvedSource) {
    const s1 = resolvedSource.hash_bounds[0].line;
    const s2 = resolvedSource.hash_bounds[1].line;
    const t1 = resolved.hash_bounds[0].line;
    const t2 = resolved.hash_bounds[1].line;
    if (edit.source.retire) {
      const deletion: RHEdit = { content_lines: [], hash_bounds: resolvedSource.hash_bounds };
      sourceRange = resolvedRange(deletion);
      mutationSpans.push({
        startLine: sourceRange.startLine,
        endLine: sourceRange.endLine,
        inserted: 0,
      });
    }
    // WHY: a target already carrying the copied lines contributes no splice — the retirement alone
    // WHY: produces the bytes, and `resolvedRange` already reports a zero delta for an equal-width
    // WHY: replacement (the ticket-02 `delta: 0` correction was unreachable, dropped, and the branch
    // WHY: is covered by the target-equals-source test).
    const targetSame =
      resolved.placement === undefined &&
      t2 - t1 + 1 === resolved.content_lines.length &&
      lineIndex.fileLines.slice(t1 - 1, t2).every((line, k) => line === resolved.content_lines[k]);
    if (!targetSame) {
      mutationSpans.push({
        startLine: targetRange.startLine,
        endLine: targetRange.endLine,
        inserted: resolved.content_lines.length,
      });
    }
    result = assembleLines(
      content,
      lineIndex.fileLines,
      edit.source.retire ? { s1, s2 } : undefined,
      resolved.placement,
      t1,
      t2,
      resolved.content_lines,
    );
    abortIf(signal);
  } else {
    const spanResult = resToSpan(resolved, content, lineIndex);
    if (spanResult.kind === "noop") {
      return {
        content,
        firstChangedLine: undefined,
        lastChangedLine: undefined,
        range: targetRange,
        ...(warnings.length ? { warnings } : {}),
        ...(literalBypass ? { literalBypass: true as const } : {}),
        noopEdit: {
          loc: spanResult.loc,
          currentContent: spanResult.currentContent,
        },
      };
    }
    result = assemble(content, spanResult, signal);
  }
  assertNotEmpty(content, result);

  // WHY: (ticket-02 invariant 10, ticket-02b P1-A) a degenerate move — an insertion point touching
  // WHY: its own retired span — computes to byte identity on the line list, so it rides the noop
  // WHY: path: no write, no double-apply, one honest `noopEdit`.
  if (edit.source && result === content) {
    return {
      content,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      range: { ...targetRange, delta: 0 },
      ...(warnings.length ? { warnings } : {}),
      ...(literalBypass ? { literalBypass: true as const } : {}),
      noopEdit: {
        loc: resolved.hash_bounds[0].hash,
        currentContent: resolved.content_lines.join("\n"),
      },
    };
  }
  const mutationStats = edit.source
    ? {
        addedLines: mutationSpans.reduce((n, span) => n + span.inserted, 0),
        removedLines: mutationSpans.reduce((n, span) => n + (span.endLine - span.startLine + 1), 0),
      }
    : undefined;
  const changed = changedRange(content, result);

  // WHY: middle tier beside the gate above: a written line opening with a served anchor whose
  // WHY: remainder canon digest matches none the leases recorded for that anchor's served line earns
  // WHY: a note per line, never a block — the bytes stay as assembled, and the note only informs the
  // WHY: model channel via the warnings seam (rendered by warnBlock).
  // WHY: soft-hint tier beside it: an anchor-shaped prefix never served for this session and file
  // WHY: counts (`neverServedCount`, aggregated by the batch path into one counted hint per call that
  // WHY: states the offending-line total and the row shape, never a remedy) regardless of the literal
  // WHY: declaration, which covers served rows only. Neither tier rewrites, blocks or keeps state, and
  // WHY: the count never travels as a warning string.
  let neverServedCount = 0;
  // WHY: (spec D6) the never-served scan is shape-only and pure, so it runs against an empty served
  // WHY: set when the tracker is missing — the hint must not depend on lease state; the prefix-mismatch
  // WHY: tier above stays evidence-gated (`if (served)`) and reports nothing by construction.
  if (served) {
    const digests = canonDigests ?? [];
    const mismatches = findServedPrefixMismatches(resolved.content_lines, served, digests, 1);
    for (const mismatch of mismatches) {
      warnings.push(
        buildServedEditPrefixNote({
          k: mismatch.k,
          anchor: mismatch.anchor,
          servedLine: mismatch.servedLine,
        }),
      );
    }
  }
  const neverServed = findNeverServedAnchorShapes(resolved.content_lines, served ?? [], 1);
  if (neverServed.length > 0) {
    neverServedCount = neverServed.length;
  }

  return {
    content: result,
    firstChangedLine: changed?.firstChangedLine,
    lastChangedLine: changed?.lastChangedLine,
    range: targetRange,
    ...(warnings.length ? { warnings } : {}),
    ...(literalBypass ? { literalBypass: true as const } : {}),
    ...(neverServedCount > 0 ? { neverServedCount } : {}),
    ...(sourceRange ? { sourceRange } : {}),
    ...(edit.source ? { mutationSpans } : {}),
    ...(mutationStats ? { mutationStats } : {}),
  };
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
  const [start, end] = resolved.hash_bounds;
  if (resolved.placement === "before" || resolved.placement === "after") {
    // WHY: an insertion is zero-width: `before` targets the line below the point, `after` the line
    // WHY: above. The empty-range form (startLine = point + 1, endLine = point) is what lets identity
    // WHY: bookkeeping keep every existing line — a width-1 range would drop the target's `line_id`.
    const targetLine = resolved.placement === "before" ? start.line : end.line;
    const pointLine = resolved.placement === "before" ? targetLine - 1 : targetLine;
    return {
      startLine: pointLine + 1,
      endLine: pointLine,
      startHash: start.hash,
      endHash: end.hash,
      delta: resolved.content_lines.length,
    };
  }
  return {
    startLine: start.line,
    endLine: end.line,
    startHash: start.hash,
    endHash: end.hash,
    delta: resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
  };
}

export function fmtRegion(hashes: readonly string[], lines: readonly string[]): string {
  if (hashes.length !== lines.length) {
    throw new Error(
      `fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
    );
  }
  return lines.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`).join("\n");
}

export function changedRange(
  original: string,
  result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
  if (original === result) return null;

  if (original.length === 0) {
    return {
      firstChangedLine: 1,
      lastChangedLine: splitLines(result).length,
    };
  }

  const originalLines = splitLines(original);
  const resultLines = splitLines(result);

  if (
    originalLines.length === resultLines.length &&
    originalLines.every((line, index) => line === resultLines[index])
  ) {
    return null;
  }

  const minLen = Math.min(originalLines.length, resultLines.length);
  let first = 0;
  while (first < minLen && originalLines[first] === resultLines[first]) {
    first++;
  }
  let lastOrig = originalLines.length - 1;
  let lastRes = resultLines.length - 1;
  while (
    lastOrig >= first &&
    lastRes >= first &&
    originalLines[lastOrig] === resultLines[lastRes]
  ) {
    lastOrig--;
    lastRes--;
  }
  return {
    firstChangedLine: first + 1,
    lastChangedLine: Math.max(first, lastRes) + 1,
  };
}
