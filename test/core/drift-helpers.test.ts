import { describe, expect, it } from "vitest";
import { currentPositionOfDrifted } from "../../src/served-session/drift-helpers.js";

/**
 * Characterization tests for the third rebase mechanism (CAND-9):
 * `currentPositionOfDrifted` maps a drifted served index to a current-file position by
 * stepping one line off the NEAREST SURVIVING served anchor (below first, then above),
 * and falls back to `servedIndex + delta` only when no served anchor survives — the
 * ADR-0023 position-fallback tier. They pin CURRENT semantics, weaknesses included, so
 * later consolidation can see the floor: "nearest" is nearest in SERVED-index space;
 * the below tier wins even when the above survivor is closer in current space; a
 * `surviving` hash absent from `currentPositions` yields NaN through the `!` assertion;
 * and the drifted slot's own anchor is never probed.
 * Ref: docs/.archive_adrs/0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md
 */
describe("currentPositionOfDrifted (characterization — ADR-0023 position-fallback rebase)", () => {
  it("uses the nearest surviving anchor below: its current position + 1", () => {
    const served = ["a01", "b02", "c03", "d04"];
    const currentPositions = new Map([
      ["a01", 0],
      ["b02", 5],
      ["c03", 6],
    ]);
    const surviving = new Set(["a01", "b02", "c03"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 3, 0)).toBe(7);
  });

  it("falls back to the nearest surviving anchor above when nothing survives below: current position - 1", () => {
    const served = ["g00", "h01", "i02"];
    const currentPositions = new Map([["i02", 9]]);
    const surviving = new Set(["i02"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 0, 2)).toBe(8);
  });

  it("prefers below over above even when the above anchor is nearer in current coordinates", () => {
    const served = ["a01", "X02", "b03"];
    const currentPositions = new Map([
      ["a01", 50],
      ["b03", 3],
    ]);
    const surviving = new Set(["a01", "b03"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 1, 0)).toBe(51);
  });

  it("skips null (never-served) slots while scanning for a survivor", () => {
    const served = ["a01", null, null, "b02", "c03"];
    const currentPositions = new Map([
      ["a01", 10],
      ["b02", 11],
    ]);
    const surviving = new Set(["a01", "b02"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 4, 0)).toBe(12);
  });

  it("never probes the drifted slot's own anchor — the scan starts strictly below/above", () => {
    const served = ["a01", "d02"];
    const currentPositions = new Map([["d02", 7]]);
    const surviving = new Set(["d02"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 1, -1)).toBe(0);
  });

  it("returns NaN when a surviving hash is absent from currentPositions (pinned fragility)", () => {
    const result = currentPositionOfDrifted(
      ["a01", "X02", "Z03"],
      new Map([["X02", 4]]),
      new Set(["a01"]),
      2,
      0,
    );
    expect(result).toBeNaN();
  });

  it("falls back to servedIndex + delta when no served anchor survives at all", () => {
    const served = ["a01", "b02", "c03"];
    expect(currentPositionOfDrifted(served, new Map(), new Set(), 1, -2)).toBe(-1);
  });

  it("handles an empty served array via the position fallback", () => {
    expect(currentPositionOfDrifted([], new Map(), new Set(), 0, 3)).toBe(3);
  });
});
