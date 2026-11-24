/**
 * SAFETY: unserved-span-message — one pure formatter owns BOTH unserved-interior messages, so the
 * strict `[E_UNSERVED_RANGE]` refusal and the hint `[W_UNSERVED_INTERIOR]` applied warning cannot
 * drift in grammar, plural agreement or list compression. Voice is the only difference: the
 * summary clause and the trailing remedy. Every number is an absolute FILE line, and the list is
 * the `offset`/`limit` encoding itself, so no prose read instruction is needed. Imports only the
 * zero-import `./constants.js` leaf, which keeps `domain-errors` free of any store dependency.
 */
import { UNSERVED_LIST_MAX_RUNS } from "./constants.js";

type UnservedSpanMessageInput =
  | {
      /** The refusal voice: nothing was written, so nothing is promised. */
      voice: "strict";
      path?: string;
      unservedLines: readonly number[];
      /** The resolved span length the edit replaces (`rebasedLen` in `verifyRebasedSpan`). */
      replacedLineCount: number;
    }
  | {
      /** The applied voice: the edit committed and this names what it replaced unseen. */
      voice: "hint";
      unservedLines: readonly number[];
      /** The removed old-file lines in the diff (`removedLineCount` in `genDiff`). */
      replacedLineCount: number;
    };

const HINT_REMEDY =
  "Edits should only modify lines previously read and served (enforced under strict mode); " +
  "verify this uninspected replacement was intended.";

/**
 * Ascending, de-duplicated `[first, last]` runs. Sorting and dropping repeats here is what lets
 * every caller pass raw collection order without owning the compression contract.
 */
function runsOf(lines: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last === undefined) {
      runs.push([line, line]);
      continue;
    }
    if (line <= last[1]) continue;
    if (line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

const runWidth = ([first, last]: [number, number]): number => last - first + 1;

/**
 * The compressed absolute-line list: contiguous runs as `a-b`, comma-separated, capped at
 * `UNSERVED_LIST_MAX_RUNS` entries with the remaining LINE count appended. The cap spends its
 * budget on runs, because one long run is already one readable token.
 */
function unservedList(runs: ReadonlyArray<[number, number]>, lineCount: number): string {
  const shown = runs.slice(0, UNSERVED_LIST_MAX_RUNS);
  const entries = shown.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`));
  const hidden = lineCount - shown.reduce((total, run) => total + runWidth(run), 0);
  const label = lineCount === 1 ? "Unserved file line" : "Unserved file lines";
  const listed = entries.join(", ");
  if (hidden > 0) return `${label}: ${listed} (+${hidden} more ${hidden === 1 ? "line" : "lines"})`;
  return `${label}: ${listed}`;
}
const fileLines = (count: number): string => `${count} file ${count === 1 ? "line" : "lines"}`;

export function formatUnservedSpanMessage(input: UnservedSpanMessageInput): string {
  const runs = runsOf(input.unservedLines);
  const unserved = runs.reduce((total, run) => total + runWidth(run), 0);
  const agreement = unserved === 1 ? "was" : "were";
  const list = unservedList(runs, unserved);
  if (input.voice === "strict") {
    const where = input.path === undefined ? "" : ` to ${input.path}`;
    return (
      `Strict span mode refused the edit${where}: ${unserved} of the ` +
      `${fileLines(input.replacedLineCount)} it replaces ${agreement} never served.\n${list}`
    );
  }
  return (
    `Span replaced ${fileLines(input.replacedLineCount)}, ${unserved} of which ` +
    `${agreement} never served; the edit applied.\n${list}\n${HINT_REMEDY}`
  );
}
