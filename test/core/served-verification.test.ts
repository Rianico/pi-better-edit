import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { contentOnlyHashes } from "../../src/hashline/hash";
import {
  buildRangeServeRows,
  denseServeRows,
  fmtServedRows,
  servedPositionsOf,
} from "../../src/hashline/served-verification";

beforeAll(async () => {
  await initHasher();
});

describe("served-verification helpers", () => {
  it("serves rows as position + hash only; canon evidence is never a row attribute", () => {
    const hashesA = contentOnlyHashes("a\nb\nc");
    const rowsA = buildRangeServeRows(1, 3, hashesA);
    // WHY: canon evidence is derived from the leases a serve grants (#151), so a row carries no canon
    // WHY: and a producer holding the file's lines has nothing extra to stamp (issue #149).
    expect(rowsA).toEqual([
      { position: 0, hash: hashesA[0] },
      { position: 1, hash: hashesA[1] },
      { position: 2, hash: hashesA[2] },
    ]);
  });

  it("servedPositionsOf / buildRangeServeRows / fmtServedRows remain accessible", () => {
    const hashes = ["aaa", "bbb", "ccc"];
    const lines = ["a", "b", "c"];
    const served = ["aaa", null, "ccc"];
    expect(servedPositionsOf(served, "aaa")).toEqual([0]);
    expect(servedPositionsOf(served, "bbb")).toEqual([]);
    const rows = buildRangeServeRows(1, 2, hashes);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.hash).toBe("aaa");
    const formatted = fmtServedRows(rows, lines);
    expect(formatted).toContain("aaa│a");
  });
});

describe("denseServeRows — the sole owner of the dense serve-row projection", () => {
  it("projects one row per hash with 0-based positions aligned to array order", () => {
    expect(denseServeRows(["aaa", "bbb", "ccc"])).toEqual([
      { position: 0, hash: "aaa" },
      { position: 1, hash: "bbb" },
      { position: 2, hash: "ccc" },
    ]);
  });

  it("empty hashes project to empty rows", () => {
    expect(denseServeRows([])).toEqual([]);
  });
});
