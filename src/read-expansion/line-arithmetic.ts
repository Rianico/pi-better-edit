/**
 * Line arithmetic for span providers: character offsets in, 1-indexed line bounds out.
 *
 * WHY its own module with fixtures: every boundary off-by-one here silently loses a closing brace
 * (a node ending at column 0 becomes the NEXT line) or counts a CRLF as two breaks. Providers may
 * answer in offsets; `read` only accepts lines, so this is the one conversion they share.
 *
 * Offsets are 0-indexed and the end is exclusive, matching a node's half-open range. CRLF counts as
 * ONE line break, a lone CR counts as one, and a terminal newline is never a line of its own.
 */
interface LineSpan {
  /** 1-indexed first line. */
  startLine: number;
  /** 1-indexed last line, inclusive. */
  endLine: number;
}

function lineBreaksIn(text: string, endExclusive: number): number {
  let breaks = 0;
  for (let index = 0; index < endExclusive; index++) {
    const char = text.charCodeAt(index);
    if (char === 10) {
      breaks++;
      continue;
    }
    // WHY: CRLF is one break, not two. A CR whose LF is outside the slice is not a break yet:
    // WHY: an end offset at column 0 excludes the terminating LF and must not promote the line.
    if (char === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        if (index + 1 < endExclusive) {
          breaks++;
          index++;
        }
      } else {
        breaks++;
      }
    }
  }
  return breaks;
}

/**
 * The line span a half-open `[startOffset, endOffset)` range covers, or null when the range is
 * outside the text.
 *
 * A node ending at column 0 (`endOffset` is the first character of the following line) ends on the
 * line BEFORE it; a node ending on the last line with no trailing newline ends on that line.
 */
export function lineSpanForOffsets(
  text: string,
  startOffset: number,
  endOffset: number,
): LineSpan | null {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return null;
  if (startOffset < 0 || endOffset < startOffset || endOffset > text.length) return null;
  const startLine = lineBreaksIn(text, startOffset) + 1;
  if (endOffset === startOffset) return { startLine, endLine: startLine };
  // WHY: exclude the final character: when it is the newline that terminates the node's last line,
  // WHY: counting it would promote a column-0 end to the next line.
  const endLine = lineBreaksIn(text, endOffset - 1) + 1;
  return { startLine, endLine };
}
