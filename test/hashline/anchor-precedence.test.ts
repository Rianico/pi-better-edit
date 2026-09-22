import { describe, it, expect, beforeAll } from "vitest";
import { resEdit } from "../../src/hashline/resolve";
import type { LeaseIdentityView, LeaseSpanSource } from "../../src/hashline/resolve";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve";
import { ServedVerification } from "../../src/hashline/served-verification";
import { DomainError } from "../../src/domain-errors.js";
import { initHasher } from "../../src/hashline/hasher";
import { canonDigest } from "../../src/hashline/hash-identity.js";

beforeAll(async () => {
  await initHasher();
});

function lease(partial: Partial<LeaseIdentityView> & { lineId: number }): LeaseIdentityView {
  return {
    canonHash: "0",
    servedSnapshotHash: "S",
    servedLineNumber: partial.lineId,
    retiredAt: null,
    ...partial,
  };
}

function source(args: {
  leases: Record<string, LeaseIdentityView>;
  positions: Record<number, number>;
  homes?: Record<string, string[]>;
  currentSnapshotHash?: string;
}): LeaseSpanSource {
  return {
    currentSnapshotHash: args.currentSnapshotHash ?? "C",
    leaseFor: (anchor) => args.leases[anchor],
    rebasedLineOf: (lineId) => args.positions[lineId],
    anchorHomes: (anchor) => args.homes?.[anchor] ?? [],
  };
}

describe("anchor family precedence — one condition reaches exactly one code", () => {
  it("tombstoned boundary with row here resolves to E_STALE_ANCHOR with a served window", () => {
    const verifier = new ServedVerification();
    let caught: unknown;
    try {
      verifier.verifyOrThrow({
        range: { startHash: "AAA", endHash: "BBB", startLine: 1, endLine: 2 },
        served: ["AAA", "BBB"],
        fileHashes: ["AAA", "BBB"],
        fileLines: ["ALPHA", "BETA"],
        filePath: "a.py",
        tombstone: new Set(["AAA"]),
        canonDigests: [canonDigest("alpha"), canonDigest("beta")],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_STALE_ANCHOR");
    expect((caught as DomainError).servedRows.length).toBeGreaterThan(0);
  });

  it("retired without a live unshifted survivor stays fail-closed with no rows", () => {
    const dead = lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1, retiredAt: 6 });
    const shifted = lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 });
    const src = source({
      leases: { AAA: dead, BBB: shifted },
      positions: { 2: 3 },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: {
          fileHashes: ["Q", "Q", "BBB"],
          fileLines: ["q", "q", "b"],
          filePath: "a.py",
        },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_TARGET_LOST");
    expect((caught as DomainError).servedRows).toEqual([]);
  });

  it("no row here but held elsewhere resolves to E_FOREIGN_ANCHOR with no rows", () => {
    const live = lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 });
    const src = source({
      leases: { AAA: live },
      positions: { 1: 1 },
      homes: { BBB: ["b.py"] },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: {
          fileHashes: ["AAA", "BBB"],
          fileLines: ["a", "b"],
          filePath: "a.py",
        },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_FOREIGN_ANCHOR");
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).toMatch(/\[MODEL\] \[E_FOREIGN_ANCHOR\]/);
    expect(err.message).toContain("b.py");
  });

  it("no lease in any file resolves to E_UNKNOWN_ANCHOR with no rows", () => {
    const src = source({ leases: {}, positions: {}, currentSnapshotHash: "C" });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "ZZZ", anchor_to: "733", replace_with: "X" }),
        snapshot: {
          fileHashes: ["AAA", "BBB"],
          fileLines: ["a", "b"],
          filePath: "a.py",
        },
        served: [],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_UNKNOWN_ANCHOR");
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).toBe(
      '[MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchors "ZZZ", "733"; nothing was written.' +
        ' Note: anchor "733" consists only of digits and resembles a line number.' +
        ' Edit anchors must be 3-character alphanumeric content hashes (e.g. "aB3") served by the read tool, not line numbers.',
    );
  });

  it("bad syntax resolves to E_MALFORMED_ANCHOR", () => {
    expect(() => resEdit({ anchor_from: "wUp│x", anchor_to: "BBB", replace_with: "X" })).toThrow(
      /E_MALFORMED_ANCHOR/,
    );
  });

  it("caps the home list at three plus the remainder", () => {
    const live = lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 });
    const src = source({
      leases: { AAA: live },
      positions: { 1: 1 },
      homes: { BBB: ["b.py", "c.py", "d.py", "e.py", "f.py"] },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: {
          fileHashes: ["AAA", "BBB"],
          fileLines: ["a", "b"],
          filePath: "a.py",
        },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    const err = caught as DomainError;
    expect(err.code).toBe("E_FOREIGN_ANCHOR");
    expect(err.message).toContain("b.py, c.py, d.py and 2 more");
  });

  it("unknown and foreign carry no remedy and no cause", () => {
    const unknown = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ"] });
    expect(unknown.message).toBe(
      '[MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchor "ZZZ"; nothing was written.',
    );
    expect(unknown.servedRows).toEqual([]);
    expect((unknown as { cause?: unknown }).cause).toBeUndefined();
    expect(unknown.details).toEqual({ code: "E_UNKNOWN_ANCHOR" });

    const foreign = new DomainError("E_FOREIGN_ANCHOR", {
      path: "a.py",
      anchors: ["wUp"],
      homes: ["b.py"],
    });
    expect(foreign.message).toContain('[MODEL] [E_FOREIGN_ANCHOR] the anchor "wUp"');
    expect(foreign.message).toContain("b.py");
    expect(foreign.servedRows).toEqual([]);
    expect((foreign as { cause?: unknown }).cause).toBeUndefined();
    expect(foreign.details).toEqual({ code: "E_FOREIGN_ANCHOR" });
  });
});
