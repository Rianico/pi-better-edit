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
import type { ServedRow } from "../served-session/serve-render.js";
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
function normWindows(windows: ReadWindow[] | undefined): ReadWindow[] | undefined {
  if (windows === undefined || windows.length === 0) return undefined;
  if (windows.length > MAX_READ_WINDOWS) {
    // WHY: the message is shared with admission (src/read.ts) — the same cap named one way.
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

/**
 * The page footer (spec §4.4). Names the file the continuation belongs to whenever the caller owns a
 * display path, so a multi-file result's footer is copy-pasteable on its own; `limit` repeats the number
 * of lines this footer covers, so continuing reads exactly as much as the page just shown.
 */
function formatPaginationHint(
  displayPath: string | undefined,
  startLine: number,
  endLine: number,
  totalLines: number,
  nextOffset: number,
  byteLimit?: number,
): string {
  const name = displayPath === undefined ? "" : `${displayPath} `;
  const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
  const limit = endLine - startLine + 1;
  return `[${name}lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use windows: [{ offset: ${nextOffset}, limit: ${limit} }] to continue.]`;
}
// WHY: verbatim renders the identical admitted rows with no anchor prefix; the row set, budgets,
// WHY: and hints are computed once, so only this formatter differs between the two modes.
function fmtRows(hashes: readonly string[], lines: readonly string[], verbatim: boolean): string {
  if (!verbatim) return fmtRegion(hashes, lines);
  const joined = lines.join("\n");
  // WHY: a lone empty line renders as "" — indistinguishable from an empty result, so mark it.
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
    // WHY: the walk already anchored this empty file's one line, which is the anchor of the empty
    // WHY: string — the only line an empty file has (`splitLines("")`), so it is the marker's own.
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

function oversizedWarning(oversized: { lineNumber: number }[]): {
  lineLabel: string;
  verb: string;
  addresses: string;
} {
  const [firstOversized] = oversized;
  const lineLabel =
    oversized.length === 1 && firstOversized !== undefined
      ? `Line ${firstOversized.lineNumber}`
      : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
  return { lineLabel, verb, addresses };
}

function buildOversizedPreview(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: readonly string[];
  startLine: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  // WHY: a window is a bounded ask, so its section must not advertise a page it never owed
  // WHY: (mirrors buildNormalPreview); a genuinely truncated window still keeps its own hint.
  hintRemainder?: boolean;
  /** The caller's own path, for the footer that names the file a continuation belongs to. */
  displayPath?: string;
  verbatim: boolean;
}): { text: string; truncation?: TruncationResult; nextOffset?: number; served: ServedRow[] } {
  const {
    rowSizes,
    selected,
    selectedHashes,
    startLine,
    totalLines,
    maxBytes,
    maxTruncLines,
    verbatim,
    displayPath,
  } = params;
  const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
  const rows = rowSizes.map((row, index) => {
    if (row.bytes > maxBytes) {
      return `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`;
    }
    const hash = selectedHashes[index];
    const line = selected[index];
    if (hash === undefined || line === undefined) {
      throw new Error(`preview row ${index} has no selected line`);
    }
    return fmtRows([hash], [line], verbatim);
  });
  const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
  const shownRowCount =
    skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const { lineLabel, verb, addresses } = oversizedWarning(oversized);
  const reason = verbatim
    ? "content not shown; line exceeds the read byte budget"
    : "content not shown because hashline anchors require full lines";
  const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; ${reason}. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
  let preview = skippedTruncation.content;
  let nextOffset: number | undefined;
  if (shownRowCount > 0 && skippedTruncation.truncated) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(displayPath, startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.maxBytes)}`;
  } else if (shownRowCount > 0 && params.hintRemainder !== false && lastShownLine < totalLines) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(displayPath, startLine, lastShownLine, totalLines, nextOffset)}`;
  } else {
    preview += `\n\n${warning}`;
  }
  const served: ServedRow[] = [];
  if (!verbatim)
    for (let index = 0; index < shownRowCount; index++) {
      const row = rowSizes[index];
      const hash = selectedHashes[index];
      if (row === undefined || hash === undefined) {
        throw new Error(`preview served row ${index} is missing`);
      }
      if (row.bytes <= maxBytes) served.push({ position: startLine - 1 + index, hash });
    }
  return {
    text: preview,
    ...(skippedTruncation.truncated ? { truncation: skippedTruncation } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
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
  // WHY: an entry of an explicit `windows` request is a bounded ask, not a page: the caller named
  // WHY: exactly these lines, so a trailing continuation footer would invent intent.
  hintRemainder?: boolean;
  /** The caller's own path, for the footer that names the file a continuation belongs to. */
  displayPath?: string;
}): {
  preview: string;
  nextOffset?: number;
  truncation: ReturnType<typeof truncateHead>;
  served: ServedRow[];
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
    displayPath,
  } = params;
  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });
  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines")
      preview += `\n\n${formatPaginationHint(displayPath, startLine, endLineDisplay, totalLines, nextOffset)}`;
    else
      preview += `\n\n${formatPaginationHint(displayPath, startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
  } else if (params.hintRemainder !== false && endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(displayPath, startLine, endIdx, totalLines, nextOffset)}`;
  }
  const served: ServedRow[] = [];
  if (!verbatim)
    for (const [index, hash] of selectedHashes.entries()) {
      if (index >= truncation.outputLines) break;
      served.push({ position: startLine - 1 + index, hash });
    }
  return { preview, truncation, ...(nextOffset !== undefined ? { nextOffset } : {}), served };
}

