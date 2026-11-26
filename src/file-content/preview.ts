import {
  formatSize,
  truncateHead,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { MAX_READ_WINDOWS, MAX_READ_WINDOWS_MESSAGE } from "../constants.js";
import { DomainError } from "../domain-errors.js";
import {
  canonDigest,
  contentOnlyHashes,
  lineHashes,
  HASH_SEP,
  type AnchorWalk,
} from "../hashline/hash-identity.js";
import { fmtRegion } from "../hashline/apply.js";
import { loadHashStore } from "../hash-store.js";
import { snapshotIOFor } from "../snapshot-store";
import type { ServedRow } from "../served-session/serve-render.js";
import { formatSectionHeader } from "./served-header.js";
import { mergeRanges, visibleLineTotal, walkLines, type LineRange } from "./line-walker.js";

function normPosInt(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request field "${name}" must be a positive integer.`,
    });
  }
  return value;
}

/** The lines one page actually rendered, 1-based and inclusive. */
export interface ShownRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** One requested line range of a multi-window read. */
export interface ReadWindow {
  offset: number;
  limit: number;
}

function normReqInt(value: unknown, name: string): number {
  const normalized = normPosInt(value as number | undefined, name);
  if (normalized === undefined) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request field "${name}" must be a positive integer.`,
    });
  }
  return normalized;
}

/**
 * Validates a `windows` request. `undefined` and `[]` both mean "no windows": the caller falls back
 * to the single-window `offset`/`limit` contract, so an empty array stays backward compatible.
 */
