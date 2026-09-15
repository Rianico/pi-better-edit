import { abortIf, splitLines } from "../utils.js";
import { HASH_SEP, defaultHashIdentity } from "./hash-identity.js";
import {
  AnchorMismatchError,
  verifyServedRange,
  type ResolvedRange,
  type ServedRow,
} from "./served.js";
import {
  resolveEditByContent,
  stripBarePrefixes,
  stripDiffPrefixes,
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

export function findEditHashEcho(
  replacementLines: string[],
  served: readonly (string | null)[],
  startLine: number,
): { k: number; hash: string } | undefined {
  for (let k = 0; k < replacementLines.length; k++) {
    const pos = startLine + k - 1;
    if (
      pos < served.length &&
      served[pos] !== null &&
      replacementLines[k]!.startsWith(served[pos]! + HASH_SEP)
    ) {
      return { k: k + 1, hash: served[pos]! };
    }
  }
  return undefined;
}

export class EditHashEchoError extends AnchorMismatchError {
  constructor(message: string, servedRows: ServedRow[] = []) {
    super(message, servedRows);
    this.name = "EditHashEchoError";
  }
}

/**
 * The verification cluster that travels with an edit from the session pipeline
 * (issue #115): the file identity, the served mirror, and the read-only lease
 * source. One descriptor instead of positional booleans/arrays, so an
 * argument-order slip cannot silently rewire verification.
 */
export interface ApplyVerificationContext {
  filePath?: string;
  served?: (string | null)[];
  tombstone?: ReadonlySet<string>;
  servedCanons?: (string | null)[];
  identity?: LeaseSpanSource;
}

type ServedAnchorScanEntry = {
  lines: string[];
  anchors: readonly (string | null)[];
  start: number;
};

/**
 * One implementation of the candidate × target scan for the served hash echo
 * condition (CONTEXT.md served hash echo, ADR-0009): walks the ordered
 * (candidate lines × anchor target) entries with early exit, delegating each
 * step to the line-relative `findEditHashEcho` — never a free-floating scan
 * for either boundary anchor, so legitimate content repeating an anchor's
 * three characters at a non-corresponding line stays accepted.
 */
function findFirstServedAnchorCopy(
  entries: readonly ServedAnchorScanEntry[],
): { k: number; hash: string } | undefined {
  for (const entry of entries) {
    const hit = findEditHashEcho(entry.lines, entry.anchors, entry.start);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
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
  const rangeFixed = swapReversedRanges(edit, fileHashes, warnings);
  const prefixFixed = stripDiffPrefixes(
    stripBarePrefixes(rangeFixed, fileHashes, warnings),
    warnings,
  );
  return { fixed: prefixFixed };
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
} {
  abortIf(signal);

  const { filePath, served, tombstone, servedCanons, identity } = verification ?? {};

  const lineIndex = buildIdx(content);
  const fileHashes = precomputedHashes ?? defaultHashIdentity.hashesForSync(content);
  const warnings: string[] = [];
  const rawReplacementLines = [...edit.content_lines];

  let prefixFixed: typeof edit = edit;
  try {
    const res = prepareEdit(fileHashes, edit, warnings);
    prefixFixed = res.fixed;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("[E_BAD_ANCHOR]") && served) {
      let hasServedCopy = false;
      for (const line of rawReplacementLines) {
        const m = line.match(/^([A-Za-z0-9]{3})│/);
        if (m && served.includes(m[1]!)) {
          hasServedCopy = true;
          break;
        }
      }
      if (hasServedCopy) {
        prefixFixed = edit;
        warnings.length = 0;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const {
    resolved,
    mismatches,
    rebased: leaseRebased,
    servedStart,
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
    const startLine = resolved.hash_bounds[0].line;
    // WHY: the served mirror is indexed by SERVED rows, so the range-relative check anchors on the
    // WHY: served window. On a rebased span `startLine` is the REBASED coordinate and would compare
    // WHY: replacement line `k` against the anchor served for a different line
    // WHY: (CONTEXT.md served hash echo, ADR-0009).
    const mirrorStart = leaseRebased && servedStart !== undefined ? servedStart : startLine;
    // WHY: ordered candidate × target entries for the single scan below: the three
    // WHY: replacement views against the served mirror at the served window, then — only
    // WHY: under a rebase — the raw and prefix-fixed views against the current anchors
    // WHY: at the rebased coordinate. Each step stays line-relative (`findEditHashEcho`);
    // WHY: never a free-floating scan for either boundary anchor.
    const scanEntries: ServedAnchorScanEntry[] = [
      { lines: rawReplacementLines, anchors: served, start: mirrorStart },
      { lines: resolved.content_lines, anchors: served, start: mirrorStart },
      { lines: prefixFixed.content_lines, anchors: served, start: mirrorStart },
    ];
    if (leaseRebased && servedStart !== undefined) {
      // WHY: under a rebase the replacement line may also carry an anchor the current coordinates
      // WHY: hold for the line it replaces, so the current anchors are checked range-relative too.
      const startPos = resolved.hash_bounds[0].line;
      scanEntries.push(
        { lines: rawReplacementLines, anchors: fileHashes, start: startPos },
        { lines: prefixFixed.content_lines, anchors: fileHashes, start: startPos },
      );
    }
    const servedCopy = findFirstServedAnchorCopy(scanEntries);
    if (servedCopy) {
      const msg = `[MODEL] [E_SERVED_ECHO] Refused edit to ${filePath ?? "(unknown file)"}: replacement line ${servedCopy.k} begins with the exact ${servedCopy.hash}${HASH_SEP} anchor served for this session, path, and range-relative line. Remove the copied anchors and retry. Nothing was written.`;
      throw new EditHashEchoError(msg, []);
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
      noopEdit: {
        loc: spanResult.loc,
        currentContent: spanResult.currentContent,
      },
    };
  }

  const result = assemble(content, spanResult, signal);
  assertNotEmpty(content, result);
  const changed = changedRange(content, result);

  return {
    content: result,
    firstChangedLine: changed?.firstChangedLine,
    lastChangedLine: changed?.lastChangedLine,
    range: resolvedRange(resolved),
    ...(warnings.length ? { warnings } : {}),
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
