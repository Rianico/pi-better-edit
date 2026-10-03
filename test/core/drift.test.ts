import { describe, expect, it } from "vitest";
import { computeDrift, driftEpisodeKey } from "../../src/drift";
import { canonDigest } from "../../src/hashline/hash-identity.js";

describe("computeDrift", () => {
  it("returns undefined when nothing drifted outside the range", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["h00", "h01", "h02"],
      resultLines: ["a", "b", "c"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("reports an in-place drift below the range with its post-edit content", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(false);
    expect(result!.rows).toEqual([
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changed", drifted: true },
    ]);
    expect(result!.text).toContain("drift:");
    expect(result!.text).toContain("X03│changed");
  });

  it("excludes the resolved range even when a boundary line was deleted", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03", "h04"],
      resultHashes: ["h00", "h01", "X03", "h04"],
      resultLines: ["a", "b", "x", "d"],
      range: {
        startLine: 3,
        endLine: 4,
        startHash: "h02",
        endHash: "h03",
        delta: -1,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("applies the edit's positional shift to served entries below the range", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03", "h04"],
      resultHashes: ["h00", "h01", "h03", "X04"],
      resultLines: ["a", "b", "d", "shifted"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: -1,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.rows).toEqual([
      { position: 2, hash: "h03", content: "d", drifted: false },
      { position: 3, hash: "X04", content: "shifted", drifted: true },
    ]);
  });

  it("keeps positions of served entries above the range regardless of delta", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["h00", "X01", "h02"],
      resultLines: ["a", "changed", "c"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: -5,
      },
      reported: new Set(),
    });
    expect(result!.rows).toEqual([
      { position: 0, hash: "h00", content: "a", drifted: false },
      { position: 1, hash: "X01", content: "changed", drifted: true },
      { position: 2, hash: "h02", content: "c", drifted: false },
    ]);
  });

  it("counts served entries shifted out of the file as drifted without rows", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["X02"],
      resultLines: ["c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: -2,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([{ position: 0, hash: "X02", content: "c", drifted: true }]);
  });

  it("emits a one-line pointer when every drifted line is already reported", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set([driftEpisodeKey(3)]),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(true);
    expect(result!.rows).toEqual([]);
    expect(result!.text).toContain("already reported");
    expect(result!.text).not.toContain("│");
  });

  it("shows a full notice with rows for all drifted lines when any is not yet reported", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["X00", "h01", "h02", "X03"],
      resultLines: ["changedA", "b", "c", "changedD"],
      range: {
        startLine: 2,
        endLine: 2,
        startHash: "h01",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set([driftEpisodeKey(3)]),
    });
    expect(result).toBeDefined();
    expect(result!.allAlreadyReported).toBe(false);
    expect(result!.rows).toEqual([
      { position: 0, hash: "X00", content: "changedA", drifted: true },
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changedD", drifted: true },
    ]);
  });

  it("caps the total shown rows (drifted + context) and appends a hint for the remainder", () => {
    const served: (string | null)[] = [];
    const resultHashes: string[] = [];
    const resultLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      served.push(`h${i}`);
      resultHashes.push(i % 2 === 0 ? `h${i}` : `R${i}`);
      resultLines.push(`line ${i}`);
    }
    const result = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h0",
        endHash: "h0",
        delta: 0,
      },
      reported: new Set(),
      cap: 150,
    });
    expect(result).toBeDefined();
    expect(result!.rows).toHaveLength(150);
    expect(result!.total).toBe(100);
    expect(result!.text).toContain("[... 50 more");
  });

  it("ignores never-served markers", () => {
    const result = computeDrift({
      served: ["h00", null, "h02"],
      resultHashes: ["h00", "X01", "h02"],
      resultLines: ["a", "changed", "c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("tolerates an external positional shift above the range — only genuinely removed lines drift", () => {
    const served = ["h00", "h01", "h02", "h03", "h04", "h05", "h06", "h07", "h08", "h09"];
    const resultHashes = ["h00", "h01", "X04", "h05", "h06", "h07", "h08", "h09"];
    const resultLines = ["a", "b", "R", "e", "f", "g", "h", "i"];
    const result = computeDrift({
      served,
      resultHashes,
      resultLines,
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h04",
        endHash: "h04",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "X04", content: "R", drifted: true },
      { position: 3, hash: "h05", content: "e", drifted: false },
    ]);
  });

  it("shows a before/drift/after window for a single drifted line", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "X02", "h03"],
      resultLines: ["a", "b", "changed", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 1, hash: "h01", content: "b", drifted: false },
      { position: 2, hash: "X02", content: "changed", drifted: true },
      { position: 3, hash: "h03", content: "d", drifted: false },
    ]);
  });

  it("merges adjacent drifted lines into a single window with shared context boundaries", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["X00", "X01", "X02", "X03"],
      resultLines: ["a", "b", "C", "D"],
      range: {
        startLine: 1,
        endLine: 2,
        startHash: "h00",
        endHash: "h01",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.rows).toEqual([
      { position: 1, hash: "X01", content: "b", drifted: false },
      { position: 2, hash: "X02", content: "C", drifted: true },
      { position: 3, hash: "X03", content: "D", drifted: true },
    ]);
  });

  it("bounds the window at the file start — only in-bounds context rows, no fabricated before-row", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02"],
      resultHashes: ["X00", "h01", "h02"],
      resultLines: ["changed", "b", "c"],
      range: {
        startLine: 3,
        endLine: 3,
        startHash: "h02",
        endHash: "h02",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 0, hash: "X00", content: "changed", drifted: true },
      { position: 1, hash: "h01", content: "b", drifted: false },
    ]);
  });

  it("bounds the window at the file end — only in-bounds context rows, no fabricated after-row", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      resultHashes: ["h00", "h01", "h02", "X03"],
      resultLines: ["a", "b", "c", "changed"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
    expect(result!.rows).toEqual([
      { position: 2, hash: "h02", content: "c", drifted: false },
      { position: 3, hash: "X03", content: "changed", drifted: true },
    ]);
  });

  it("suppresses hash-rotated duplicates whose canon survives (#68)", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      servedCanonDigests: [canonDigest("a"), canonDigest("b"), canonDigest("c"), canonDigest("c")],
      resultHashes: ["h00", "X01", "X02", "X03"],
      resultLines: ["a", "b", "c", "c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });

  it("still drifts on true canon deficit (#68)", () => {
    const result = computeDrift({
      served: ["h00", "h01", "h02", "h03"],
      servedCanonDigests: [canonDigest("a"), canonDigest("b"), canonDigest("c"), canonDigest("c")],
      resultHashes: ["h00", "X01", "X02"],
      resultLines: ["a", "b", "c"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
  });

  it("stays silent on whitespace-only reformat (ADR-0005, #68)", () => {
    const result = computeDrift({
      served: ["h00", "h01"],
      servedCanonDigests: [canonDigest("a"), canonDigest("b")],
      resultHashes: ["h00", "X01"],
      resultLines: ["a", "b  "],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(result).toBeUndefined();
  });
});

describe("drift-notice episode identity (CAND-9, ADR-0023)", () => {
  // The reported set must key on the drifted line's rebased position, not its anchor STRING:
  // an anchor is a spelling, not an identity. A reported entry for one line may not silence
  // a distinct line that happens to share the anchor.
  it("does not collapse distinct duplicate-hash drifted lines into one reported episode", () => {
    // Two distinct served positions share the anchor "dup" (ambiguous hash — exactly the
    // shape resolveServedRange refuses to trust). Both lines drifted to different content.
    // `reported` holds one entry for the shared anchor: under the string key BOTH lines are
    // "already reported" and their current content is never shown. Under the position key a
    // raw anchor string reports nothing.
    const result = computeDrift({
      served: ["h00", "dup", "dup", "h03"],
      resultHashes: ["h00", "P01", "P02", "h03"],
      resultLines: ["a", "first-new", "second-new", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(["dup"]),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(2);
    expect(result!.allAlreadyReported).toBe(false);
    // The nearest-surviving rebase maps BOTH duplicate lines onto current position 1 (a
    // pinned helper floor — see drift-helpers.test.ts), so one row carries the drift flag
    // and the other's line still shows as its context row. The fixed behavior is the
    // point: a single shared-anchor reported entry no longer collapses the episode to a
    // pointer; the current content of both lines is served.
    expect(result!.rows.filter((r) => r.drifted).map((r) => r.hash)).toEqual(["P01"]);
    expect(result!.rows.map((r) => r.hash)).toContain("P02");
  });

  it("re-notices nothing when each drifted line's own episode key is reported", () => {
    const first = computeDrift({
      served: ["h00", "o01", "h02", "h03"],
      resultHashes: ["h00", "n01", "h02", "h03"],
      resultLines: ["a", "new-one", "c", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported: new Set(),
    });
    expect(first).toBeDefined();
    const drifted = first!.rows.filter((r) => r.drifted);
    expect(drifted).toHaveLength(1);
    // The episode advances exactly as scanDrift does: mark what the notice showed.
    const reported = new Set(drifted.map((r) => driftEpisodeKey(r.position)));
    // Lease rotation renames the re-served mirror anchor "n01" → "r01" without a fresh read,
    // and the line's content changes again. Under the string key the marked "n01" no longer
    // matches the mirror's rotated "r01" and the line spuriously re-notices; the position key
    // is rotation-stable.
    const second = computeDrift({
      served: ["h00", "r01", "h02", "h03"],
      resultHashes: ["h00", "x02", "h02", "h03"],
      resultLines: ["a", "newer-one", "c", "d"],
      range: {
        startLine: 1,
        endLine: 1,
        startHash: "h00",
        endHash: "h00",
        delta: 0,
      },
      reported,
    });
    expect(second).toBeDefined();
    expect(second!.allAlreadyReported).toBe(true);
  });
});

describe("computeDrift — zero-width insertion intervals (ticket-01 hardening: deltaBefore arithmetic)", () => {
  // WHY: a zero-width insertion interval (`startLine > endLine`) edits no served line, so it can
  // WHY: never be matched by `isInIntervals`; its ONLY effect is positional — every served line at
  // WHY: or after the insertion point shifts by the inserted line count. These cases pin that
  // WHY: arithmetic directly: no served hash survives into the result, so the drifted position
  // WHY: comes from the floor `servedIndex + deltaBefore(index)` — the nearest-survivor tiers
  // WHY: cannot rescue an off-by-one here.
  const zeroWidth = (startLine: number, endLine: number, delta: number) => ({
    startLine,
    endLine,
    startHash: "zs0",
    endHash: "ze0",
    delta,
  });

  it("shifts served lines at/after the insertion point by the inserted count, lines before unmoved", () => {
    // Insertion after 1-based line 2 → zero-width {startLine: 3, endLine: 2} with 2 lines added.
    // 0-based served lines 0,1 keep their positions; lines 2,3 shift +2 → 4,5.
    const result = computeDrift({
      served: ["s0", "s1", "s2", "s3"],
      resultHashes: ["r0", "r1", "r2", "r3", "r4", "r5"],
      resultLines: ["L0", "L1", "L2", "L3", "L4", "L5"],
      intervals: [zeroWidth(3, 2, 2)],
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(4);
    expect(result!.rows).toEqual([
      { position: 0, hash: "r0", content: "L0", drifted: true },
      { position: 1, hash: "r1", content: "L1", drifted: true },
      { position: 2, hash: "r2", content: "L2", drifted: false },
      { position: 3, hash: "r3", content: "L3", drifted: false },
      { position: 4, hash: "r4", content: "L4", drifted: true },
      { position: 5, hash: "r5", content: "L5", drifted: true },
    ]);
  });

  it("an insertion at the file start shifts every served line", () => {
    // Zero-width {startLine: 1, endLine: 0}: the resolved interval is {from: 0, to: -1}, so
    // `to < p` holds for every 0-based served position — all three lines shift +1.
    const result = computeDrift({
      served: ["s0", "s1", "s2"],
      resultHashes: ["r0", "r1", "r2", "r3"],
      resultLines: ["L0", "L1", "L2", "L3"],
      intervals: [zeroWidth(1, 0, 1)],
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(3);
    expect(result!.rows).toEqual([
      { position: 0, hash: "r0", content: "L0", drifted: false },
      { position: 1, hash: "r1", content: "L1", drifted: true },
      { position: 2, hash: "r2", content: "L2", drifted: true },
      { position: 3, hash: "r3", content: "L3", drifted: true },
    ]);
  });

  it("an insertion after the last served line shifts nothing", () => {
    // Zero-width {startLine: 4, endLine: 3} on a 3-line served mirror: `to = 2`, no served
    // position p satisfies `2 < p` — every drifted line keeps its position.
    const result = computeDrift({
      served: ["s0", "s1", "s2"],
      resultHashes: ["r0", "r1", "r2", "r3", "r4"],
      resultLines: ["L0", "L1", "L2", "L3", "L4"],
      intervals: [zeroWidth(4, 3, 2)],
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(3);
    expect(result!.rows).toEqual([
      { position: 0, hash: "r0", content: "L0", drifted: true },
      { position: 1, hash: "r1", content: "L1", drifted: true },
      { position: 2, hash: "r2", content: "L2", drifted: true },
      { position: 3, hash: "r3", content: "L3", drifted: false },
    ]);
  });

  it("two zero-width insertions stack their deltas for lines past both", () => {
    // Insertions after 1-based lines 2 and 4 (2 and 1 lines): 0-based served p≥2 shifts +2,
    // p≥4 shifts +2+1 — the last served line (p=4) lands at 7, proving addition across intervals.
    const result = computeDrift({
      served: ["s0", "s1", "s2", "s3", "s4"],
      resultHashes: ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
      resultLines: ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"],
      intervals: [zeroWidth(3, 2, 2), zeroWidth(5, 4, 1)],
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(5);
    expect(result!.rows.filter((r) => r.drifted).map((r) => r.position)).toEqual([0, 1, 4, 5, 7]);
  });

  it("a large delta after the whole mirror moves no position — the shift is conditional, not unconditional", () => {
    // Zero-width {startLine: 6, endLine: 5} (to = 4): every served position is below the
    // insertion point, so even a +10-line insertion leaves positions 0,1,2 untouched.
    const result = computeDrift({
      served: ["s0", "s1", "s2"],
      resultHashes: ["r0", "r1", "r2"],
      resultLines: ["L0", "L1", "L2"],
      intervals: [zeroWidth(6, 5, 10)],
      reported: new Set(),
    });
    expect(result).toBeDefined();
    expect(result!.total).toBe(3);
    expect(result!.rows).toEqual([
      { position: 0, hash: "r0", content: "L0", drifted: true },
      { position: 1, hash: "r1", content: "L1", drifted: true },
      { position: 2, hash: "r2", content: "L2", drifted: true },
    ]);
  });
});
