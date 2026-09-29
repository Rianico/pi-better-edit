import { describe, expect, it } from "vitest";
import { currentPositionOfDrifted } from "../../src/served-session/drift-helpers.js";

/**
 * Characterization tests for the third rebase mechanism (CAND-9): `currentPositionOfDrifted`
 * maps a drifted served index to a current-file position by taking the NEAREST SURVIVING
 * served anchor (below first, then above) and stepping one line off its current position;
 * only when no served anchor survives at all does it fall back to `servedIndex + delta` —
 * the ADR-0023 position-fallback tier. These tests pin CURRENT semantics, including the
 * known weaknesses, so later consolidation work can see the floor:
 *
 * - "nearest" is nearest in SERVED-index space, ignoring current coordinates entirely;
 * - the below-survivor tier wins even when the above survivor is closer in current space
 *   (the result may even exceed the above anchor's current position);
 * - a hash that is `surviving` but absent from `currentPositions` yields NaN
 *   (non-null assertion `!` on a missing map entry);
 * - the drifted position's own slot is never probed, even when it holds a survivor.
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
    // Drifted at served index 3; nearest below survivor is "c03" at index 2.
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 3, 0)).toBe(7);
  });

  it("falls back to the nearest surviving anchor above when nothing survives below: current position - 1", () => {
    const served = ["g00", "h01", "i02"];
    const currentPositions = new Map([["i02", 9]]);
    const surviving = new Set(["i02"]);
    // Drifted at served index 0; no survivor below, first survivor above is index 2.
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 0, 2)).toBe(8);
  });

  it("prefers below over above even when the above anchor is nearer in current coordinates", () => {
    const served = ["a01", "X02", "b03"];
    // Below survivor sits at current 50, above survivor at current 3 — the below tier wins first.
    const currentPositions = new Map([
      ["a01", 50],
      ["b03", 3],
    ]);
    const surviving = new Set(["a01", "b03"]);
    // WEAKNESS (pinned): result 51 places the drifted line *after* the above anchor at 3.
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
    // "d02" survives in the current file (ambiguous-hash shape), but the helper does not check
    // the drifted slot itself; only the below scan at index 0 can answer.
    const currentPositions = new Map([["d02", 7]]);
    const surviving = new Set(["d02"]);
    // Below: none (index 0 holds "a01", not surviving). Above from index 1: none.
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 1, -1)).toBe(0);
  });

  it("returns NaN when a surviving hash is absent from currentPositions (pinned fragility)", () => {
    // "a01" is declared surviving but the map was built without it — WEAKNESS (pinned):
    // the `get(...)!` non-null assertion turns this into NaN, which then fails the
    // caller's in-range check and lands the line in the unshown bucket.
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