function normWindows(windows: ReadWindow[] | undefined, derived = false): ReadWindow[] | undefined {
  if (windows === undefined || windows.length === 0) return undefined;
  if (!derived && windows.length > MAX_READ_WINDOWS) {
    throw new DomainError("E_BAD_PAYLOAD", { message: MAX_READ_WINDOWS_MESSAGE });
  }
  return windows.map((window, index) => {
    if (window === null || typeof window !== "object") {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Read request field "windows[${index}]" must be an object with offset and limit.`,
      });
    }
    return {
      offset: normReqInt(window.offset, `windows[${index}].offset`),
      limit: normReqInt(window.limit, `windows[${index}].limit`),
    };
  });
}

function fmtRows(hashes: readonly string[], lines: readonly string[], verbatim: boolean): string {
  if (!verbatim) return fmtRegion(hashes, lines);
  const joined = lines.join("\n");
  return joined === "" && lines.length > 0 ? "[1 empty line]" : joined;
}

function emptyFilePreview(
  startLine: number,
  hashes: string[],
  hashSep: string,
  verbatim: boolean,
): { text: string; served: ServedRow[] } {
  if (verbatim) return { text: "[File is empty.]", served: [] };
  if (startLine === 1) {
    const emptyLineHash = hashes[0];
    if (emptyLineHash === undefined) {
      throw new Error("empty file preview is missing its walk anchor");
    }
    return {
      text: `${emptyLineHash}${hashSep}\n[File is empty. Use edit to insert content.]`,
      served: [{ position: 0, hash: emptyLineHash }],
    };
  }
  return {
    text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use edit to insert content.`,
    served: [],
  };
}

function oversizedLineFacts(oversized: { lineNumber: number }[]): {
  lineLabel: string;
  verb: string;
  pronoun: "it" | "them";
} {
  const [firstOversized] = oversized;
  const lineLabel =
    oversized.length === 1 && firstOversized !== undefined
      ? `Line ${firstOversized.lineNumber}`
      : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const pronoun = oversized.length === 1 ? "it" : "them";
  return { lineLabel, verb, pronoun };
}

/** The placeholder a row too long for the intrinsic cap renders as, in place of its content. */
function oversizedRowPlaceholder(row: { lineNumber: number; bytes: number }): string {
  return `[Line ${row.lineNumber}: ${formatSize(row.bytes)}; not shown.]`;
}

function buildOversizedPreview(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: readonly string[];
  startLine: number;
  totalLines: number;
  /** The intrinsic per-line cap: a row longer than this is never rendered. */
  maxLineBytes: number;
  /** The response budget left for this page's rows: truncation stops here. */
  remainingBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
  /** Cite only the oversized rows the shown prefix reached (multi-window sections). */
  listedWithinShownPrefix?: boolean;
}): {
  text: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  served: ServedRow[];
  shownRange?: ShownRange;
} {
  const {
    rowSizes,
    selected,
    selectedHashes,
    startLine,
    totalLines,
    maxLineBytes,
    remainingBytes,
    maxTruncLines,
    verbatim,
    listedWithinShownPrefix,
  } = params;
  const oversized = rowSizes.filter((row) => row.bytes > maxLineBytes);
  const rows = rowSizes.map((row, index) => {
    if (row.bytes > maxLineBytes) {
      return oversizedRowPlaceholder(row);
    }
    const line = selected[index];
    if (line === undefined) {
      throw new Error(`preview row ${index} has no selected line`);
    }
    if (verbatim) return line;
    const hash = selectedHashes[index];
    if (hash === undefined) {
      throw new Error(`preview row ${index} has no anchor`);
    }
    return fmtRows([hash], [line], false);
  });
  const skippedTruncation = truncateHead(rows.join("\n"), {
    maxBytes: remainingBytes,
    maxLines: maxTruncLines,
  });
  const shownRowCount =
    skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const listed =
    listedWithinShownPrefix === true && shownRowCount > 0
      ? oversized.filter((row) => row.lineNumber < startLine + shownRowCount)
      : oversized;
  const { lineLabel, verb, pronoun } = oversizedLineFacts(listed);
  const warning =
    listed.length === 0
      ? undefined
      : `[${lineLabel} ${verb} the ${formatSize(maxLineBytes)} limit; the read tool cannot show ${pronoun}.]`;
  // Ref: docs/spec/search-and-read-evolution.md
  const preview =
    warning === undefined
      ? skippedTruncation.content
      : `${skippedTruncation.content}\n\n${warning}`;
  const nextOffset =
    shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)
      ? lastShownLine + 1
      : undefined;
  const served: ServedRow[] = [];
  if (!verbatim)
    for (let index = 0; index < shownRowCount; index++) {
      const row = rowSizes[index];
      const hash = selectedHashes[index];
      if (row === undefined || hash === undefined) {
        throw new Error(`preview served row ${index} is missing`);
      }
      if (row.bytes <= maxLineBytes) served.push({ position: startLine - 1 + index, hash });
    }
  return {
    text: preview,
    ...(skippedTruncation.truncated ? { truncation: skippedTruncation } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(shownRowCount > 0 ? { shownRange: { startLine, endLine: lastShownLine } } : {}),
    served,
  };
}

function buildNormalPreview(params: {
  formatted: string;
  startLine: number;
  endIdx: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  selectedHashes: readonly string[];
  verbatim: boolean;
}): {
  preview: string;
  nextOffset?: number;
  truncation: ReturnType<typeof truncateHead>;
  served: ServedRow[];
  shownRange?: ShownRange;
} {
  const {
    formatted,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
    verbatim,
  } = params;
  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });
  const nextOffset = truncation.truncated
    ? startLine + truncation.outputLines
    : endIdx < totalLines
      ? endIdx + 1
      : undefined;
  const served: ServedRow[] = [];
  if (!verbatim)
    for (const [index, hash] of selectedHashes.entries()) {
      if (index >= truncation.outputLines) break;
      served.push({ position: startLine - 1 + index, hash });
    }
  return {
    preview: truncation.content,
    truncation,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(truncation.outputLines > 0
      ? { shownRange: { startLine, endLine: startLine + truncation.outputLines - 1 } }
      : {}),
    served,
  };
}

/**
 * Renders one window through the same oversized/truncation pipeline a single-window read uses, except
 * that the intrinsic per-line cap (`maxLineBytes`) and the shared response budget (`remainingBytes`)
 * stay separate: a recoverable row that misses the budget truncates or omits the window instead of
 * being mistaken for an oversized line.
 */
