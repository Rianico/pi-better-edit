import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff";
import { ANCHOR_LEN, HASH_SEP } from "../../src/hashline/hash-identity";
import type { ServedRow } from "../../src/hashline/served";
import { _lineHashesPure, initHasher } from "../../src/hashline";

beforeAll(async () => {
  await initHasher();
});

const splitLines = (content: string): string[] => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const UNTOUCHED_MARKER = /^ \.\.\. \[(\d+) lines untouched\] \.\.\.$/;
const DELETED_MARKER = /^ - \.\.\. \[(\d+) lines deleted\] \.\.\.$/;

function gapCase(gapSize: number): { oldContent: string; newContent: string } {
  const gap = Array.from({ length: gapSize }, (_, i) => `g${i + 1}`);
  const oldContent = ["a", "b", ...gap, "c", "d"].join("\n") + "\n";
  const newContent = ["a", "B", ...gap, "C", "d"].join("\n") + "\n";
  return { oldContent, newContent };
}

function deletedRunCase(runSize: number): { oldContent: string; newContent: string } {
  const run = Array.from({ length: runSize }, (_, i) => `x${i + 1}`);
  return {
    oldContent: ["top", ...run, "bottom"].join("\n") + "\n",
    newContent: ["top", "bottom"].join("\n") + "\n",
  };
}

// Audits the full #169 projection contract of one emitted projection:
// every anchor row's hash equals the true new-file (resp. old-file) line content hash at the
// position its cursor says it occupies, every marker's count is the exact span it hides, and
// servedRows mirror exactly the rendered context/addition rows.
function auditProjection(oldContent: string, newContent: string, contextLines: number) {
  const newHashes = _lineHashesPure(newContent);
  const oldHashes = _lineHashesPure(oldContent);
  const newLines = splitLines(newContent);
  const oldLines = splitLines(oldContent);
  const { diff, servedRows } = genDiff(oldContent, newContent, contextLines, newHashes, oldHashes);

  let newPos = 0;
  let oldPos = 0;
  const renderedRows: ServedRow[] = [];
  const rows = diff.split("\n");
  rows.forEach((line, idx) => {
    const at = `context=${contextLines} row ${idx} ${JSON.stringify(line)}`;
    if (line === " ...") {
      // Leading-edge silent trim (#169 exception): the bare ellipsis hides an uncounted span.
      // Recover its length by matching the next anchored row against the true hashes, and
      // require the hidden span to be identical untouched context on both sides.
      expect(idx, `${at}: bare ellipsis away from the leading edge`).toBe(0);
      const next = rows[idx + 1];
      if (next === undefined) expect.fail(`${at}: ellipsis without a following row`);
      const nextPrefix = next[0];
      const nextHash = next.slice(1, 1 + ANCHOR_LEN);
      const nextText = next.slice(1 + ANCHOR_LEN + HASH_SEP.length);
      const onNewSide = nextPrefix === " " || nextPrefix === "+";
      const hashes = onNewSide ? newHashes : oldHashes;
      const lines = onNewSide ? newLines : oldLines;
      const pos = onNewSide ? newPos : oldPos;
      let jump = 1;
      while (
        jump < lines.length &&
        !(lines[pos + jump] === nextText && hashes[pos + jump] === nextHash)
      ) {
        jump++;
      }
      expect(lines[pos + jump], `${at}: ellipsis hides no anchorable row`).toBe(nextText);
      for (let k = 0; k < jump; k++) {
        expect(oldLines[oldPos + k], `${at}: ellipsis hides a changed row`).toBe(
          newLines[newPos + k],
        );
      }
      newPos += jump;
      oldPos += jump;
      return;
    }
    const untouched = UNTOUCHED_MARKER.exec(line);
    if (untouched) {
      // The hidden span must be lease-covered and exact: the audit advances both cursors by
      // exactly the stated count and later anchor rows must still carry true hashes.
      newPos += Number(untouched[1]);
      oldPos += Number(untouched[1]);
      return;
    }
    const deleted = DELETED_MARKER.exec(line);
    if (deleted) {
      oldPos += Number(deleted[1]);
      return;
    }
    const prefix = line[0];
    const hash = line.slice(1, 1 + ANCHOR_LEN);
    const text = line.slice(1 + ANCHOR_LEN + HASH_SEP.length);
    if (prefix === " ") {
      expect(hash, at).toBe(newHashes[newPos]);
      expect(text, at).toBe(newLines[newPos]);
      renderedRows.push({ position: newPos, hash });
      newPos++;
      oldPos++;
      return;
    }
    if (prefix === "+") {
      expect(hash, at).toBe(newHashes[newPos]);
      expect(text, at).toBe(newLines[newPos]);
      renderedRows.push({ position: newPos, hash });
      newPos++;
      return;
    }
    if (prefix === "-") {
      expect(hash, at).toBe(oldHashes[oldPos]);
      expect(text, at).toBe(oldLines[oldPos]);
      oldPos++;
      return;
    }
    expect.fail(`${at}: unrecognised projection row`);
  });

  // Cursors walking the projection must land exactly at each file's end, or stop short by the
  // same untouched trailing span (the trailing-edge silent trim exception): any marker count
  // that disagrees with its hidden span, or any desynced anchor, lands short or overshoots.
  const newShort = newLines.length - newPos;
  const oldShort = oldLines.length - oldPos;
  expect(oldShort, `context=${contextLines}: old cursor`).toBe(newShort);
  expect(newShort, `context=${contextLines}: new cursor past the file end`).toBeGreaterThanOrEqual(
    0,
  );
  for (let k = 0; k < newShort; k++) {
    expect(oldLines[oldPos + k], `context=${contextLines}: trailing trim hides a change`).toBe(
      newLines[newPos + k],
    );
  }
  expect(servedRows, `context=${contextLines}: servedRows`).toEqual(renderedRows);
  return diff;
}

