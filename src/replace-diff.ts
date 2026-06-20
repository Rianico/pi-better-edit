import * as Diff from "diff";
import {
  computeLineHashes,
  ANCHOR_LENGTH,
} from "./hashline";


export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}


function formatDiffPreviewLine(
  prefix: " " | "+" | "-",
  line: string,
  hash: string | undefined,
): string {
  if (hash === undefined) {
    return `${prefix}${" ".repeat(ANCHOR_LENGTH)}│${line}`;
  }
  return `${prefix}${hash}│${line}`;
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const effectiveNewHashes = newContentHashes ?? computeLineHashes(newContent);

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          const hash = effectiveNewHashes[newLineNum - 1];
          output.push(formatDiffPreviewLine("+", line, hash));
          newLineNum++;
        } else {
          output.push(
            formatDiffPreviewLine("-", line, undefined),
          );
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange =
      i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      let linesToShow = raw;
      let skipStart = 0;
      let skipEnd = 0;
      let skipMiddle = 0;

      if (!lastWasChange) {
        skipStart = Math.max(0, raw.length - contextLines);
        linesToShow = raw.slice(skipStart);
      } else if (nextPartIsChange && raw.length > contextLines * 2) {
        const tail = raw.slice(-contextLines);
        linesToShow = [...raw.slice(0, contextLines), "__ELLIPSIS__", ...tail];
        skipMiddle = raw.length - contextLines * 2;
      } else if (linesToShow.length > contextLines) {
        skipEnd = linesToShow.length - contextLines;
        linesToShow = linesToShow.slice(0, contextLines);
      }

      if (skipStart > 0) {
        output.push(` ...`);
        oldLineNum += skipStart;
        newLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (line === "__ELLIPSIS__") {
          output.push(` ...`);
          oldLineNum += skipMiddle;
          newLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        output.push(formatDiffPreviewLine(" ", line, hash));

        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export interface CompactHashlineDiffPreview {
  preview: string;
  addedLines: number;
  removedLines: number;
}

type DiffPreviewKind = "context" | "addition" | "deletion";

function classifyDiffPreviewLine(line: string): DiffPreviewKind | null {
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith(" ")) return "context";
  return null;
}

function summarizeOmitted(count: number, label: string): string {
  return `... ${count} more ${label} line${count === 1 ? "" : "s"}`;
}

function collapseDiffPreviewRun(
  lines: string[],
  maxVisible: number,
  label: string,
): string[] {
  if (lines.length <= maxVisible) {
    return lines;
  }

  return [
    ...lines.slice(0, maxVisible),
    summarizeOmitted(lines.length - maxVisible, label),
  ];
}

export function buildCompactHashlineDiffPreview(
  diff: string,
  options: {
    maxUnchangedRun?: number;
    maxAdditionRun?: number;
    maxDeletionRun?: number;
    maxOutputLines?: number;
  } = {},
): CompactHashlineDiffPreview {
  const {
    maxUnchangedRun = 2,
    maxAdditionRun = 4,
    maxDeletionRun = 4,
    maxOutputLines = 12,
  } = options;

  if (!diff.trim()) {
    return { preview: "", addedLines: 0, removedLines: 0 };
  }

  const lines = diff.split("\n").filter((line) => line.length > 0);
  const previewLines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (let index = 0; index < lines.length; ) {
    const kind = classifyDiffPreviewLine(lines[index]!);
    let end = index + 1;
    while (end < lines.length && classifyDiffPreviewLine(lines[end]!) === kind) {
      end += 1;
    }

    const run = lines.slice(index, end);
    switch (kind) {
      case "addition":
        addedLines += run.length;
        previewLines.push(...collapseDiffPreviewRun(run, maxAdditionRun, "added"));
        break;
      case "deletion":
        removedLines += run.length;
        previewLines.push(...collapseDiffPreviewRun(run, maxDeletionRun, "removed"));
        break;
      case "context":
        previewLines.push(...collapseDiffPreviewRun(run, maxUnchangedRun, "unchanged"));
        break;
      default:
        previewLines.push(...run);
        break;
    }

    index = end;
  }

  if (previewLines.length > maxOutputLines) {
    const visibleLines = previewLines.slice(0, maxOutputLines);
    visibleLines.push(
      summarizeOmitted(previewLines.length - maxOutputLines, "preview"),
    );
    return {
      preview: visibleLines.join("\n"),
      addedLines,
      removedLines,
    };
  }

  return {
    preview: previewLines.join("\n"),
    addedLines,
    removedLines,
  };
}