/**
 * Drift is computed over the served lines OUTSIDE the edited intervals, not over the
 * union bounding them: a union [2,10] around edits at [2,4] and [10,10] would swallow
 * the gap and hide a real external change there. The last case pins that old shape as a
 * regression, so a future simplification back to one range fails here.
 */
import { describe, expect, it } from "vitest";
import { computeDrift } from "../../src/drift";

describe("C4 drift interval-aware", () => {
  it("surfaces drift in the gap between two disjoint edit intervals", () => {
    const served = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
    const originalLines = Array.from({ length: 12 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    const resultLines = originalLines.slice();
    resultLines[6] = "changed-gap";
    const resultHashes = served.slice();
    resultHashes[6] = "X06";

    const intervals = [
      { startLine: 2, endLine: 4, startHash: "h01", endHash: "h03", delta: 0 },
      { startLine: 10, endLine: 10, startHash: "h09", endHash: "h09", delta: 0 },
    ];

    const drift = computeDrift({
      served,
      resultHashes,
      resultLines,
      intervals,
      range: intervals[0] as any,
      reported: new Set<string>(),
    } as any);

    expect(drift).toBeDefined();
    expect(drift!.rows.some((r) => r.hash === "X06" || r.content === "changed-gap")).toBe(true);
    expect(drift!.text).toContain("X06");
  });

  it("still excludes edited intervals themselves from drift", () => {
    const served = ["h00", "h01", "h02", "h03", "h04"];
    const resultHashes = ["h00", "X01", "h02", "h03", "h04"];
    const resultLines = ["a", "changed", "c", "d", "e"];
    const intervals = [{ startLine: 2, endLine: 2, startHash: "h01", endHash: "h01", delta: 0 }];
    const drift = computeDrift({
      served,
      resultHashes,
      resultLines,
      intervals,
      reported: new Set<string>(),
    } as any);
    expect(drift).toBeUndefined();
  });

  it("union regression: single range gap would hide drift (documents old bug)", () => {
    const served = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
    const resultHashes = served.slice();
    resultHashes[6] = "X06";
    const resultLines = Array.from({ length: 12 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    resultLines[6] = "changed-gap";

    const union = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: { startLine: 2, endLine: 10, startHash: "h01", endHash: "h09", delta: 0 },
      reported: new Set<string>(),
    });
    expect(union).toBeUndefined();
  });
});
