import { abortIf, splitLines } from "../utils.js";
import { HASH_SEP, defaultHashIdentity } from "./hash-identity.js";
import { AnchorMismatchError, verifyServedRange, type ResolvedRange } from "./served.js";
import {
  findServedHashEcho,
  findServedPrefixMismatches,
  ServedHashEchoError,
  buildServedEditMessage,
  buildServedEditPrefixNote,
  trackServedEditRefusal,
  LITERAL_BYPASS_NOTICE,
} from "./served-guard.js";
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

/** SAFETY: served hash echo predicate lives in `./served-guard.js` — one evidence predicate for the edit apply path and the write hook. */
export { findServedHashEcho, ServedHashEchoError } from "./served-guard.js";

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
  tombstone?: ReadonlySet<string>;
  servedCanons?: (string | null)[];
  identity?: LeaseSpanSource;
  mode?: "general" | "literal";
}

/**
 * WHY: the served hash echo gate is evidence-only (CONTEXT.md served hash echo,
 * WHY: ADR-0009 revision, `[E_SERVED_ECHO]`): one position-agnostic,
 * WHY: content-matched scan over the replacement views via the unified
 * WHY: `findServedHashEcho` — never a shape check, so a served prefix with
 * WHY: differing content stays accepted.
 */
function assertNotEmpty(originalContent: string, result: string): void {
  if (originalContent.length > 0 && result.length === 0) {
    throw new Error(
      "[MODEL] [E_EMPTY_RANGE] Cannot empty a non-empty file via edit. Use `write` if you need to clear the file.",
    );
  }
}

