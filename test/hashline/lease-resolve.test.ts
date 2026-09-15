import { describe, it, expect, beforeAll } from "vitest";
import { resEdit, type HEdit } from "../../src/hashline/resolve";
import {
  isUniformLeaseFastPath,
  resolveLineIdentity,
  uniqueAnchorLine,
  uniqueItemPositions,
  uniqueServedPosition,
  type LeaseIdentityView,
  type LeaseSpanSource,
} from "../../src/hashline/resolve";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve";
import { applyEdit } from "../../src/hashline/apply";
import {
  AnchorMismatchError,
  makeServedRejection,
  ServedRejectionError,
  verifyRebasedSpan,
} from "../../src/hashline/served-verification";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";

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
  currentSnapshotHash?: string;
}): LeaseSpanSource {
  return {
    currentSnapshotHash: args.currentSnapshotHash ?? "C",
    leaseFor: (anchor) => args.leases[anchor],
    rebasedLineOf: (lineId) => args.positions[lineId],
  };
}

describe("isUniformLeaseFastPath — S_from === C ∧ S_to === C ∧ S_from === S_to", () => {
  it("qualifies only when both anchors were leased from the current snapshot", () => {
    const from = lease({ lineId: 1, servedSnapshotHash: "C" });
    const to = lease({ lineId: 5, servedSnapshotHash: "C" });
    expect(isUniformLeaseFastPath(from, to, "C")).toBe(true);
    expect(isUniformLeaseFastPath(from, to, "S")).toBe(false);
    expect(isUniformLeaseFastPath(from, { ...to, servedSnapshotHash: "S" }, "C")).toBe(false);
    expect(isUniformLeaseFastPath(from, { ...to, servedSnapshotHash: "S" }, "S")).toBe(false);
    expect(
      isUniformLeaseFastPath(
        { ...from, servedSnapshotHash: "S" },
        { ...to, servedSnapshotHash: "S" },
        "S",
      ),
    ).toBe(true);
  });
});

describe("resolveLineIdentity — lease identity is authoritative", () => {
  const src = source({ leases: {}, positions: { 7: 3 } });

  it("returns the rebased coordinate for a live lease", () => {
    expect(resolveLineIdentity(lease({ lineId: 7 }), 3, src)).toEqual({ kind: "line", line: 3 });
  });

  it("rebases even when the content anchor moved to a colliding line", () => {
    // The leased identity lives at 3; the anchor string now renders on line 2.
    expect(resolveLineIdentity(lease({ lineId: 7 }), 2, src)).toEqual({ kind: "line", line: 3 });
  });

  it("fails closed when a retired lease still has a live content anchor (Probe E)", () => {
    // `retired_at` set -> `E_STALE_RANGE` with the current-range serve, never `E_STALE_ANCHOR`.
    expect(resolveLineIdentity(lease({ lineId: 7, retiredAt: 1 }), 2, src)).toEqual({
      kind: "stale",
      line: 2,
    });
  });

  it("fails closed when a live lease has no lineage coordinate", () => {
    expect(resolveLineIdentity(lease({ lineId: 99 }), 4, src)).toEqual({
      kind: "stale",
      line: 4,
    });
    expect(resolveLineIdentity(lease({ lineId: 99 }), undefined, src)).toEqual({
      kind: "stale",
      line: 99,
    });
  });

  it("fails closed when a retired lease is absent from the content", () => {
    // Spec §3.1.1 line 89 / §5.3: `retired_at` is set -> E_STALE_RANGE, never a content question.
    expect(resolveLineIdentity(lease({ lineId: 7, retiredAt: 1 }), undefined, src)).toEqual({
      kind: "stale",
      line: 7,
    });
  });
});

describe("anchor position helpers", () => {
  it("uniqueAnchorLine rejects absent and ambiguous anchors", () => {
    const hashes = ["aaa", "bbb", "aaa"];
    expect(uniqueAnchorLine(hashes, "bbb")).toBe(2);
    expect(uniqueAnchorLine(hashes, "aaa")).toBeUndefined();
    expect(uniqueAnchorLine(hashes, "zzz")).toBeUndefined();
  });

  it("uniqueServedPosition rejects absent and ambiguous anchors", () => {
    const served = ["aaa", "bbb", "aaa"];
    expect(uniqueServedPosition(served, "bbb")).toBe(2);
    expect(uniqueServedPosition(served, "aaa")).toBeUndefined();
    expect(uniqueServedPosition(served, "zzz")).toBeUndefined();
  });

  it("uniqueItemPositions reports each bound of a span independently", () => {
    expect(uniqueItemPositions(["aaa", "bbb", "aaa"], "bbb", "aaa")).toEqual([2, undefined]);
    expect(uniqueItemPositions(["aaa", "bbb"], "aaa", "bbb")).toEqual([1, 2]);
    expect(uniqueItemPositions([], "aaa", "bbb")).toEqual([undefined, undefined]);
  });

  it("keeps the shared occurrence scan 1-based at the edges", () => {
    expect(uniqueAnchorLine([], "aaa")).toBeUndefined();
    expect(uniqueAnchorLine(["aaa"], "aaa")).toBe(1);
    expect(uniqueAnchorLine(["aaa", "bbb"], "bbb")).toBe(2);
    expect(uniqueServedPosition([], "aaa")).toBeUndefined();
    expect(uniqueServedPosition(["aaa"], "aaa")).toBe(1);
    expect(uniqueServedPosition([null, "aaa"], "aaa")).toBe(2);
  });
});