function buildWindowSection(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: readonly string[];
  startLine: number;
  endIdx: number;
  totalLines: number;
  /** The full single-read line cap, so a window classifies oversized lines like a lone read. */
  maxLineBytes: number;
  /** The response budget left for this window's rows. */
  remainingBytes: number;
  /** The line budget left for this window's rows. */
  remainingLines: number;
  verbatim: boolean;
}): {
  text: string;
  truncation?: TruncationResult;
  served: ServedRow[];
  shownRange?: ShownRange;
  /** The window fit no row in the remaining budget: its section is the notice alone. */
  budgetOmitted?: boolean;
} {
  const {
    rowSizes,
    selected,
    selectedHashes,
    startLine,
    endIdx,
    totalLines,
    maxLineBytes,
    remainingBytes,
    remainingLines,
    verbatim,
  } = params;
  const [firstRow] = rowSizes;
  if (firstRow !== undefined && firstRow.bytes <= maxLineBytes && firstRow.bytes > remainingBytes) {
    return {
      text: `[Window does not fit in the remaining ${formatSize(remainingBytes)} read budget; not shown. Re-read it on its own.]`,
      truncation: truncateHead(fmtRows(selectedHashes, selected, verbatim), {
        maxBytes: remainingBytes,
        maxLines: remainingLines,
      }),
      served: [],
      budgetOmitted: true,
    };
  }
  if (rowSizes.some((row) => row.bytes > maxLineBytes)) {
    return buildOversizedPreview({
      rowSizes,
      selected,
      selectedHashes,
      startLine,
      totalLines,
      maxLineBytes,
      remainingBytes,
      maxTruncLines: remainingLines,
      verbatim,
      listedWithinShownPrefix: true,
    });
  }
  const normal = buildNormalPreview({
    formatted: fmtRows(selectedHashes, selected, verbatim),
    startLine,
    endIdx,
    totalLines,
    maxBytes: remainingBytes,
    maxTruncLines: remainingLines,
    selectedHashes,
    verbatim,
  });
  return {
    text: normal.preview,
    ...(normal.truncation.truncated ? { truncation: normal.truncation } : {}),
    ...(normal.shownRange !== undefined ? { shownRange: normal.shownRange } : {}),
    served: normal.served,
  };
}

/**
 * Multi-window read (one tool result, several disjoint ranges). Sections render in the caller's
 * order — the order is part of the request, so it is never sorted — while every window draws on ONE
 * shared byte/line budget so N windows cannot multiply the auto-read budget by N. Rows are served
 * only for the lines actually shown, and overlapping windows collapse to one served row per line.
 */
/**
 * A page the read walked out of the text: the lines the request asked for, and the counts.
 */
interface WalkedPage {
  /** The lines of each requested range, in request order. */
  readonly ranges: string[][];
  /** The anchors the walk assigned, in line order. Present only when the walk carried one. */
  readonly assigned?: string[];
}
/**
 * The lines of one requested window, re-sliced out of the merged walk that retained the union.
 */
function sliceMergedRanges(
  merged: readonly LineRange[],
  pieces: readonly string[][],
  start: number,
  end: number,
): string[] {
  const lines: string[] = [];
  for (const [index, piece] of merged.entries()) {
    if (piece.end <= start) continue;
    if (piece.start >= end) break;
    const from = Math.max(start, piece.start) - piece.start;
    const to = Math.min(end, piece.end) - piece.start;
    const pieceLines = pieces[index];
    if (pieceLines === undefined) {
      throw new Error(`preview merge piece ${index} has no lines`);
    }
    lines.push(...pieceLines.slice(from, to));
  }
  return lines;
}

/**
 * The one page primitive: walks the requested ranges once, optionally assigning an anchor per line.
 */
function walkPage(
  text: string,
  ranges: readonly LineRange[],
  assign?: (line: string) => string,
): WalkedPage {
  const assigned: string[] = [];
  const walk = walkLines(
    text,
    ranges,
    assign ? (line: string) => void assigned.push(assign(line)) : undefined,
  );
  return {
    ranges: walk.ranges,
    ...(assign ? { assigned } : {}),
  };
}

