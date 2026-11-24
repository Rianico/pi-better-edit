/**
 * SAFETY: edit-diff - row-intrinsic invisible-code-point annotation (issue #231).
 *
 */
import * as Diff from "diff";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import { ANCHOR_LEN, HASH_SEP, defaultHashIdentity } from "./hashline/hash-identity.js";
import type { ServedRow } from "./served-session/serve-render.js";

import { invisibleName, scanInvisibleLine } from "./file-content/invisible.js";
export type LineEnding = "\r\n" | "\n" | "\r";

export function detectEnding(content: string): LineEnding {
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return content.indexOf("\r") >= 0 ? "\r" : "\n";
  }
  const crlfIdx = content.indexOf("\r\n");
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: LineEnding): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

/** Terminator counts by kind: a CRLF pair counts once, never as CR plus LF. */
export interface LineEndingCounts {
  readonly crlf: number;
  readonly lf: number;
  readonly cr: number;
}

/** One pass over the raw text, counting each terminator kind at its own byte. */
export function countLineEndings(text: string): LineEndingCounts {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      lf += 1;
    } else if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    }
  }
  return { crlf, lf, cr };
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

const SUB_ROW_BYTE_CAP = 200;
const SUB_ROW_CARET = "▲";

function hexToken(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function entryToken(codePoint: number): string {
  const name = invisibleName(codePoint);
  return name === undefined ? hexToken(codePoint) : `${hexToken(codePoint)} ${name}`;
}

function subRowForLine(line: string, direction: "removed" | "added"): string | undefined {
  const found = scanInvisibleLine(line);
  if (found.length === 0) return undefined;
  const first = found[0]!;
  const entries = found
    .map((occurrence) => `col ${occurrence.column}: ${entryToken(occurrence.codePoint)}`)
    .join("; ");
  const body = `[${entries} ${direction}]`;
  const gutter = " ".repeat(ANCHOR_LEN + 1) + HASH_SEP;
  const caretForm = `${gutter}${" ".repeat(first.column - 1)}${SUB_ROW_CARET} ${body}`;
  if (Buffer.byteLength(caretForm, "utf-8") > SUB_ROW_BYTE_CAP) return `${gutter} ${body}`;
  return caretForm;
}

function fmtDiffLine(prefix: " " | "+" | "-", line: string, hash: string | undefined): string {
  if (hash === undefined) {
    return `${prefix}${" ".repeat(ANCHOR_LEN)}${HASH_SEP}${line}`;
  }
  return `${prefix}${hash}${HASH_SEP}${line}`;
}

const UNTOUCHED_MARKER: unique symbol = Symbol("untouched");
const isUntouchedMarker = (line: string | symbol): line is symbol => line === UNTOUCHED_MARKER;

function pushAddedLines(
  displayLines: string[],
  effectiveNewHashes: string[],
  newLineNum: { value: number },
  output: string[],
  servedRows: ServedRow[],
): void {
  for (let k = 0; k < displayLines.length; k++) {
    const line = displayLines[k]!;
    const hash = effectiveNewHashes[newLineNum.value - 1];
    output.push(fmtDiffLine("+", line, hash));
    const subRow = subRowForLine(line, "added");
    if (subRow !== undefined) output.push(subRow);
    if (hash !== undefined) servedRows.push({ position: newLineNum.value - 1, hash });
    newLineNum.value++;
  }
}
/**
 * Render the removed side of one diff part. `served` is the pre-batch positional served mirror in
 * ORIGINAL line coordinates: a `null` slot renders its row with the empty gutter, and the rows the
 * deleted-span marker hides are counted as unserved in that marker's own text.
 */
function pushRemovedLines(
  displayLines: string[],
  oldContentHashes: string[] | undefined,
  oldLineNum: { value: number },
  output: string[],
  served?: readonly (string | null)[],
): void {
  const emit = (line: string): void => {
    const unserved = served?.[oldLineNum.value - 1] === null;
    const hash = unserved ? undefined : oldContentHashes?.[oldLineNum.value - 1];
    output.push(fmtDiffLine("-", line, hash));
    const subRow = subRowForLine(line, "removed");
    if (subRow !== undefined) output.push(subRow);
    oldLineNum.value++;
  };
  if (displayLines.length <= DIFF_REMOVED_CAP) {
    for (const line of displayLines) emit(line);
    return;
  }
  const omitted = displayLines.length - DIFF_REMOVED_EDGE * 2;
  let foldedUnserved = 0;
  for (let k = 0; k < omitted; k++) {
    if (served?.[oldLineNum.value + DIFF_REMOVED_EDGE - 1 + k] === null) foldedUnserved++;
  }
  for (const line of displayLines.slice(0, DIFF_REMOVED_EDGE)) emit(line);
  // Ref: docs/.archive_adrs/0024-narrow-p2-interior-exposure-cap-removed-diffs.md
  output.push(
    ` - ... [${omitted} lines deleted${foldedUnserved > 0 ? ` (${foldedUnserved} unserved)` : ""}] ...`,
  );
  oldLineNum.value += omitted;
  for (const line of displayLines.slice(-DIFF_REMOVED_EDGE)) emit(line);
}

function contextLinesToShow(
  displayLines: string[],
  lastWasChange: boolean,
  nextPartIsChange: boolean,
  contextLines: number,
): { linesToShow: (string | symbol)[]; skipStart: number; skipMiddle: number } {
  let linesToShow: (string | symbol)[] = displayLines;
  let skipStart = 0;
  let skipMiddle = 0;
  if (!lastWasChange) {
    skipStart = Math.max(0, displayLines.length - contextLines);
    linesToShow = displayLines.slice(skipStart);
  } else if (nextPartIsChange && displayLines.length > contextLines * 2) {
    const tail = contextLines === 0 ? [] : displayLines.slice(-contextLines);
    linesToShow = [...displayLines.slice(0, contextLines), UNTOUCHED_MARKER, ...tail];
    skipMiddle = displayLines.length - contextLines * 2;
  } else if (!nextPartIsChange && linesToShow.length > contextLines) {
    linesToShow = linesToShow.slice(0, contextLines);
  }
  return { linesToShow, skipStart, skipMiddle };
}

/** The renderer's own line split: `split("\n")` with the trailing empty element dropped. */
function renderLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** One alignment entry in render order: the old/new line index each rendered row consumes. */
type AlignmentEntry =
  | { readonly kind: "context"; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "removed"; readonly oldIndex: number }
  | { readonly kind: "added"; readonly newIndex: number };

function flattenParts(parts: readonly Diff.Change[]): AlignmentEntry[] {
  const entries: AlignmentEntry[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const part of parts) {
    const count = renderLines(part.value).length;
    if (part.added) {
      for (let k = 0; k < count; k++) entries.push({ kind: "added", newIndex: newIndex + k });
      newIndex += count;
    } else if (part.removed) {
      for (let k = 0; k < count; k++) entries.push({ kind: "removed", oldIndex: oldIndex + k });
      oldIndex += count;
    } else {
      for (let k = 0; k < count; k++) {
        entries.push({ kind: "context", oldIndex: oldIndex + k, newIndex: newIndex + k });
      }
      oldIndex += count;
      newIndex += count;
    }
  }
  return entries;
}

interface LineMatch {
  readonly oldIndex: number;
  readonly newIndex: number;
}

/**
 * Order-preserving greedy pairing of old lines to new lines by line identity. Old lines are walked
 * ascending and each takes the earliest still-unclaimed new index after the previous match, so the
 * result is a monotone alignment: every matched index pair is used at most once.
 */
function matchLinesByAnchor(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldHashes: readonly string[],
  newHashes: readonly string[],
): LineMatch[] {
  const newIndexesByHash = new Map<string, number[]>();
  for (let j = 0; j < newHashes.length; j++) {
    const hash = newHashes[j]!;
    const indexes = newIndexesByHash.get(hash);
    if (indexes === undefined) newIndexesByHash.set(hash, [j]);
    else indexes.push(j);
  }
  const matches: LineMatch[] = [];
  let lastNewIndex = -1;
  for (let i = 0; i < oldHashes.length; i++) {
    const candidates = newIndexesByHash.get(oldHashes[i]!);
    if (candidates === undefined) continue;
    const newIndex = candidates.find((j) => j > lastNewIndex && newLines[j] === oldLines[i]);
    if (newIndex === undefined) continue;
    matches.push({ oldIndex: i, newIndex });
    lastNewIndex = newIndex;
  }
  return matches;
}

function changePart(kind: "context" | "removed" | "added", lines: readonly string[]): Diff.Change {
  return {
    value: lines.map((line) => `${line}\n`).join(""),
    count: lines.length,
    added: kind === "added",
    removed: kind === "removed",
  };
}

/** Rebuild `parts` from a monotone match list: gaps keep their old/new order, matches merge. */
function rebuildParts(
  oldLines: readonly string[],
  newLines: readonly string[],
  matches: readonly LineMatch[],
): Diff.Change[] {
  const parts: Diff.Change[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let contextRun: string[] = [];
  const flushContext = (): void => {
    if (contextRun.length === 0) return;
    parts.push(changePart("context", contextRun));
    contextRun = [];
  };
  for (const match of matches) {
    if (match.oldIndex > oldCursor) {
      flushContext();
      parts.push(changePart("removed", oldLines.slice(oldCursor, match.oldIndex)));
    }
    if (match.newIndex > newCursor) {
      flushContext();
      parts.push(changePart("added", newLines.slice(newCursor, match.newIndex)));
    }
    contextRun.push(oldLines[match.oldIndex]!);
    oldCursor = match.oldIndex + 1;
    newCursor = match.newIndex + 1;
  }
  flushContext();
  if (oldCursor < oldLines.length) parts.push(changePart("removed", oldLines.slice(oldCursor)));
  if (newCursor < newLines.length) parts.push(changePart("added", newLines.slice(newCursor)));
  return parts;
}

/**
 * Anchor refinement of the text diff (#326). A context pairing is valid only when both sides name the
 * SAME line identity: Myers pairs byte-identical lines by position, so two equal `dup` lines are
 * interchangeable to it — but not to the anchors, where the replaced line's anchor is retired and the
 * survivor keeps its own. Line identity therefore refines the text pairing, never the reverse.
 *
 * Returns `parts` untouched when no context pair disagrees on identity, and also when nothing matches
 * at all — a rewrite retires every identity, so the text diff is already the best projection there.
 */
function refinePartsByAnchor(
  parts: readonly Diff.Change[],
  oldLines: readonly string[],
  newLines: readonly string[],
  oldHashes: readonly string[],
  newHashes: readonly string[],
): readonly Diff.Change[] {
  const disagrees = flattenParts(parts).some(
    (entry) => entry.kind === "context" && oldHashes[entry.oldIndex] !== newHashes[entry.newIndex],
  );
  if (!disagrees) return parts;
  const matches = matchLinesByAnchor(oldLines, newLines, oldHashes, newHashes);
  if (matches.length === 0) return parts;
  return rebuildParts(oldLines, newLines, matches);
}

/**
 * The alignment `genDiff` renders. Myers text pairing is the base; both sides' anchors refine it only
 * when each array covers its own content line-for-line. A side without anchors stays on the text-only
 * path: the renderer cannot tell line identities apart there, so it must not guess.
 */
function diffParts(
  oldContent: string,
  newContent: string,
  oldContentHashes: string[] | undefined,
  newContentHashes: string[] | undefined,
): readonly Diff.Change[] {
  const parts = Diff.diffLines(oldContent, newContent);
  if (!Array.isArray(oldContentHashes) || !Array.isArray(newContentHashes)) return parts;
  const oldLines = renderLines(oldContent);
  const newLines = renderLines(newContent);
  if (oldContentHashes.length !== oldLines.length) return parts;
  if (newContentHashes.length !== newLines.length) return parts;
  return refinePartsByAnchor(parts, oldLines, newLines, oldContentHashes, newContentHashes);
}

function collectUnservedRemoved(
  displayLines: string[],
  firstOldLine: number,
  served: readonly (string | null)[] | undefined,
  out: number[],
): void {
  if (served === undefined) return;
  for (let k = 0; k < displayLines.length; k++) {
    const line = firstOldLine + k;
    if (served[line - 1] === null) out.push(line);
  }
}
/**
 * genDiff is the single diff projection (#169). Every emitted row's anchor equals the true new-file line content hash at that
 * position; removed rows carry the true old-file hash when old hashes are provided. Markers hide exactly their span:
 * ` ... [N lines untouched] ...` advances both cursors past N hidden rows, keeping every FOLLOWING emitted anchor at its true file
 * position (whether those rows are addressable is a property of the serve that carries this projection, not of this renderer), and
 * ` - ... [N lines deleted] ...` advances the old cursor past N deleted rows (cursor-exact); a served mirror adds the unserved count.
 * Collapse invariant: a middle gap smaller than 2×context renders whole (#166/#172); at context 0 every non-empty middle gap collapses
 * to a single counted marker (#170); bare ` ...` appears only at leading/trailing edges; added spans are never collapsed. `servedRows`
 * mirror exactly the rendered context/addition rows (position + hash). `firstChangedLine`/`lastChangedLine` bracket the changed
 * new-content lines (1-indexed, `lastChangedLine >= firstChangedLine` whenever either is set); a pure deletion names the position
 * where the removed text sat, so an end-of-file deletion may name one line past the last new line, and both are absent on a no-op.
 */
export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
  filePath?: string,
  served?: readonly (string | null)[],
): {
  diff: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  servedRows: ServedRow[];
  /**
   * Every removed OLD line the pre-batch served mirror marks `null`, ascending, independent of the
   * fold cap the rendered diff applies. Empty when no mirror is supplied or every removed line was
   * served.
   */
  unservedRemovedLines: number[];
  /**
   * Every removed OLD line in the whole diff, whatever the mirror says and whatever the fold cap
   * renders. It is the replaced-span denominator a message quotes, so it never shrinks when the
   * renderer folds rows away.
   */
  removedLineCount: number;
} {
  const effectiveNewHashes =
    newContentHashes ??
    (filePath === undefined
      ? (() => {
          throw new DomainError("E_INTERNAL_INVARIANT", {
            message: "genDiff requires precomputed hashes or a file path.",
          });
        })()
      : defaultHashIdentity.hashesForSync(newContent, filePath));

  const parts = diffParts(oldContent, newContent, oldContentHashes, newContentHashes);
  const output: string[] = [];
  const servedRows: ServedRow[] = [];
  let newLineNum = 1;
  let oldLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  let lastChangedLine: number | undefined;
  const unservedRemovedLines: number[] = [];
  let removedLineCount = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw.at(-1) === "") raw.pop();
    const displayLines = raw;

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      if (part.added) {
        const n = { value: newLineNum };
        pushAddedLines(displayLines, effectiveNewHashes, n, output, servedRows);
        newLineNum = n.value;
        lastChangedLine = newLineNum - 1;
      } else {
        const o = { value: oldLineNum };
        collectUnservedRemoved(displayLines, oldLineNum, served, unservedRemovedLines);
        pushRemovedLines(displayLines, oldContentHashes, o, output, served);
        removedLineCount += displayLines.length;
        oldLineNum = o.value;
        lastChangedLine = newLineNum;
      }
      if (lastChangedLine < (firstChangedLine ?? lastChangedLine)) {
        lastChangedLine = firstChangedLine;
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange = i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      const { linesToShow, skipStart, skipMiddle } = contextLinesToShow(
        displayLines,
        lastWasChange,
        nextPartIsChange,
        contextLines,
      );

      if (skipStart > 0) {
        output.push(" ...");
        newLineNum += skipStart;
        oldLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (isUntouchedMarker(line)) {
          output.push(` ... [${skipMiddle} lines untouched] ...`);
          newLineNum += skipMiddle;
          oldLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        output.push(fmtDiffLine(" ", line, hash));
        if (hash !== undefined) {
          servedRows.push({ position: newLineNum - 1, hash });
        }
        newLineNum++;
        oldLineNum++;
      }
    } else {
      newLineNum += displayLines.length;
      oldLineNum += displayLines.length;
    }
    lastWasChange = false;
  }

  return {
    diff: output.join("\n"),
    firstChangedLine,
    lastChangedLine,
    servedRows,
    unservedRemovedLines,
    removedLineCount,
  };
}