function resToSpan(edit: RHEdit, content: string, lineIndex: LIdx): RESpan | NoopSpan {
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

function assemble(content: string, span: RESpan, signal: AbortSignal | undefined): string {
  abortIf(signal);
  return content.slice(0, span.start) + span.replacement + content.slice(span.end);
}

function prepareEdit(fileHashes: string[], edit: HEdit, warnings: string[]): { fixed: HEdit } {
  return { fixed: swapReversedRanges(edit, fileHashes, warnings) };
}

/**
 * Anchor resolution seam: lease-first (MVCC, spec §3.1.1) for every edit the session has a lease
 * source for — `served_leases` is looked up before anything else, so an anchor with no lease is
 * `[E_STALE_ANCHOR]` and never re-anchored onto colliding content. The lease path is read-only on
 * `served_leases`; `rebased` marks the returned coordinates as current-content coordinates, which
 * means the served-mirror verification is replaced by the rebased-span gate.
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
  rebased: boolean;
  /** First row of the served window when `rebased`; `undefined` on the fast/content paths. */
  servedStart: number | undefined;
} {
  if (served && identity) {
    const leased = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes, fileLines, filePath },
      served,
      source: identity,
    });
    return {
      resolved: leased.resolved,
      mismatches: [],
      rebased: leased.status === "rebased",
      servedStart: leased.status === "rebased" ? leased.servedStart : undefined,
    };
  }
  // WHY: no seam at all (no mirror, no lease source): the library-level `applyEdit` seam, where
  // WHY: anchor algebra is the only authority. A session edit always carries both, so it can never
  // WHY: reach this branch — lost identity fails closed in the lease seam above.
  return {
    ...resolveEditByContent(edit, { fileHashes, fileLines, filePath }, signal),
    rebased: false,
    servedStart: undefined,
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
} {
  abortIf(signal);

  const {
    filePath,
    absolutePath,
    served,
    tombstone,
    servedCanons,
    identity,
    mode = "general",
  } = verification ?? {};

  const lineIndex = buildIdx(content);
  const fileHashes = precomputedHashes ?? defaultHashIdentity.hashesForSync(content);
  const warnings: string[] = [];
  const rawReplacementLines = [...edit.content_lines];
  let literalBypass = false;

  const prefixFixed = prepareEdit(fileHashes, edit, warnings).fixed;

  const {
    resolved,
    mismatches,
    rebased: leaseRebased,
  } = resolveEdit(prefixFixed, lineIndex.fileLines, fileHashes, filePath, served, identity, signal);
  if (mismatches.length || !resolved) {
    const { message, servedRows } = fmtMismatchWithServes(mismatches, {
      fileHashes,
      fileLines: lineIndex.fileLines,
      filePath,
    });
    throw new AnchorMismatchError(message, servedRows);
  }

  warnUnicodeEsc(prefixFixed, warnings);

  if (served) {
    // WHY: evidence-only gate (ADR-0009 revision): each replacement view is scanned
    // WHY: position-agnostic against the served mirror with its canon mirror. No canon
    // WHY: data means no evidence, so the scan stays silent — never a shape refusal.
    // WHY: `leaseRebased` needs no separate current-anchor scan: identity lives in the
    // WHY: lease seam, and the served hash echo condition only names served anchors.
    const canons = servedCanons ?? [];
    const views: Array<{ lines: string[]; offending: string[] }> = [
      { lines: rawReplacementLines, offending: rawReplacementLines },
      { lines: resolved.content_lines, offending: resolved.content_lines },
      { lines: prefixFixed.content_lines, offending: prefixFixed.content_lines },
    ];
    let servedCopy:
      | { k: number; hash: string; servedLine: number; offendingLine: string }
      | undefined;
    for (const view of views) {
      const hit = findServedHashEcho(view.lines, served, canons, 1);
      if (hit !== undefined) {
        servedCopy = {
          k: hit.k,
          hash: hit.hash,
          servedLine: hit.servedLine,
          offendingLine: view.offending[hit.k - 1] ?? "",
        };
        break;
      }
    }
    if (servedCopy) {
      if (mode === "literal") {
        literalBypass = true;
        warnings.push(LITERAL_BYPASS_NOTICE);
      } else {
        const anchorFrom = edit.hash_bounds[0].hash;
        const anchorTo = edit.hash_bounds[1].hash;
        const counterPath = absolutePath ?? filePath ?? "(unknown file)";
        const count = trackServedEditRefusal(
          counterPath,
          anchorFrom,
          anchorTo,
          servedCopy.offendingLine,
        );
        const msg = buildServedEditMessage({
          path: filePath ?? "(unknown file)",
          k: servedCopy.k,
          hash: servedCopy.hash,
          servedLine: servedCopy.servedLine,
          count,
        });
        throw new ServedHashEchoError(msg, []);
      }
    }
    if (!leaseRebased) {
      const startAnchor = resolved.hash_bounds[0];
      const endAnchor = resolved.hash_bounds[1];
      verifyServedRange({
        served,
        startHash: startAnchor.hash,
        endHash: endAnchor.hash,
        startLine: startAnchor.line,
        endLine: endAnchor.line,
        fileHashes,
        fileLines: lineIndex.fileLines,
        filePath,
        tombstone,
        servedCanons,
      });
    }
  }

  const spanResult = resToSpan(resolved, content, lineIndex);
  if (spanResult.kind === "noop") {
    return {
      content,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      range: resolvedRange(resolved),
      ...(warnings.length ? { warnings } : {}),
      ...(literalBypass ? { literalBypass: true as const } : {}),
      noopEdit: {
        loc: spanResult.loc,
        currentContent: spanResult.currentContent,
      },
    };
  }

  const result = assemble(content, spanResult, signal);
  assertNotEmpty(content, result);
  const changed = changedRange(content, result);

  // WHY: middle tier beside the gate above: a replacement line opening with a
  // WHY: served anchor whose remainder canon matches none of the canons served
  // WHY: for that anchor. The bytes are already assembled as-is; the note only
  // WHY: informs the model channel via the warnings seam (rendered by warnBlock),
  // WHY: never alters bytes, never blocks, keeps no state, fires per line.
  if (served) {
    const canons = servedCanons ?? [];
    const mismatches = findServedPrefixMismatches(resolved.content_lines, served, canons, 1);
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

  return {
    content: result,
    firstChangedLine: changed?.firstChangedLine,
    lastChangedLine: changed?.lastChangedLine,
    range: resolvedRange(resolved),
    ...(warnings.length ? { warnings } : {}),
    ...(literalBypass ? { literalBypass: true as const } : {}),
  };
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
  const [start, end] = resolved.hash_bounds;
  return {
    startLine: start.line,
    endLine: end.line,
    startHash: start.hash,
    endHash: end.hash,
    delta: resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
  };
}

export function fmtRegion(hashes: string[], lines: string[]): string {
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