function windowHeader(startLine: number, endLine: number, totalLines: number): string {
  return `=== Lines ${startLine}-${endLine} of ${totalLines} ===`;
}

/**
 * Renders one window through the same oversized/truncation pipeline a single-window read uses, so a
 * window inside a multi-window request degrades exactly like the same range read alone.
 */
function buildWindowSection(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: readonly string[];
  startLine: number;
  endIdx: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
  /** The caller's own path, for the footer that names the file a continuation belongs to. */
  displayPath?: string;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const {
    rowSizes,
    selected,
    selectedHashes,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    verbatim,
    displayPath,
  } = params;
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    return buildOversizedPreview({
      rowSizes,
      selected,
      selectedHashes,
      startLine,
      totalLines,
      maxBytes,
      maxTruncLines,
      hintRemainder: false,
      verbatim,
      ...(displayPath !== undefined ? { displayPath } : {}),
    });
  }
  const normal = buildNormalPreview({
    formatted: fmtRows(selectedHashes, selected, verbatim),
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
    hintRemainder: false,
    verbatim,
    ...(displayPath !== undefined ? { displayPath } : {}),
  });
  return {
    text: normal.preview,
    ...(normal.truncation.truncated ? { truncation: normal.truncation } : {}),
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
 *
 * WHY: the walk holds the merged ranges' lines; each window still owns its own range (the request's
 * order and boundaries are part of the request), so the window's lines are the concatenation of the
 * merged pieces that intersect it, trimmed to its edges.
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
 *
 * WHY: this is how the served read gets its anchors and its page out of ONE pass — the assignment runs
 * WHY: inside the walk, in line order, so nothing splits the text a second time to produce them. One
 * WHY: allocation-free walk answers the counts, this one answers the page.
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
  /** The lines the walk retained, one array per window in request order. */
  ranges: string[][];
  totalLines: number;
  allHashes: string[];
  /** Per-window page-aligned anchors when the source resolved pages, not the file (ADR-0043). */
  rangedHashes?: readonly (readonly string[])[];
  maxBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
  /** The caller's own path, for the footer that names the file a continuation belongs to. */
  displayPath?: string;
  sectionHeader?: (startLine: number, endLine: number, totalLines: number) => string;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const {
    windows,
    ranges,
    totalLines,
    allHashes,
    rangedHashes,
    maxBytes,
    maxTruncLines,
    verbatim,
    displayPath,
    sectionHeader,
  } = params;
  const sections: string[] = [];
  const hashByPosition = new Map<number, string>();
  let truncation: TruncationResult | undefined;
  let remainingBytes = maxBytes;
  let remainingLines = maxTruncLines;

  for (const [index, window] of windows.entries()) {
    if (window.offset > totalLines) {
      sections.push(
        `Offset ${window.offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      );
      continue;
    }
    const endIdx = Math.min(window.offset - 1 + window.limit, totalLines);
    const header = (sectionHeader ?? windowHeader)(window.offset, endIdx, totalLines);
    const selected = ranges[index] ?? [];
    const selectedHashes = rangedHashes?.[index] ?? allHashes.slice(window.offset - 1, endIdx);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      sections.push(
        `${header}\n[Read budget exhausted; this window is not shown. Re-read it on its own.]`,
      );
      // WHY: `metrics.truncated` must be honest when the shared budget cut a window away, so the
      // WHY: same function that reports truncation elsewhere derives it from the budget actually spent.
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
      maxBytes: remainingBytes,
      maxTruncLines: remainingLines,
      verbatim,
      ...(displayPath !== undefined ? { displayPath } : {}),
    });
    sections.push(`${header}\n${built.text}`);
    for (const row of built.served) hashByPosition.set(row.position, row.hash);
    remainingLines -= built.text === "" ? 0 : built.text.split("\n").length;
    remainingBytes -= Buffer.byteLength(`${built.text}${header}`, "utf-8");
    if (truncation === undefined && built.truncation) truncation = built.truncation;
  }

  return {
    text: sections.join("\n\n"),
    ...(truncation ? { truncation } : {}),
    // WHY: a multi-window request is N discrete slices, not one stream, so the result carries no root
    // WHY: `nextOffset`: a scalar would invite `offset = nextOffset` and silently re-read a window the
    // WHY: caller never asked to continue. A truncated window says so in its own section text.
    // WHY: no outer mode check here: `hashByPosition` is empty for verbatim because every inner
    // WHY: builder guards its own `served` rows (`fmtRows`, `buildOversizedPreview`,
    // WHY: `buildNormalPreview`), so an outer guard would be unreachable and untestable.
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
 *   page keeps (ADR-0043) — the stat-identity fast path never materializes the whole file's identity;
 * - `undefined`: none known yet, so served reaches for its own lazy call and verbatim never does.
 */
export type RenderAnchors = string[] | AnchorWalk | RangedAnchorSource;

/** One committed line as the page read sees it: the anchor to serve and the canon it was based on. */
interface RangedAnchorLine {
  anchor: string;
  canonHash: string;
}

/**
 * A committed snapshot's line identity, read a page at a time (ADR-0043).
 *
 * `anchorCount` is the line count the snapshot committed; a preview whose own walk disagrees with it
 * is not describing the same file, and refuses the source.
 */
interface RangedAnchorSource {
  readonly anchorCount: number;
  /** Lines `[start, end)` (0-based, half-open), exactly `end - start` of them, in line order. */
  range(start: number, end: number): Promise<readonly RangedAnchorLine[]>;
}

/**
 * A stat-matched snapshot could not describe the bytes being served (ADR-0043): its line count, a
 * missing lineage row, or a line's canon digest disagreed with the file. The caller re-derives the
 * file's identity through the content-hash path — the served page is never rendered from a source it
 * could not prove.
 */
export class StatIdentityMismatchError extends Error {}
/** Whether the caller handed anchors rather than a walk plan (readonly arrays do not narrow on their own). */
function isAnchorArray(anchors: RenderAnchors): anchors is string[] {
  return Array.isArray(anchors);
}

/** Whether the anchors come a page at a time from a committed snapshot (ADR-0043). */
function isRangedSource(anchors: RenderAnchors): anchors is RangedAnchorSource {
  return !Array.isArray(anchors) && "range" in anchors;
}
/**
 * Resolves a stat-matched page, verifying every line before its anchor is served (ADR-0043).
 *
 * The snapshot's own `canon_hash` is the evidence: an anchor is only served for a line whose current
 * canon still digests to it, so a stat identity that lied (a same-size rewrite on a filesystem with
 * coarse timestamps, a replaced-but-identical path) costs a fallback, never a stale anchor. Any
 * disagreement — a missing lineage row, a short range, a foreign canon — surfaces as
 * `StatIdentityMismatchError`, which the caller answers by re-deriving identity from content.
 */
async function rangedPageHashes(
  source: RangedAnchorSource,
  ranges: readonly LineRange[],
  kept: readonly (readonly string[])[],
  text: string,
): Promise<string[]> {
  // WHY: an empty file still has one anchorable line. There is no page to keep, but the empty-file
  // WHY: marker renders that line's anchor, so resolve and verify it too.
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
    render?: "served" | "verbatim";
    /** The caller's own path for the file header/footer; absent for a pathless preview. */
    displayPath?: string;
    sectionHeader?: (startLine: number, endLine: number, totalLines: number) => string;
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
}> {
  const verbatim = options.render === "verbatim";
  // WHY: the anchor seed path is not the display path — the first is the absolute path a hash is
  // WHY: scoped to, the second is what the caller wrote, which is what a header/footer must name.
  const displayPath = options.displayPath;
  const sectionHeader = options.sectionHeader;
  // WHY: only a walk plan carries an assignment. Anchors the caller already holds are rendered as
  // WHY: they are; verbatim never reaches for anchors at all.
  const known: string[] | undefined =
    anchors !== undefined && isAnchorArray(anchors) ? anchors : undefined;
  const ranged: RangedAnchorSource | undefined =
    !verbatim && anchors !== undefined && isRangedSource(anchors) ? anchors : undefined;
  const plan: AnchorWalk | undefined =
    !verbatim && anchors !== undefined && !isAnchorArray(anchors) && !isRangedSource(anchors)
      ? anchors
      : undefined;
  // WHY: the page walk below cannot know which lines to keep until the total is known, so the counts
  // WHY: come from one allocation-free walk of their own — two passes, neither holding a line.
  const counted = walkLines(text);
  const totalLines = visibleLineTotal(text, counted.total);
  const totals = { visible: totalLines, split: counted.total };
  // WHY: (ADR-0043) the stat-matched snapshot must name the same number of lines this walk counted.
  // WHY: A disagreement is a changed file under a lying stat identity — refuse the source, never the page.
  if (ranged !== undefined && ranged.anchorCount !== counted.total) {
    throw new StatIdentityMismatchError(
      `stat-matched snapshot has ${ranged.anchorCount} lines, file has ${counted.total}.`,
    );
  }
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  const windows = normWindows(options.windows);
  /**
   * WHY: one walk per page answers both of a read's questions: the lines to render, and (served) the
   * WHY: anchors to render them with. Without a plan the anchors keep their own whole-content call,
   * WHY: and verbatim never makes one — the render mode is the hashless authority.
   */
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
        (path ? lineHashes(text, path) : contentOnlyHashes(text)));
    }
    return { ranges: page.ranges, hashes };
  };
  if (totalLines === 0) {
    // WHY: an empty file has one line to anchor, so the walk runs before the empty-file marker.
    const page = await pageFor([]);
    return {
      ...emptyFilePreview(windows?.[0]?.offset ?? startLine, page.hashes, HASH_SEP, verbatim),
      hashes: page.hashes,
      lineTotals: totals,
    };
  }
  if (windows) {
    // WHY: the UNION of the requested ranges is walked once, so overlapping or abutting windows
    // WHY: retain a shared line once; `sliceMergedRanges` then gives every window its own section
    // WHY: lines back, byte for byte, as if it had been walked alone.
    const requested = windows.map((window) => ({
      start: window.offset - 1,
      end: Math.min(window.offset - 1 + window.limit, totalLines),
    }));
    const merged = mergeRanges(requested);
    const page = await pageFor(merged);
    const ranges = requested.map((range) =>
      sliceMergedRanges(merged, page.ranges, range.start, range.end),
    );
    // WHY: a ranged source resolved `page.hashes` one piece per merged range — the same shape
    // WHY: `page.ranges` has — so `sliceMergedRanges` gives each window its own page-aligned anchors
    // WHY: without ever holding the file's whole anchor array (ADR-0043).
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
        ranges,
        totalLines,
        // WHY: a ranged source resolves the page, not the file: its array is aligned to the merged ranges,
        // WHY: so each window takes the same slice `sliceMergedRanges` gave its lines (ADR-0043).
        ...(rangedHashes !== undefined ? { rangedHashes } : {}),
        allHashes: page.hashes,
        maxBytes: maxLineBytes,
        maxTruncLines,
        verbatim,
        ...(displayPath !== undefined ? { displayPath } : {}),
        ...(sectionHeader !== undefined ? { sectionHeader } : {}),
      }),
      hashes: page.hashes,
      lineTotals: totals,
    };
  }
  if (startLine > totalLines) {
    // WHY: the caller still needs the whole anchor array (it materializes the snapshot), so this page
    // WHY: still walks the text — with an empty range, since there is no page to keep — and returns only
    // WHY: what it names: a spread here would put the walk's ranges on the result too.
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
  // WHY: a ranged source is already page-aligned (its array starts at `startLine`), while a full anchor
  // WHY: array is indexed by absolute line — slice only the latter (ADR-0043).
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
        maxBytes,
        maxTruncLines,
        verbatim,
        ...(displayPath !== undefined ? { displayPath } : {}),
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
    ...(displayPath !== undefined ? { displayPath } : {}),
  });
  return {
    text: normal.preview,
    ...(normal.truncation.truncated ? { truncation: normal.truncation } : {}),
    ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}),
    served: normal.served,
    hashes: allHashes,
    lineTotals: totals,
  };
}
