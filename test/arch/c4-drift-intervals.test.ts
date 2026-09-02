import { describe, expect, it } from "vitest";
import { computeDrift } from "../../src/drift";

describe("C4 drift interval-aware", () => {
  it("surfaces drift in the gap between two disjoint edit intervals", () => {
    // Served: 12 lines, hashes h00..h11, lines L00..L11
    // Edits: interval [2,4] and [10,10]  (1-indexed)
    // Drift: line 7 (served index 6) externally changed to X06
    // Old union approach [2,10] would incorrectly exclude gap lines 5..9 (served 4..8) and hide drift
    const served = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
    const originalLines = Array.from({ length: 12 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    // result: change L06 (index 6) to changed, keep rest
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
      range: intervals[0] as any, // legacy kept for compat should be ignored when intervals present
      reported: new Set<string>(),
    } as any);

    expect(drift).toBeDefined();
    // drift in gap must be reported, not hidden by union [2,10]
    expect(drift!.rows.some((r) => r.hash === "X06" || r.content === "changed-gap")).toBe(true);
    expect(drift!.text).toContain("X06");
  });

  it("still excludes edited intervals themselves from drift", () => {
    const served = ["h00", "h01", "h02", "h03", "h04"];
    const resultHashes = ["h00", "X01", "h02", "h03", "h04"];
    const resultLines = ["a", "changed", "c", "d", "e"];
    const intervals = [
      { startLine: 2, endLine: 2, startHash: "h01", endHash: "h01", delta: 0 },
    ];
    const drift = computeDrift({
      served,
      resultHashes,
      resultLines,
      intervals,
      reported: new Set<string>(),
    } as any);
    // hash X01 is inside edited interval at served index 1, so no drift outside range → undefined
    // but wait drift computation filters served hashes that are not in resultHashSet.
    // h01 is removed (not in resultHashes), so it would be counted unless excluded.
    // Since p=1 is in edited range, it should be excluded → no drift.
    expect(drift).toBeUndefined();
  });

  it("union regression: single range gap would hide drift (documents old bug)", () => {
    const served = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
    const resultHashes = served.slice();
    resultHashes[6] = "X06";
    const resultLines = Array.from({ length: 12 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    resultLines[6] = "changed-gap";

    // Simulate old buggy path: compute with single union range 2..10
    const union = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: { startLine: 2, endLine: 10, startHash: "h01", endHash: "h09", delta: 0 },
      reported: new Set<string>(),
    });
    // union hides gap → no drift reported (bug)
    expect(union).toBeUndefined();
  });
});
