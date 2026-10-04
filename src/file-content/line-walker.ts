/**
 * Walking a file's lines, one page at a time.
 *
 * WHY: `split("\n")` buys line addressing with one heap string per line — ~4.56× the text, measured
 * WHY: in this repo's probe (a 45 MB text cost a 205 MB line array) — which a read that keeps a page
 * WHY: of rows never needs. `walkLines` yields the same lines as `splitLines` — same lines, same
 * WHY: order, same total — while retaining only the ranges the caller asked for.
 *
 * The walk is mode-agnostic by construction: text in, lines out. It knows nothing about render
 * modes, anchors, or served state, so every caller can adopt it without teaching it their language.
 */

/**
 * A 0-indexed, half-open range over the file's lines: `{ start: 1, end: 3 }` is the second and third
 * line. The range intersects the sequence — a range past the end is short or empty, a negative start
 * reads like 0.
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
   * The whole text's line count — `splitLines(text).length`, the same count a snapshot stores. A
   * terminal newline's trailing empty entry is a sentinel and is not a line; an empty text is its
   * one empty line (`visLines` reads that one as no lines at all — see `visibleLineTotal`).
   */
  total: number;
}

/**
 * Walks `text` once and returns the requested lines, without ever holding the whole sequence.
 *
 * `visit` receives every line in order with its index — how a caller assigns per-line state (the
 * served read's anchors) inside the same walk that selects the page, instead of splitting the text
 * again for it. Lines outside every range are still visited; they are only never retained.
 *
 * WHY: the sequence stops before the terminal newline's empty entry, because that entry is this
 * codebase's sentinel and not a line — `splitLines` counts it away, `visLines` never shows it, and
 * the anchors the served path assigns are per `splitLines` line. The walk visits exactly the lines
 * its callers count, so one line space stays one line space.
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
  const sentinel = text.endsWith("\n");
  let total = 0;
  let start = 0;
  for (;;) {
    const breakAt = text.indexOf("\n", start);
    if (breakAt === -1 && sentinel) return { ranges: wanted.map((range) => range.lines), total };
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
 * The number of lines a read can address — `visLines(text).length` — from the walk's total.
 *
 * WHY: `visLines` and `splitLines` differ in exactly one case: the empty text is one `splitLines`
 * entry and no lines at all. Everything else the sentinel rule already settled in the walk.
 */
export function visibleLineTotal(text: string, total: number): number {
  return text === "" ? 0 : total;
}

/**
 * The same count, derived from the newlines a decode counted instead of from a walk.
 *
 * WHY: the decode already tallies `\n` per chunk to enforce the anchor-space cap, so the cap needs no
 * WHY: second pass over the text to learn `visLines(text).length`. A terminal newline adds no line.
 */
export function visibleLineCount(text: string, newlineCount: number): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}
