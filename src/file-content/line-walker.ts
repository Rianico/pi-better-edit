/**
 * Walking a file's lines, one page at a time.
 *
 * WHY: `split("\n")` buys line addressing with one heap string per line — ~4.56× the text, measured
 * WHY: in this repo's probe (a 45 MB text cost a 205 MB line array) — which a read that keeps a
 * WHY: page of rows never needs. `walkLines` yields the SAME line sequence as `split("\n")` — same
 * WHY: lines, same order, same total — while retaining only the ranges the caller asked for.
 *
 * The walk is mode-agnostic by construction: text in, lines out. It knows nothing about render
 * modes, anchors, or served state, so every caller can adopt it without teaching it their language.
 */

/**
 * A 0-indexed, half-open range over `split("\n")`'s line sequence: `{ start: 1, end: 3 }` is the
 * second and third entries. The range intersects the sequence — ends clamp, a range outside it is
 * empty, and a negative start reads like 0.
 *
 * This is not a `ReadWindow`: a window is the reader's 1-indexed `offset`/`limit` request, and more
 * than one window can land on the same line. A `LineRange` is what that request means to the walk.
 */
export interface LineRange {
  start: number;
  end: number;
}

/** What one walk saw: the lines each range asked for, and the sequence's total. */
export interface LineWalk {
  /** One array per requested range, in request order. */
  ranges: string[][];
  /**
   * The whole text's `split("\n")` entry count — a terminal newline's trailing empty entry and an
   * empty text's single entry included, so a caller can use it wherever it would have used
   * `splitLines(text).length`.
   */
  total: number;
}

/**
 * Walks `text` once and returns the requested lines, without ever holding the whole sequence.
 *
 * `visit` receives every line in order with its index — how a caller assigns per-line state (the
 * served read's anchors) inside the same walk that selects the page, instead of splitting the text
 * again for it. Lines outside every range are still visited; they are only never retained.
 */
export function walkLines(
  text: string,
  ranges: readonly LineRange[] = [],
  visit?: (line: string, index: number) => void,
): LineWalk {
  const wanted = ranges.map((range) => ({
    start: range.start,
    end: range.end,
    lines: [] as string[],
  }));
  // WHY: past the last line any range asked for, the walk only counts — no line is sliced.
  const lastWanted = wanted.reduce((last, range) => Math.max(last, range.end - 1), -1);
  let total = 0;
  let start = 0;
  for (;;) {
    const breakAt = text.indexOf("\n", start);
    const end = breakAt === -1 ? text.length : breakAt;
    let line: string | undefined;
    if (total <= lastWanted) {
      for (const range of wanted) {
        if (total >= range.start && total < range.end) {
          line ??= text.slice(start, end);
          range.lines.push(line);
        }
      }
    }
    if (visit) visit((line ??= text.slice(start, end)), total);
    total++;
    if (breakAt === -1) return { ranges: wanted.map((range) => range.lines), total };
    start = breakAt + 1;
  }
}

/**
 * The number of lines a read can address: `visLines(text).length`, derived from a `split("\n")`
 * total instead of from a materialized array.
 *
 * WHY: the terminal newline is a sentinel, not a line — `"a\nb\n"` has three `split` entries and two
 * WHY: lines — and an empty text has one `split` entry and no lines at all.
 */
export function visibleLineTotal(text: string, total: number): number {
  return text === "" || text.endsWith("\n") ? total - 1 : total;
}
