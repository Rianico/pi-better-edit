/**
 * The unserved-removal mirror in the diff projection (ticket #305). `genDiff`'s optional 7th argument
 * is the pre-batch positional served mirror in ORIGINAL line coordinates: a `null` slot renders that
 * removed row with the empty 4-space gutter, an absent slot keeps today's anchor, and the folded
 * deleted-span marker counts only the unserved rows it hides.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "../../src/constants.js";
import { contentOnlyHashes, initHasher } from "../../src/hashline/hash-identity.js";

beforeAll(async () => {
  await initHasher();
});

const mixedCase = () => {
  const oldContent = ["a", "b", "c", "d"].join("\n") + "\n";
  const newContent = ["a", "B", "c", "e"].join("\n") + "\n";
  return {
    oldContent,
    newContent,
    oldHashes: contentOnlyHashes(oldContent),
    newHashes: contentOnlyHashes(newContent),
  };
};

const foldedCase = () => {
  const run = Array.from({ length: DIFF_REMOVED_CAP + 2 }, (_, i) => `x${i + 1}`);
  const oldContent = ["top", ...run, "bottom"].join("\n") + "\n";
  const newContent = ["top", "bottom"].join("\n") + "\n";
  return {
    oldContent,
    newContent,
    oldHashes: contentOnlyHashes(oldContent),
    newHashes: contentOnlyHashes(newContent),
    omitted: run.length - DIFF_REMOVED_EDGE * 2,
    foldedStart: 1 + DIFF_REMOVED_EDGE,
  };
};

describe("genDiff served mirror", () => {
  it("renders byte-identically when no mirror is supplied", () => {
    const { oldContent, newContent, oldHashes, newHashes } = mixedCase();

    const withoutSeventh = genDiff(oldContent, newContent, 2, newHashes, oldHashes);
    const withUndefinedMirror = genDiff(
      oldContent,
      newContent,
      2,
      newHashes,
      oldHashes,
      undefined,
      undefined,
    );

    expect(withUndefinedMirror.diff).toBe(withoutSeventh.diff);
    expect(withUndefinedMirror.servedRows).toEqual(withoutSeventh.servedRows);
    expect(withUndefinedMirror.diff).toBe(
      [
        ` ${newHashes[0]}│a`,
        `-${oldHashes[1]}│b`,
        `+${newHashes[1]}│B`,
        ` ${newHashes[2]}│c`,
        `-${oldHashes[3]}│d`,
        `+${newHashes[3]}│e`,
      ].join("\n"),
    );
  });

  it("blanks the gutter of a removed row whose slot is null and keeps an anchor elsewhere", () => {
    const { oldContent, newContent, oldHashes, newHashes } = mixedCase();
    const served: (string | null)[] = oldHashes.map(() => "AAAA");
    served[1] = null;

    const rows = genDiff(
      oldContent,
      newContent,
      2,
      newHashes,
      oldHashes,
      undefined,
      served,
    ).diff.split("\n");

    expect(rows).toContain("-    │b");
    expect(rows).toContain(`-${oldHashes[3]}│d`);
    for (const row of rows.filter((line) => line.includes("│"))) {
      expect(row.indexOf("│")).toBe(5);
    }
  });

  it("keeps the anchor when the mirror is truncated rather than null-padded", () => {
    const { oldContent, newContent, oldHashes, newHashes } = mixedCase();
    const truncated: (string | null)[] = oldHashes.slice(0, 1);

    const rows = genDiff(
      oldContent,
      newContent,
      2,
      newHashes,
      oldHashes,
      undefined,
      truncated,
    ).diff.split("\n");

    expect(rows).toContain(`-${oldHashes[1]}│b`);
    expect(rows).toContain(`-${oldHashes[3]}│d`);
  });

  it("counts only the unserved rows the folded deleted-span marker hides", () => {
    const { oldContent, newContent, oldHashes, newHashes, omitted, foldedStart } = foldedCase();
    const served: (string | null)[] = oldHashes.map(() => null);
    served[foldedStart + 1] = "AAAA";

    const rows = genDiff(
      oldContent,
      newContent,
      2,
      newHashes,
      oldHashes,
      undefined,
      served,
    ).diff.split("\n");

    expect(rows).toContain(` - ... [${omitted} lines deleted (${omitted - 1} unserved)] ...`);
    expect(rows.filter((line) => line.startsWith("-"))).toEqual([
      "-    │x1",
      "-    │x2",
      `-    │x${DIFF_REMOVED_CAP + 1}`,
      `-    │x${DIFF_REMOVED_CAP + 2}`,
    ]);
  });

  it("leaves the folded marker unchanged when every folded row was served", () => {
    const { oldContent, newContent, oldHashes, newHashes, omitted, foldedStart } = foldedCase();
    const served: (string | null)[] = oldHashes.map(() => null);
    for (let k = 0; k < omitted; k++)
      served[foldedStart + k] = oldHashes[foldedStart + k] ?? "AAAA";

    const rows = genDiff(
      oldContent,
      newContent,
      2,
      newHashes,
      oldHashes,
      undefined,
      served,
    ).diff.split("\n");

    expect(rows).toContain(` - ... [${omitted} lines deleted] ...`);
    expect(rows.some((line) => line.includes("unserved"))).toBe(false);
  });

  it("reports every unserved removed line, cap-independent and ascending", () => {
    const { oldContent, newContent, oldHashes, newHashes } = foldedCase();
    const allNull: (string | null)[] = oldHashes.map(() => null);

    const withoutMirror = genDiff(oldContent, newContent, 2, newHashes, oldHashes);
    const folded = genDiff(oldContent, newContent, 2, newHashes, oldHashes, undefined, allNull);
    expect(withoutMirror.unservedRemovedLines).toEqual([]);
    expect(folded.unservedRemovedLines).toEqual(
      Array.from({ length: DIFF_REMOVED_CAP + 2 }, (_, i) => i + 2),
    );
    expect(
      folded.unservedRemovedLines.every((line, i, all) => i === 0 || line > (all[i - 1] as number)),
    ).toBe(true);
  });

  it("reports the removed old-line count independently of the fold cap and the mirror", () => {
    const { oldContent, newContent, oldHashes, newHashes } = foldedCase();
    const allNull: (string | null)[] = oldHashes.map(() => null);

    const withoutMirror = genDiff(oldContent, newContent, 2, newHashes, oldHashes);
    const folded = genDiff(oldContent, newContent, 2, newHashes, oldHashes, undefined, allNull);
    const unchanged = genDiff(oldContent, oldContent, 2, oldHashes, oldHashes);

    expect(withoutMirror.removedLineCount).toBe(DIFF_REMOVED_CAP + 2);
    expect(folded.removedLineCount).toBe(DIFF_REMOVED_CAP + 2);
    expect(unchanged.removedLineCount).toBe(0);
  });
});
