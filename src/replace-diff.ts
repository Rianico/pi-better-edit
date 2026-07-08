import * as Diff from "diff";
import {
  _lineHashesPure,
  ANCHOR_LEN,
  HASH_SEP,
} from "./hashline";

export function detectEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(
  text: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function fmtDiffLine(
  prefix: " " | "+" | "-",
  line: string,
  hash: string | undefined,
): string {
  if (hash === undefined) {
    return `${prefix}${" ".repeat(ANCHOR_LEN)}${HASH_SEP}${line}`;
  }
  return `${prefix}${hash}${HASH_SEP}${line}`;
}

export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldHashes?: string[],
): { diff: string; firstChangedLine: number | undefined } {
  // Run Diff.diffLines on raw content only (no hash annotations) so that
  // lines whose content is identical are never reported as changed even
  // when their hash differs due to collision resolution or position
  // tracking. Hashes are used purely for display via fmtDiffLine.
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const effectiveOldHashes = oldHashes ?? _lineHashesPure(oldContent);
  const effectiveNewHashes = newContentHashes ?? _lineHashesPure(newContent);

  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    const displayLines = raw;

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (let k = 0; k < displayLines.length; k++) {
        if (part.added) {
          const hash = effectiveNewHashes[newLineNum - 1];
          output.push(fmtDiffLine("+", displayLines[k]!, hash));
          newLineNum++;
        } else {
          output.push(fmtDiffLine("-", displayLines[k]!, undefined));
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange =
      i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      let linesToShow = displayLines;
      let skipStart = 0;
      let skipEnd = 0;
      let skipMiddle = 0;

      if (!lastWasChange) {
        skipStart = Math.max(0, displayLines.length - contextLines);
        linesToShow = displayLines.slice(skipStart);
      } else if (nextPartIsChange && displayLines.length > contextLines * 2) {
        const tail = displayLines.slice(-contextLines);
        linesToShow = [...displayLines.slice(0, contextLines), "__ELLIPSIS__", ...tail];
        skipMiddle = displayLines.length - contextLines * 2;
      } else if (linesToShow.length > contextLines) {
        skipEnd = linesToShow.length - contextLines;
        linesToShow = linesToShow.slice(0, contextLines);
      }

      if (skipStart > 0) {
        output.push(" ...");
        oldLineNum += skipStart;
        newLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (line === "__ELLIPSIS__") {
          output.push(" ...");
          oldLineNum += skipMiddle;
          newLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        output.push(fmtDiffLine(" ", line, hash));
        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += displayLines.length;
      newLineNum += displayLines.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}
