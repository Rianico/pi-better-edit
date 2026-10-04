import * as Diff from "diff";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import { ANCHOR_LEN, HASH_SEP, defaultHashIdentity } from "./hashline/hash-identity.js";
import type { ServedRow } from "./hashline/served.js";

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

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
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
    const hash = effectiveNewHashes[newLineNum.value - 1];
    output.push(fmtDiffLine("+", displayLines[k]!, hash));
    if (hash !== undefined) servedRows.push({ position: newLineNum.value - 1, hash });
    newLineNum.value++;
  }
}
function pushRemovedLines(
  displayLines: string[],
  oldContentHashes: string[] | undefined,
  oldLineNum: { value: number },
  output: string[],
): void {
  const emit = (line: string): void => {
    const hash = oldContentHashes?.[oldLineNum.value - 1];
    output.push(fmtDiffLine("-", line, hash));
    oldLineNum.value++;
  };
  if (displayLines.length <= DIFF_REMOVED_CAP) {
    for (const line of displayLines) emit(line);
    return;
  }
  const omitted = displayLines.length - DIFF_REMOVED_EDGE * 2;
  for (const line of displayLines.slice(0, DIFF_REMOVED_EDGE)) emit(line);
  // WHY: ADR-0024 — the model sees the deletion's head, tail, and exact size; the hidden rows still
  // WHY: advance the cursor so every later row keeps its exact old line number and hash.
  // WHY: #169 — the marker's count is the exact deleted span and uses the unified `lines deleted` diction.
  output.push(` - ... [${omitted} lines deleted] ...`);
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
    // WHY: #170 — slice(-0) returns the whole array, so at context 0 the tail is taken
    // WHY: explicitly; the gap then renders marker-only with the count covering the full span.
    const tail = contextLines === 0 ? [] : displayLines.slice(-contextLines);
    linesToShow = [...displayLines.slice(0, contextLines), UNTOUCHED_MARKER, ...tail];
    skipMiddle = displayLines.length - contextLines * 2;
  } else if (!nextPartIsChange && linesToShow.length > contextLines) {
    // WHY: #166 — only trailing gaps may be sliced away silently; a middle gap renders whole
    // WHY: below 2×context, otherwise hidden rows would desync the anchors that follow it.
    linesToShow = linesToShow.slice(0, contextLines);
  }
  return { linesToShow, skipStart, skipMiddle };
}
/**
 * genDiff is the single diff projection (#169). Return contract:
 * - every emitted row's anchor equals the true new-file line content hash at that
 *   position; removed rows carry the true old-file hash when old hashes are provided.
 * - every emitted marker's count equals the span it hides:
 *   ` ... [N lines untouched] ...` advances both cursors past N hidden rows, keeping every FOLLOWING
 *   emitted anchor at its true file position; whether the hidden rows are addressable is a property
 *   of the serve that carries this projection (rows rendered through serve paths are leased there),
 *   not of this renderer, and ` - ... [N lines deleted] ...` advances the old cursor past
 *   N deleted rows (cursor-exact).
 * - collapse invariant: a middle gap smaller than 2×context renders whole (#166/#172);
 *   at context 0 every non-empty middle gap collapses to a single counted untouched
 *   marker (#170); bare ` ...` appears only at leading/trailing edges; added spans are never collapsed.
 * - servedRows mirror exactly the rendered context/addition rows (position + hash).
 * - `firstChangedLine`/`lastChangedLine` bracket the changed new-content lines (1-indexed,
 *   `lastChangedLine >= firstChangedLine` whenever either is set); a pure deletion names the
 *   position where the removed text sat, so an end-of-file deletion may name one line past the
 *   last new line — exactly as `firstChangedLine` already can, and both are absent on a no-op.
 */
export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
  // WHY: required only when the caller omits precomputed hashes — the diff
  // WHY: renderer must never derive content-only anchors for a file.
  filePath?: string,
): {
  diff: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  servedRows: ServedRow[];
} {
  const effectiveNewHashes =
    newContentHashes ??
    (filePath === undefined
      ? (() => {
          throw new DomainError("E_BAD_PAYLOAD", {
            message: "genDiff requires precomputed hashes or a file path.",
          });
        })()
      : defaultHashIdentity.hashesForSync(newContent, filePath));

  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const servedRows: ServedRow[] = [];
  let newLineNum = 1;
  let oldLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  let lastChangedLine: number | undefined;

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
        pushRemovedLines(displayLines, oldContentHashes, o, output);
        oldLineNum = o.value;
        lastChangedLine = newLineNum;
      }
      // WHY: a pure deletion names the position where the removed text sat, and an added part can
      // WHY: push nothing; clamping to `firstChangedLine` keeps last >= first for every consumer
      // WHY: that pairs them.
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
          // WHY: #169 — a hidden middle span is a counted `lines untouched` marker; both cursors
          // WHY: advance past the exact hidden count, so anchors after it stay aligned.
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

  return { diff: output.join("\n"), firstChangedLine, lastChangedLine, servedRows };
}
