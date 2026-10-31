/**
 * Blank-line-delimited plain-text paragraphs. The scanner is intentionally small: a paragraph is a
 * maximal run of non-blank lines, and a request must sit wholly inside one run. A file with no
 * blank line has no paragraph delimiter, so it stays exact.
 */
import { splitVisibleLines } from "./text-lines.js";

export interface ParagraphSection {
  /** 1-indexed first line. */
  readonly start: number;
  /** 1-indexed last line. */
  readonly end: number;
}

/** The paragraph containing the requested 1-indexed window, or null when no single run does. */
export function findParagraph(
  text: string,
  requestedStart: number,
  requestedEnd: number,
): ParagraphSection | null {
  const lines = splitVisibleLines(text);
  if (requestedStart < 1 || requestedEnd < requestedStart || requestedEnd > lines.length)
    return null;

  let runStart = -1;
  let hasBlankLine = false;
  const paragraphs: ParagraphSection[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.trim() === "") {
      hasBlankLine = true;
      if (runStart >= 0) {
        paragraphs.push({ start: runStart + 1, end: index });
        runStart = -1;
      }
    } else if (runStart < 0) {
      runStart = index;
    }
  }
  if (runStart >= 0) paragraphs.push({ start: runStart + 1, end: lines.length });

  // WHY: a blank-free file is one run but has no paragraph delimiter; choose the exact read instead.
  if (!hasBlankLine) return null;
  return (
    paragraphs.find(
      (paragraph) => paragraph.start <= requestedStart && paragraph.end >= requestedEnd,
    ) ?? null
  );
}