describe("projection contract audit — middle-gap corpus (#169/#170)", () => {
  for (const contextLines of [0, 1, 2, 4]) {
    const boundary = 2 * contextLines;
    const corpus = [
      { gap: boundary, whole: true },
      { gap: boundary + 1, whole: false, hidden: 1 },
      { gap: boundary + 275, whole: false, hidden: 275 },
    ];
    for (const { gap, whole, hidden } of corpus) {
      it(`gap ${gap} at context ${contextLines} keeps every anchor aligned`, () => {
        const { oldContent, newContent } = gapCase(gap);
        const diff = auditProjection(oldContent, newContent, contextLines);
        const markers = diff.split("\n").filter((line) => UNTOUCHED_MARKER.test(line));
        if (whole) {
          // #166/#172 guard: a middle gap below 2×context+1 renders whole — no collapse marker.
          expect(markers).toEqual([]);
        } else {
          expect(markers).toEqual([` ... [${hidden} lines untouched] ...`]);
        }
      });
    }
  }

  it("emits no bare ellipsis inside a middle gap", () => {
    for (const contextLines of [1, 2, 4]) {
      const { oldContent, newContent } = gapCase(2 * contextLines + 1);
      const { diff } = genDiff(
        oldContent,
        newContent,
        contextLines,
        _lineHashesPure(newContent),
        _lineHashesPure(oldContent),
      );
      expect(diff.split("\n").filter((line) => line === " ...")).toEqual([]);
    }
  });

  it("gate 1: a middle gap hiding exactly 275 lines renders ` ... [275 lines untouched] ...` with aligned anchors", () => {
    // context 2 → the gap must be 275 + 2×2 rows so the hidden span is exactly 275.
    const { oldContent, newContent } = gapCase(279);
    const diff = auditProjection(oldContent, newContent, 2);
    const rows = diff.split("\n");
    const markerIdx = rows.findIndex((line) => UNTOUCHED_MARKER.test(line));
    expect(rows[markerIdx]).toBe(" ... [275 lines untouched] ...");
    const hashes = _lineHashesPure(newContent);
    expect(rows[markerIdx - 1]).toBe(` ${hashes[3]}│g2`);
    expect(rows[markerIdx + 1]).toBe(` ${hashes[279]}│g278`);
  });

  it("gate 3: a ctx-0 middle-gap marker count equals the hidden span and the next anchors carry the true hashes at the advanced positions (#175)", () => {
    // Negative control for the renderer-guarantee half of the contract: a perturbed hidden
    // count changes the marker text and desyncs the anchors that follow it — both fail here.
    const { oldContent, newContent } = gapCase(5);
    const diff = auditProjection(oldContent, newContent, 0);
    const rows = diff.split("\n");
    const markerIdx = rows.findIndex((line) => UNTOUCHED_MARKER.test(line));
    expect(rows[markerIdx]).toBe(" ... [5 lines untouched] ...");
    const newHashes = _lineHashesPure(newContent);
    const oldHashes = _lineHashesPure(oldContent);
    // Both cursors land on `c`/`C` at index 2+5: the next emitted anchors are their true hashes.
    expect(rows[markerIdx + 1]).toBe(`-${oldHashes[7]}│c`);
    expect(rows[markerIdx + 2]).toBe(`+${newHashes[7]}│C`);
  });
});

describe("projection contract audit — deleted-run corpus (#169/#170)", () => {
  // Context 0 exercises the leading/trailing edge trims alongside the deleted-span markers.
  for (const contextLines of [0, 1, 2]) {
    for (const run of [7, 12, 40]) {
      it(`deleted run ${run} at context ${contextLines} keeps old-side anchors aligned`, () => {
        const { oldContent, newContent } = deletedRunCase(run);
        const diff = auditProjection(oldContent, newContent, contextLines);
        const expected = ` - ... [${run - 4} lines deleted] ...`;
        expect(diff.split("\n").filter((line) => DELETED_MARKER.test(line))).toEqual([expected]);
      });
    }
  }

  it("gate 2: a large deleted run renders ` - ... [36 lines deleted] ...` with exact N and aligned old-side anchors", () => {
    const { oldContent, newContent } = deletedRunCase(40);
    const diff = auditProjection(oldContent, newContent, 1);
    const rows = diff.split("\n");
    const markerIdx = rows.findIndex((line) => DELETED_MARKER.test(line));
    expect(rows[markerIdx]).toBe(" - ... [36 lines deleted] ...");
    // The two tail rows after the marker keep their true old-file hashes (the run is x1..x40).
    const oldHashes = _lineHashesPure(oldContent);
    expect(rows[markerIdx + 1]).toBe(`-${oldHashes[39]}│x39`);
    expect(rows[markerIdx + 2]).toBe(`-${oldHashes[40]}│x40`);
  });
});
