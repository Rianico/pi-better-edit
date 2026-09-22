import {
  formatSize,
  truncateHead,
  DEFAULT_MAX_LINES,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { MAX_READ_LINE_BYTES, MAX_READ_WINDOWS } from "../constants.js";
import { DomainError } from "../domain-errors.js";
import { lineHashes, fmtRegion, HASH_SEP, MAX_HASH_LINES } from "../hashline/index.js";
import type { ServedRow } from "../hashline/served.js";
import { visLines } from "../utils.js";

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

async function emptyFilePreview(
  startLine: number,
  text: string,
  precomputedHashes: string[] | undefined,
  path: string | undefined,
  hashSep: string,
): Promise<{ text: string; served: ServedRow[] }> {
  if (startLine === 1) {
    const allHashes =
      precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
    const emptyLineHash = allHashes[0]!;
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
}): { text: string; truncation?: TruncationResult; nextOffset?: number; served: ServedRow[] } {
  const { rowSizes, selected, selectedHashes, startLine, totalLines, maxBytes, maxTruncLines } =
    params;
  const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
  const rows = rowSizes.map((row, index) =>
    row.bytes > maxBytes
      ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
      : fmtRegion([selectedHashes[index]!], [selected[index]!]),
  );
  const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
  const shownRowCount =
    skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const { lineLabel, verb, addresses } = oversizedWarning(oversized);
  const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
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
  // WHY: an entry of an explicit `windows` request is a bounded ask, not a page: the caller named
  // WHY: exactly these lines, so a trailing "use offset=N to continue" would invent intent.
  hintRemainder?: boolean;
}): {
  preview: string;
  nextOffset?: number;
  truncation: ReturnType<typeof truncateHead>;
  served: ServedRow[];
} {
  const { formatted, startLine, endIdx, totalLines, maxBytes, maxTruncLines, selectedHashes } =
    params;
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
    });
  }
  const normal = buildNormalPreview({
    formatted: fmtRegion(selectedHashes, selected),
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
    hintRemainder: false,
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
function buildWindowedPreview(params: {
  windows: ReadWindow[];
  allLines: string[];
  allHashes: string[];
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
}): { text: string; truncation?: TruncationResult; served: ServedRow[] } {
  const { windows, allLines, allHashes, totalLines, maxBytes, maxTruncLines } = params;
  const sections: string[] = [];
  const hashByPosition = new Map<number, string>();
  let truncation: TruncationResult | undefined;
  let remainingBytes = maxBytes;
  let remainingLines = maxTruncLines;

  for (const window of windows) {
    if (window.offset > totalLines) {
      sections.push(
        `Offset ${window.offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      );
      continue;
    }
    const endIdx = Math.min(window.offset - 1 + window.limit, totalLines);
    const header = windowHeader(window.offset, endIdx, totalLines);
    const selected = allLines.slice(window.offset - 1, endIdx);
    const selectedHashes = allHashes.slice(window.offset - 1, endIdx);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      sections.push(
        `${header}\n[Read budget exhausted; this window is not shown. Re-read it on its own.]`,
      );
      // WHY: `metrics.truncated` must be honest when the shared budget cut a window away, so the
      // WHY: same function that reports truncation elsewhere derives it from the budget actually spent.
      const skipped = truncateHead(fmtRegion(selectedHashes, selected), {
        maxBytes: Math.max(0, remainingBytes),
        maxLines: Math.max(0, remainingLines),
      });
      if (truncation === undefined && skipped.truncated) truncation = skipped;
      continue;
    }
    const rowSizes = selected.map((line, index) => ({
      lineNumber: window.offset + index,
      bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
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
    served: [...hashByPosition.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([position, hash]) => ({ position, hash })),
  };
}

export async function fmtReadPreview(
  text: string,
  options: { offset?: number; limit?: number; windows?: ReadWindow[] },
  precomputedHashes?: string[],
  path?: string,
  maxLineBytes = MAX_READ_LINE_BYTES,
  maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  served: ServedRow[];
}> {
  const allLines = visLines(text);
  const totalLines = allLines.length;
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  const windows = normWindows(options.windows);
  if (totalLines === 0)
    return emptyFilePreview(
      windows?.[0]?.offset ?? startLine,
      text,
      precomputedHashes,
      path,
      HASH_SEP,
    );
  if (windows) {
    const allHashes =
      precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
    return buildWindowedPreview({
      windows,
      allLines,
      allHashes,
      totalLines,
      maxBytes: maxLineBytes,
      maxTruncLines,
    });
  }
  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
      served: [],
    };
  }

  const limit = normPosInt(options.limit, "limit");
  const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
  const formatted = fmtRegion(selectedHashes, selected);
  const maxBytes = maxLineBytes;
  const rowSizes = selected.map((line, index) => ({
    lineNumber: startLine + index,
    bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
  }));
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    return buildOversizedPreview({
      rowSizes,
      selected,
      selectedHashes,
      startLine,
      totalLines,
      maxBytes,
      maxTruncLines,
    });
  }

  const normal = buildNormalPreview({
    formatted,
    startLine,
    endIdx,
    totalLines,
    maxBytes,
    maxTruncLines,
    selectedHashes,
  });
  return {
    text: normal.preview,
    truncation: normal.truncation.truncated ? normal.truncation : undefined,
    ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}),
    served: normal.served,
  };
}

// WHY: Re-export constants for callers that need them
export { MAX_HASH_LINES, HASH_SEP };