describe("resolveLeasedEdit — fast path, rebase, fail-closed", () => {
  const edit: HEdit = resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" });

  it("rejects an unleased anchor with [E_STALE_ANCHOR] — content never satisfies a served anchor", () => {
    const src = source({ leases: { AAA: lease({ lineId: 1 }) }, positions: { 1: 1 } });
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    // Reject-and-serve: the serve is the current RANGE (not a +/-1 context window), so the rows are
    // themselves serves and the model retries without re-reading (spec §5.3).
    expect(caught).toBeInstanceOf(AnchorMismatchError);
    expect(caught?.message).toContain("Current range:");
    expect(caught?.message).not.toContain("Current context around resolved anchor");
    expect((caught as AnchorMismatchError).servedRows).toEqual([
      { position: 0, hash: "AAA" },
      { position: 1, hash: "BBB" },
    ]);
    expect(caught?.message).toContain("BBB│b");
  });

  it("serves the full targeted range for an unleased boundary anchor, not a narrow context window", () => {
    const src = source({
      leases: { AAA: lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 }) },
      positions: { 1: 1 },
      currentSnapshotHash: "C",
    });
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit,
        snapshot: {
          fileHashes: ["AAA", "m2", "m3", "m4", "BBB"],
          fileLines: ["a", "b", "c", "d", "e"],
        },
        served: ["AAA", "m2", "m3", "m4", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(caught?.message).toContain("Current range:");
    // Every row of the targeted range is served, so the retry can rebuild both anchors.
    expect((caught as AnchorMismatchError).servedRows).toEqual([
      { position: 0, hash: "AAA" },
      { position: 1, hash: "m2" },
      { position: 2, hash: "m3" },
      { position: 3, hash: "m4" },
      { position: 4, hash: "BBB" },
    ]);
    for (const row of ["AAA│a", "m2│b", "m3│c", "m4│d", "BBB│e"]) {
      expect(caught?.message).toContain(row);
    }
  });

  it("omits the range serve when neither boundary can be placed by content or by a lease", () => {
    const src = source({ leases: {}, positions: {} });
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "ZZZ", anchor_to: "YYY", replace_with: "X" }),
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
        served: [],
        source: src,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AnchorMismatchError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    // No targeted range is knowable, so there is nothing to serve as fresh anchors.
    expect(caught?.message).not.toContain("Current range:");
    expect((caught as AnchorMismatchError).servedRows).toEqual([]);
  });

  it("reports [E_UNSERVED_RANGE] for a never-served interior line of a rebased span", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 3 }),
      },
      positions: { 1: 1, 2: 3 },
      currentSnapshotHash: "C",
    });
    expect(() =>
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "X", "BBB"], fileLines: ["a", "x", "b"] },
        served: ["AAA", null, "BBB"],
        source: src,
      }),
    ).toThrow(/\[E_UNSERVED_RANGE\]/);
  });

  it("takes the O(1) fast path on a uniform snapshot even when the content anchor is ambiguous", () => {
    // Duplicate canon: `uniqueAnchorLine` cannot place "AAA", yet both leases were served from the
    // snapshot on disk, so the spec predicate (S_from === C ∧ S_to === C ∧ S_from === S_to) holds.
    // The non-spec `=== content` clause used to route this off the fast path into a fail-closed
    // rebase rejection (spec §3.5).
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 }),
        BBB: lease({ lineId: 3, servedSnapshotHash: "C", servedLineNumber: 3 }),
      },
      positions: { 1: 1, 3: 3 },
      currentSnapshotHash: "C",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["AAA", "AAA", "BBB"], fileLines: ["a", "a", "b"] },
      served: ["AAA", "AAA", "BBB"],
      source: src,
    });
    expect(result.status).toBe("fast");
    expect(result.resolved.hash_bounds.map((bound) => bound.line)).toEqual([1, 3]);
  });

  it("takes the fast path when both leases come from the current snapshot", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "C" }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "C" }),
      },
      positions: { 1: 1, 2: 2 },
      currentSnapshotHash: "C",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
      served: ["AAA", "BBB"],
      source: src,
    });
    // The lease path resolves the served coordinates itself — no content-resolution fallback.
    expect(result.status).toBe("fast");
    expect(result.resolved.hash_bounds.map((bound) => bound.line)).toEqual([1, 2]);
  });

  it("rebases a surviving lease after drift, applying at the rebased coordinate", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S" }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S" }),
      },
      positions: { 1: 2, 2: 3 },
      currentSnapshotHash: "C",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["ZZZ", "QQQ", "WWW"], fileLines: ["z", "q", "w"] },
      served: ["AAA", "BBB", null],
      source: src,
    });
    expect(result.status).toBe("rebased");
    if (result.status === "rebased") {
      expect(result.resolved.hash_bounds[0].line).toBe(2);
      expect(result.resolved.hash_bounds[1].line).toBe(3);
    }
  });

  it("rejects when a leased line is retired and still present by content (Probe E)", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", retiredAt: 5 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S" }),
      },
      positions: { 1: 1, 2: 2 },
      currentSnapshotHash: "C",
    });
    expect(() =>
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("rejects a retired lease absent from content with [E_STALE_RANGE], never [E_STALE_ANCHOR]", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1, retiredAt: 5 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 }),
      },
      positions: { 1: 1, 2: 2 },
      currentSnapshotHash: "C",
    });
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit,
        // The retired lease's anchor is gone from the content entirely (line deleted externally).
        snapshot: { fileHashes: ["QQQ", "BBB"], fileLines: ["q", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(ServedRejectionError);
    expect((caught as ServedRejectionError).code).toBe("E_STALE_RANGE");
    expect(caught?.message).not.toMatch(/E_STALE_ANCHOR/);
    // Reject-and-serve: the serve is the current range the model retries from.
    expect(caught?.message).toContain("Current range:");
    expect((caught as ServedRejectionError).servedRows.length).toBeGreaterThan(0);
  });

  it("rejects a served anchor held by no lease with [E_STALE_ANCHOR] — mirror-only serves fail closed", () => {
    const src = source({ leases: {}, positions: {} });
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AnchorMismatchError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(caught?.message).not.toMatch(/E_STALE_RANGE|E_UNSERVED_RANGE/);
    expect((caught as AnchorMismatchError).servedRows.length).toBeGreaterThan(0);
  });

  it("rejects a torn span whose rebased window grew (Probe J)", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 }),
      },
      positions: { 1: 1, 2: 4 },
      currentSnapshotHash: "C",
    });
    expect(() =>
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "X", "Y", "BBB"], fileLines: ["a", "x", "y", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("rebuilds the served window from the lease when the mirror row is gone", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 }),
      },
      positions: { 1: 1, 2: 2 },
      currentSnapshotHash: "C",
    });
    // A serve truncated both mirror rows away; the leases still name the served window, so the gate
    // runs on the lease coordinates and fails closed on the missing rows instead of a NaN window.
    expect(() =>
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"] },
        served: [],
        source: src,
      }),
    ).toThrow(/E_UNSERVED_RANGE/);
  });

  it("rejects reversed rebased anchors", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 }),
      },
      positions: { 1: 3, 2: 1 },
      currentSnapshotHash: "C",
    });
    expect(() =>
      resolveLeasedEdit({
        edit,
        snapshot: { fileHashes: ["BBB", "Q", "AAA"], fileLines: ["b", "q", "a"] },
        served: ["AAA", "BBB"],
        source: src,
      }),
    ).toThrow(/E_REVERSED_ANCHORS/);
  });
});

