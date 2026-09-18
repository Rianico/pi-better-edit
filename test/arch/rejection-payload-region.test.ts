import { describe, expect, it, beforeAll } from "vitest";
import {
  makeServedRejection,
  makeTargetLostRejection,
  ServedRejectionError,
} from "../../src/hashline/served-verification";
import { initHasher } from "../../src/hashline/hasher";

beforeAll(async () => {
  await initHasher();
});

function snapshotFor(lines: string[]) {
  return {
    fileHashes: lines.map((_, i) => `H0${i}`),
    fileLines: lines,
    filePath: "sample.ts",
  };
}

describe("rejection payload region rule (ADR-0018 decision 4, spec D5)", () => {
  it("every [E_TARGET_LOST] payload carries zero rows", () => {
    const err = makeTargetLostRejection({
      headline: "line 3 in sample.ts no longer resolves to the line identity it was served with.",
      servedLine: 3,
      snapshot: snapshotFor(["alpha", "beta", "delta"]),
    });
    expect(err).toBeInstanceOf(ServedRejectionError);
    expect(err.code).toBe("E_TARGET_LOST");
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).not.toContain("Current range:");
    expect(err.message).not.toMatch(/^[A-Za-z0-9]{3}│/m);
  });

  it("every [E_STALE_RANGE] payload carries at least one row", () => {
    const err = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 in sample.ts differs from what was served.",
      startLine: 1,
      endLine: 3,
      snapshot: snapshotFor(["alpha", "BETA", "gamma"]),
    });
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.servedRows.length).toBeGreaterThan(0);
    expect(err.message).toContain("Current range:");
    expect(err.message).toContain("Retry with these anchors");
  });

  it("the two codes are disjoint by payload shape", () => {
    const lost = makeTargetLostRejection({
      headline: "line 2 in sample.ts no longer resolves to the line identity it was served with.",
      servedLine: 2,
      snapshot: snapshotFor(["a", "b"]),
    });
    const stale = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 in sample.ts differs from what was served.",
      startLine: 1,
      endLine: 2,
      snapshot: snapshotFor(["a", "b"]),
    });
    expect(lost.servedRows).toHaveLength(0);
    expect(stale.servedRows.length).toBeGreaterThan(0);
    expect(new Set([lost.code, stale.code])).toEqual(new Set(["E_TARGET_LOST", "E_STALE_RANGE"]));
  });

  it("a target-lost headline names the served coordinate, never a content match", () => {
    const err = makeTargetLostRejection({
      headline: "line 2 in sample.ts no longer resolves to the line identity it was served with.",
      servedLine: 2,
      snapshot: snapshotFor(["alpha", "BETA", "gamma", "beta"]),
    });
    expect(err.message).toMatch(/line 2 in sample\.ts/);
    expect(err.message).not.toMatch(/line 4/);
    expect(err.firstOffendingLine).toBe(2);
  });
});
