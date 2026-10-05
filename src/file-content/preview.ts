import {
  formatSize,
  truncateHead,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { MAX_READ_WINDOWS } from "../constants.js";
import { DomainError } from "../domain-errors.js";
import {
  lineHashes,
  fmtRegion,
  HASH_SEP,
  MAX_HASH_LINES,
  type AnchorWalk,
} from "../hashline/index.js";
import type { ServedRow } from "../hashline/served.js";
import { visibleLineTotal, walkLines, type LineRange } from "./line-walker.js";

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
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Read request accepts at most ${MAX_READ_WINDOWS} windows.`,
    });
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

function formatPaginationHint(
  startLine: number,
  endLine: number,
  totalLines: number,
  nextOffset: number,
  byteLimit?: number,
): string {
  const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
  return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}
// WHY: verbatim renders the identical admitted rows with no anchor prefix; the row set, budgets,
// WHY: and hints are computed once, so only this formatter differs between the two modes.
function fmtRows(hashes: string[], lines: string[], verbatim: boolean): string {
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
    const emptyLineHash = hashes[0]!;
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
  const lineLabel =
    oversized.length === 1
      ? `Line ${oversized[0]!.lineNumber}`
      : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
  return { lineLabel, verb, addresses };
}

function buildOversizedPreview(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: string[];
  startLine: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  // WHY: a window is a bounded ask, so its section must not advertise a page it never owed
  // WHY: (mirrors buildNormalPreview); a genuinely truncated window still keeps its own hint.
  hintRemainder?: boolean;
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
  } = params;
  const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
  const rows = rowSizes.map((row, index) =>
    row.bytes > maxBytes
      ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
      : fmtRows([selectedHashes[index]!], [selected[index]!], verbatim),
  );
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
    preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.maxBytes)}`;
  } else if (shownRowCount > 0 && params.hintRemainder !== false && lastShownLine < totalLines) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset)}`;
  } else {
    preview += `\n\n${warning}`;
  }
  const served: ServedRow[] = [];
  if (!verbatim)
    for (let index = 0; index < shownRowCount; index++)
      if (rowSizes[index]!.bytes <= maxBytes)
        served.push({ position: startLine - 1 + index, hash: selectedHashes[index]! });
  return {
    text: preview,
    truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
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
  selectedHashes: string[];
  verbatim: boolean;
  // WHY: an entry of an explicit `windows` request is a bounded ask, not a page: the caller named
  // WHY: exactly these lines, so a trailing "use offset=N to continue" would invent intent.
  hintRemainder?: boolean;
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
  } = params;
  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });
  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines")
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
    else
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
  } else if (params.hintRemainder !== false && endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
  }
  const served: ServedRow[] = [];
  if (!verbatim)
    for (let index = 0; index < truncation.outputLines; index++)
      served.push({ position: startLine - 1 + index, hash: selectedHashes[index]! });
  return { preview, nextOffset, truncation, served };
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
  selectedHashes: string[];
  startLine: number;
  endIdx: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
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
  });
  return {
    text: normal.preview,
    truncation: normal.truncation.truncated ? normal.truncation : undefined,
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
  maxBytes: number;
  maxTruncLines: number;
  verbatim: boolean;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const { windows, ranges, totalLines, allHashes, maxBytes, maxTruncLines, verbatim } = params;
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
    const header = windowHeader(window.offset, endIdx, totalLines);
    const selected = ranges[index] ?? [];
    const selectedHashes = allHashes.slice(window.offset - 1, endIdx);
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
 * - `undefined`: none known yet, so served reaches for its own lazy call and verbatim never does.
 */
export type RenderAnchors = string[] | AnchorWalk;

/** Whether the caller handed anchors rather than a walk plan (readonly arrays do not narrow on their own). */
function isAnchorArray(anchors: RenderAnchors): anchors is string[] {
  return Array.isArray(anchors);
}

export async function fmtReadPreview(
  text: string,
  options: {
    offset?: number;
    limit?: number;
    windows?: ReadWindow[];
    render?: "served" | "verbatim";
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
  // WHY: only a walk plan carries an assignment. Anchors the caller already holds are rendered as
  // WHY: they are; verbatim never reaches for anchors at all.
  const known: string[] | undefined =
    anchors !== undefined && isAnchorArray(anchors) ? anchors : undefined;
  const plan: AnchorWalk | undefined =
    !verbatim && anchors !== undefined && !isAnchorArray(anchors) ? anchors : undefined;
  // WHY: the page walk below cannot know which lines to keep until the total is known, so the counts
  // WHY: come from one allocation-free walk of their own — two passes, neither holding a line.
  const counted = walkLines(text);
  const totalLines = visibleLineTotal(text, counted.total);
  const totals = { visible: totalLines, split: counted.total };
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
    const hashes =
      verbatim || known !== undefined
        ? (known ?? [])
        : (plan?.cached ??
          page.assigned ??
          (await (path ? lineHashes(text, path) : lineHashes(text))));
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
    const page = await pageFor(
      windows.map((window) => ({
        start: window.offset - 1,
        end: Math.min(window.offset - 1 + window.limit, totalLines),
      })),
    );
    return {
      ...buildWindowedPreview({
        windows,
        ranges: page.ranges,
        totalLines,
        allHashes: page.hashes,
        maxBytes: maxLineBytes,
        maxTruncLines,
        verbatim,
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
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
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
      ...(await buildOversizedPreview({
        rowSizes,
        selected,
        selectedHashes,
        startLine,
        totalLines,
        maxBytes,
        maxTruncLines,
        verbatim,
      })),
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
    truncation: normal.truncation.truncated ? normal.truncation : undefined,
    ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}),
    served: normal.served,
    hashes: allHashes,
    lineTotals: totals,
  };
}

// WHY: Re-export constants for callers that need them
export { MAX_HASH_LINES, HASH_SEP };