function buildWindowedPreview(params: {
  windows: ReadWindow[];
  /** Finished clauses aligned with `windows`; the note seam owns them. */
  noteClauses?: readonly (string | undefined)[];
  /** The lines the walk retained, one array per window in request order. */
  ranges: string[][];
  totalLines: number;
  allHashes: string[];
  /** Per-window page-aligned anchors when the source resolved pages, not the file. */
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  rangedHashes?: readonly (readonly string[])[];
  /** The full single-read line cap, shared with every section's intrinsic oversized check. */
  maxLineBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
}): {
  text: string;
  truncation?: TruncationResult;
  served: ServedRow[];
  shownRange?: ShownRange;
} {
  const {
    windows,
    noteClauses,
    ranges,
    totalLines,
    allHashes,
    rangedHashes,
    maxLineBytes,
    maxTruncLines,
    verbatim,
  } = params;
  const sections: string[] = [];
  const hashByPosition = new Map<number, string>();
  let truncation: TruncationResult | undefined;
  let shownRange: ShownRange | undefined;
  let remainingBytes = maxLineBytes;
  let remainingLines = maxTruncLines;

  for (const [index, window] of windows.entries()) {
    if (window.offset > totalLines) {
      sections.push(
        `Offset ${window.offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      );
      continue;
    }
    const endIdx = Math.min(window.offset - 1 + window.limit, totalLines);
    const selected = ranges[index] ?? [];
    const selectedHashes = rangedHashes?.[index] ?? allHashes.slice(window.offset - 1, endIdx);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      sections.push(
        `${formatSectionHeader(window.offset, endIdx, totalLines, undefined, noteClauses?.[index])}\n[Read budget exhausted; this window is not shown. Re-read it on its own.]`,
      );
      const skipped = truncateHead(fmtRows(selectedHashes, selected, verbatim), {
        maxBytes: Math.max(0, remainingBytes),
        maxLines: Math.max(0, remainingLines),
      });
      if (truncation === undefined && skipped.truncated) truncation = skipped;
      continue;
    }
    const rowSizes = selected.map((line, index) => ({
      lineNumber: window.offset + index,
      bytes: Buffer.byteLength(
        verbatim ? line : `${selectedHashes[index]}${HASH_SEP}${line}`,
        "utf-8",
      ),
    }));
    const built = buildWindowSection({
      rowSizes,
      selected,
      selectedHashes,
      startLine: window.offset,
      endIdx,
      totalLines,
      maxLineBytes,
      remainingBytes,
      remainingLines,
      verbatim,
    });
    const stoppedAtBytes =
      built.budgetOmitted === true || built.truncation?.truncatedBy !== "bytes"
        ? undefined
        : built.truncation.maxBytes;
    const block =
      windows.length === 1
        ? built.text
        : `${formatSectionHeader(
            built.shownRange?.startLine ?? window.offset,
            built.shownRange?.endLine ?? endIdx,
            totalLines,
            stoppedAtBytes,
            noteClauses?.[index],
          )}\n${built.text}`;
    sections.push(block);
    shownRange = built.shownRange;
    for (const row of built.served) hashByPosition.set(row.position, row.hash);
    remainingLines -= built.text === "" ? 0 : built.text.split("\n").length;
    remainingBytes -= Buffer.byteLength(block, "utf-8");
    if (truncation === undefined && built.truncation) truncation = built.truncation;
  }

  return {
    text: sections.join("\n\n"),
    ...(truncation ? { truncation } : {}),
    ...(windows.length === 1 && shownRange !== undefined ? { shownRange } : {}),
    served: [...hashByPosition.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([position, hash]) => ({ position, hash })),
  };
}

/**
 * The anchors a preview renders with:
 *
 * - an array: anchors this caller already holds;
 * - a walk plan: the served read's assignment, which the same walk that selects the page runs — see
 *   `HashIdentity.anchorsForWalk`;
 * - a ranged source: anchors of an ALREADY-COMMITTED snapshot, resolved for exactly the ranges the
 *   page keeps — the stat-identity fast path never materializes the whole file's identity;
 * - `undefined`: none known yet, so served reaches for its own lazy call and verbatim never does.
 */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
export type RenderAnchors = string[] | AnchorWalk | RangedAnchorSource;

/** One committed line as the page read sees it: the anchor to serve and the canon it was based on. */
interface RangedAnchorLine {
  anchor: string;
  canonHash: string;
}

/**
 * A committed snapshot's line identity, read a page at a time.
 *
 * `anchorCount` is the line count the snapshot committed; a preview whose own walk disagrees with it
 * is not describing the same file, and refuses the source.
 */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
interface RangedAnchorSource {
  readonly anchorCount: number;
  /** Lines `[start, end)` (0-based, half-open), exactly `end - start` of them, in line order. */
  range(start: number, end: number): Promise<readonly RangedAnchorLine[]>;
}

/**
 * A stat-matched snapshot could not describe the bytes being served: its line count, a
 * missing lineage row, or a line's canon digest disagreed with the file. The caller re-derives the
 * file's identity through the content-hash path — the served page is never rendered from a source it
 * could not prove.
 */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
export class StatIdentityMismatchError extends Error {}
/** Whether the caller handed anchors rather than a walk plan (readonly arrays do not narrow on their own). */
function isAnchorArray(anchors: RenderAnchors): anchors is string[] {
  return Array.isArray(anchors);
}

/** Whether the anchors come a page at a time from a committed snapshot. */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
function isRangedSource(anchors: RenderAnchors): anchors is RangedAnchorSource {
  return !Array.isArray(anchors) && "range" in anchors;
}
/**
 * Resolves a stat-matched page, verifying every line before its anchor is served.
 *
 * The snapshot's own `canon_hash` is the evidence: an anchor is only served for a line whose current
 * canon still digests to it, so a stat identity that lied (a same-size rewrite on a filesystem with
 * coarse timestamps, a replaced-but-identical path) costs a fallback, never a stale anchor. Any
 * disagreement — a missing lineage row, a short range, a foreign canon — surfaces as
 * `StatIdentityMismatchError`, which the caller answers by re-deriving identity from content.
 */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
async function rangedPageHashes(
  source: RangedAnchorSource,
  ranges: readonly LineRange[],
  kept: readonly (readonly string[])[],
  text: string,
): Promise<string[]> {
  const wanted: readonly LineRange[] =
    ranges.length === 0 && text === "" ? [{ start: 0, end: 1 }] : ranges;
  const hashes: string[] = [];
  for (const [index, range] of wanted.entries()) {
    const lines = kept[index] ?? (text === "" ? [""] : []);
    let resolved: readonly RangedAnchorLine[];
    try {
      resolved = await source.range(range.start, range.end);
    } catch (error) {
      throw new StatIdentityMismatchError(
        `stat-matched snapshot cannot serve lines ${range.start + 1}-${range.end}: ${String(error)}`,
      );
    }
    if (resolved.length !== lines.length) {
      throw new StatIdentityMismatchError(
        `stat-matched snapshot returned ${resolved.length} anchors for ${lines.length} kept lines.`,
      );
    }
    for (const [offset, line] of lines.entries()) {
      const committed = resolved[offset];
      if (committed === undefined || canonDigest(line) !== committed.canonHash) {
        throw new StatIdentityMismatchError(
          `stat-matched snapshot line ${range.start + offset + 1} no longer matches the file.`,
        );
      }
      hashes.push(committed.anchor);
    }
  }
  return hashes;
}

export async function fmtReadPreview(
  text: string,
  options: {
    offset?: number;
    limit?: number;
    windows?: ReadWindow[];
    noteClauses?: readonly (string | undefined)[];
    render?: "served" | "verbatim";
    derivedWindows?: boolean;
  },
  anchors?: RenderAnchors,
  path?: string,
  maxLineBytes = DEFAULT_MAX_BYTES,
  maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  served: ServedRow[];
  /** The anchors this page rendered with, in line order — the served read's line identity. */
  hashes: string[];
  /** The walk's counts, so no caller splits the text again to learn them. */
  lineTotals: { visible: number; split: number };
  /** The lines this page rendered, absent when it rendered none (empty, beyond EOF, all-oversized). */
  shownRange?: ShownRange;
}> {
  const verbatim = options.render === "verbatim";
  const known: string[] | undefined =
    anchors !== undefined && isAnchorArray(anchors) ? anchors : undefined;
  const ranged: RangedAnchorSource | undefined =
    !verbatim && anchors !== undefined && isRangedSource(anchors) ? anchors : undefined;
  const plan: AnchorWalk | undefined =
    !verbatim && anchors !== undefined && !isAnchorArray(anchors) && !isRangedSource(anchors)
      ? anchors
      : undefined;
  const counted = walkLines(text);
  const totalLines = visibleLineTotal(text, counted.total);
  const totals = { visible: totalLines, split: counted.total };
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  if (ranged !== undefined && ranged.anchorCount !== counted.total) {
    throw new StatIdentityMismatchError(
      `stat-matched snapshot has ${ranged.anchorCount} lines, file has ${counted.total}.`,
    );
  }
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  const windows = normWindows(options.windows, options.derivedWindows === true);
  const pageFor = async (
    ranges: LineRange[],
  ): Promise<{ ranges: string[][]; hashes: string[] }> => {
    const page = walkPage(text, ranges, plan?.assign);
    let hashes: string[];
    if (verbatim || known !== undefined) {
      hashes = known ?? [];
    } else if (ranged !== undefined) {
      hashes = await rangedPageHashes(ranged, ranges, page.ranges, text);
    } else {
      hashes = await (plan?.cached ??
        page.assigned ??
        (path
          ? lineHashes(text, path, undefined, snapshotIOFor(await loadHashStore()))
          : contentOnlyHashes(text)));
    }
    return { ranges: page.ranges, hashes };
  };
  if (totalLines === 0) {
    const page = await pageFor([]);
    return {
      ...emptyFilePreview(windows?.[0]?.offset ?? startLine, page.hashes, HASH_SEP, verbatim),
      hashes: page.hashes,
      lineTotals: totals,
    };
  }
  if (windows) {
    const requested = windows.map((window) => ({
      start: window.offset - 1,
      end: Math.min(window.offset - 1 + window.limit, totalLines),
    }));
    const merged = mergeRanges(requested);
    const page = await pageFor(merged);
    const ranges = requested.map((range) =>
      sliceMergedRanges(merged, page.ranges, range.start, range.end),
    );
    // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
    const rangedHashes =
      ranged === undefined
        ? undefined
        : (() => {
            let cursor = 0;
            const pieces = page.ranges.map((lines) => {
              const piece = page.hashes.slice(cursor, cursor + lines.length);
              cursor += lines.length;
              return piece;
            });
            return requested.map((range) =>
              sliceMergedRanges(merged, pieces, range.start, range.end),
            );
          })();
    return {
      ...buildWindowedPreview({
        windows,
        ...(options.noteClauses === undefined ? {} : { noteClauses: options.noteClauses }),
        ranges,
        totalLines,
        ...(rangedHashes !== undefined ? { rangedHashes } : {}),
        allHashes: page.hashes,
        maxLineBytes,
        maxTruncLines,
        verbatim,
      }),
      hashes: page.hashes,
      lineTotals: totals,
    };
  }
  if (startLine > totalLines) {
    const page = await pageFor([]);
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      served: [],
      hashes: page.hashes,
      lineTotals: totals,
    };
  }

  const limit = normPosInt(options.limit, "limit");
  const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const page = await pageFor([{ start: startLine - 1, end: endIdx }]);
  const selected = page.ranges[0] ?? [];
  const allHashes = page.hashes;
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  const selectedHashes = ranged !== undefined ? allHashes : allHashes.slice(startLine - 1, endIdx);
  const formatted = fmtRows(selectedHashes, selected, verbatim);
  const maxBytes = maxLineBytes;
  const rowSizes = selected.map((line, index) => ({
    lineNumber: startLine + index,
    bytes: Buffer.byteLength(
      verbatim ? line : `${selectedHashes[index]}${HASH_SEP}${line}`,
      "utf-8",
    ),
  }));
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    return {
      ...buildOversizedPreview({
        rowSizes,
        selected,
        selectedHashes,
        startLine,
        totalLines,
        maxLineBytes: maxBytes,
        remainingBytes: maxBytes,
        maxTruncLines,
        verbatim,
      }),
      hashes: allHashes,
      lineTotals: totals,
    };
  }

  const normal = buildNormalPreview({
    formatted,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
    verbatim,
  });
  return {
    text: normal.preview,
    ...(normal.truncation.truncated ? { truncation: normal.truncation } : {}),
    ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}),
    served: normal.served,
    hashes: allHashes,
    lineTotals: totals,
    ...(normal.shownRange !== undefined ? { shownRange: normal.shownRange } : {}),
  };
}