describe("applyEdit — lease resolution owns every served anchor", () => {
  const content = "alpha\nbeta\ngamma";
  const hashes = _lineHashesPure(content);
  const served: (string | null)[] = [...hashes];
  const edit: HEdit = {
    hash_bounds: [{ hash: hashes[0]! }, { hash: hashes[1]! }],
    content_lines: ["X"],
  };
  const noLeases: LeaseSpanSource = {
    currentSnapshotHash: "C",
    leaseFor: () => undefined,
    rebasedLineOf: () => undefined,
  };

  it("fails closed with [E_STALE_ANCHOR] instead of applying at the colliding content anchor", () => {
    let caught: Error | undefined;
    try {
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        identity: noLeases,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AnchorMismatchError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(caught?.message).toContain("Current range:");
    expect(caught?.message).not.toContain("Current context around resolved anchor");
    expect((caught as AnchorMismatchError).servedRows.length).toBeGreaterThan(0);
  });

  it("rejects a retired lease absent from the content with [MODEL] [E_STALE_RANGE] and a range serve", () => {
    // Spec §3.1.1 line 89 / §5.3: `retired_at` is set -> E_STALE_RANGE, never E_STALE_ANCHOR, even
    // when the anchor string is gone from the content entirely.
    const staleContent = "alpha\nBETA";
    const staleHashes = _lineHashesPure(staleContent);
    const oldBeta = "OLD";
    const leases = new Map<string, LeaseIdentityView>([
      [staleHashes[0]!, lease({ lineId: 1, servedSnapshotHash: "C" })],
      [oldBeta, lease({ lineId: 2, servedSnapshotHash: "C", servedLineNumber: 2, retiredAt: 7 })],
    ]);
    const source: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => leases.get(anchor),
      rebasedLineOf: (lineId) => (lineId === 1 ? 1 : undefined),
    };
    const staleEdit: HEdit = {
      hash_bounds: [{ hash: staleHashes[0]! }, { hash: oldBeta }],
      content_lines: ["X"],
    };
    let caught: Error | undefined;
    try {
      applyEdit(staleContent, staleEdit, undefined, staleHashes, {
        filePath: "a.txt",
        served: [staleHashes[0]!, oldBeta],
        identity: source,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(ServedRejectionError);
    expect((caught as ServedRejectionError).code).toBe("E_STALE_RANGE");
    expect(caught?.message).toMatch(/\[MODEL\] \[E_STALE_RANGE\]/);
    expect(caught?.message).not.toMatch(/E_STALE_ANCHOR/);
    expect(caught?.message).toContain("Current range:");
    expect((caught as ServedRejectionError).servedRows.length).toBeGreaterThan(0);
  });
});

describe("verifyRebasedSpan — contiguity + identity gate", () => {
  const hashes = _lineHashesPure("row 1\nrow 2\nrow 3\nrow 4");
  const fileLines = ["row 1", "row 2", "row 3", "row 4"];

  it("accepts a rigid remap of the whole served window", () => {
    const leases = new Map([
      ["AAA", lease({ lineId: 1 })],
      ["BBB", lease({ lineId: 2 })],
    ]);
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA", "BBB"],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 2,
        rebasedEnd: 3,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: (anchor) => leases.get(anchor),
        rebasedLineOf: (lineId) => lineId + 1,
      }),
    ).not.toThrow();
  });

  it("rejects a window that grew by an interior insert", () => {
    const leases = new Map([
      ["AAA", lease({ lineId: 1 })],
      ["BBB", lease({ lineId: 2 })],
    ]);
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA", "BBB"],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 3,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: (anchor) => leases.get(anchor),
        rebasedLineOf: (lineId) => (lineId === 1 ? 1 : 3),
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("reports E_UNSERVED_RANGE for a never-served interior line", () => {
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA", null],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: () => lease({ lineId: 1 }),
        rebasedLineOf: (lineId) => lineId,
      }),
    ).toThrow(/E_UNSERVED_RANGE/);
  });

  it("reports E_UNSERVED_RANGE when a served anchor has no lease", () => {
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA"],
        servedStart: 1,
        servedEnd: 1,
        rebasedStart: 1,
        rebasedEnd: 1,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: () => undefined,
        rebasedLineOf: () => 1,
      }),
    ).toThrow(/E_UNSERVED_RANGE/);
  });

  it("rejects a retired interior lease or an identity that moved elsewhere", () => {
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA"],
        servedStart: 1,
        servedEnd: 1,
        rebasedStart: 1,
        rebasedEnd: 1,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: () => lease({ lineId: 1, retiredAt: 9 }),
        rebasedLineOf: () => 1,
      }),
    ).toThrow(/E_STALE_RANGE/);
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA"],
        servedStart: 1,
        servedEnd: 1,
        rebasedStart: 1,
        rebasedEnd: 1,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: () => lease({ lineId: 1 }),
        rebasedLineOf: () => 4,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });
});

describe("makeServedRejection — reject-and-serve serve block", () => {
  const hashes = _lineHashesPure("alpha\nbeta\ngamma");
  const fileLines = ["alpha", "beta", "gamma"];

  it("serves the current range with fresh anchors and marks the offending line", () => {
    const err = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 differs from what was served.",
      startLine: 1,
      endLine: 3,
      snapshot: { fileHashes: hashes, fileLines },
      firstOffendingLine: 2,
    });
    expect(err).toBeInstanceOf(ServedRejectionError);
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.firstOffendingLine).toBe(2);
    expect(err.servedRows).toEqual([
      { position: 0, hash: hashes[0] },
      { position: 1, hash: hashes[1] },
      { position: 2, hash: hashes[2] },
    ]);
    expect(err.message).toContain("Current range:");
    expect(err.message).toContain("Retry with these anchors");
  });

  it("caps a large serve block with a pagination hint", () => {
    const many = _lineHashesPure(Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n"));
    const err = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "torn",
      startLine: 1,
      endLine: 200,
      snapshot: { fileHashes: many, fileLines: many },
    });
    expect(err.servedRows).toHaveLength(150);
    expect(err.message).toMatch(/50 more — read offset=151/);
  });
});
