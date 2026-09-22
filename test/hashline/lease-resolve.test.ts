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
import { DomainError } from "../../src/domain-errors.js";
import { makeServedRejection, verifyRebasedSpan } from "../../src/hashline/served-verification";
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
    expect(resolveLineIdentity(lease({ lineId: 7 }), src)).toEqual({ kind: "line", line: 3 });
  });

  it("rebases even when the content anchor moved to a colliding line", () => {
    // The leased identity lives at 3; the anchor string now renders on line 2.
    // Resolution consults no content: the answer stays the rebased coordinate.
    expect(resolveLineIdentity(lease({ lineId: 7 }), src)).toEqual({ kind: "line", line: 3 });
  });

  it("fails closed when a retired lease still has a live content anchor (Probe E)", () => {
    // `retired_at` set -> stale decision naming the lease coordinate, never a content match.
    // Contract change (D5): the stale line is `servedLineNumber` (7), not the re-added line (2).
    expect(resolveLineIdentity(lease({ lineId: 7, retiredAt: 1 }), src)).toEqual({
      kind: "stale",
      line: 7,
    });
  });

  it("fails closed when a live lease has no lineage coordinate", () => {
    // Contract change (D5): no content lookup names the stale line; both read 99.
    expect(resolveLineIdentity(lease({ lineId: 99 }), src)).toEqual({
      kind: "stale",
      line: 99,
    });
  });

  it("fails closed when a retired lease is absent from the content", () => {
    // Spec §3.1.1 line 89 / §5.3: `retired_at` is set -> stale, never a content question.
    expect(resolveLineIdentity(lease({ lineId: 7, retiredAt: 1 }), src)).toEqual({
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

  it("rejects an unleased anchor with [E_UNKNOWN_ANCHOR] — content never satisfies a served anchor", () => {
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
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_UNKNOWN_ANCHOR");
    expect((caught as DomainError).servedRows).toEqual([]);
    expect((caught as DomainError).servedBlock).toBe("");
  });

  it("carries no rows for an unleased boundary anchor", () => {
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
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect((caught as DomainError).code).toBe("E_UNKNOWN_ANCHOR");
    expect((caught as DomainError).servedRows).toEqual([]);
    expect((caught as DomainError).servedBlock).toBe("");
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
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    // No targeted range is knowable, so there is nothing to serve as fresh anchors.
    expect(caught?.message).not.toContain("Current range:");
    expect((caught as DomainError).servedRows).toEqual([]);
  });

  it("applies an unread interior between two leased boundaries (ADR-0024)", () => {
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 3 }),
      },
      positions: { 1: 1, 2: 3 },
      currentSnapshotHash: "C",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["AAA", "X", "BBB"], fileLines: ["a", "x", "b"] },
      served: ["AAA", null, "BBB"],
      source: src,
    });
    expect(result.status).toBe("rebased");
    expect(result.resolved.hash_bounds.map((bound) => bound.line)).toEqual([1, 3]);
  });

  it("takes the O(1) fast path on a uniform snapshot even when the content anchor is ambiguous", () => {
    // Duplicate canon: `uniqueAnchorLine` cannot place "AAA", yet both leases were served from the
    // snapshot on disk, so the spec predicate (S_from === C ∧ S_to === C ∧ S_from === S_to) holds.
    // The non-spec `=== content` clause used to route this off the fast path into a fail-closed
    // rebase rejection (spec §3.5). The interior line is leased too (#151): the fast path runs the
    // same whole-window identity gate, so an interior row the session holds no lease for fails closed.
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 }),
        m2: lease({ lineId: 2, servedSnapshotHash: "C", servedLineNumber: 2 }),
        BBB: lease({ lineId: 3, servedSnapshotHash: "C", servedLineNumber: 3 }),
      },
      positions: { 1: 1, 2: 2, 3: 3 },
      currentSnapshotHash: "C",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["AAA", "AAA", "BBB"], fileLines: ["a", "a", "b"] },
      served: ["AAA", "m2", "BBB"],
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
    ).toThrow(/E_UNVERIFIED_RANGE/);
  });

  it("rejects a retired lease absent from content with [E_UNVERIFIED_RANGE], never [E_STALE_ANCHOR]", () => {
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
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_UNVERIFIED_RANGE");
    expect(caught?.message).not.toMatch(/E_STALE_ANCHOR/);
    // Fresh read: the named window is served for the model to decide from (no retry hint).
    expect(caught?.message).toContain("Current range (fresh read):");
    expect(caught?.message).not.toContain("Retry with these anchors");
    expect((caught as DomainError).servedRows.length).toBeGreaterThan(0);
    expect((caught as DomainError).details.cause).toBe("retirement");
  });

  it("rejects a served anchor held by no lease with [E_UNKNOWN_ANCHOR] — mirror-only serves fail closed", () => {
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
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect(caught?.message).not.toMatch(/E_STALE_RANGE|E_UNVERIFIED_RANGE/);
    expect((caught as DomainError).servedRows).toEqual([]);
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
    ).toThrow(/E_STALE_RANGE/);
  });

  it("heals reversed anchors on the fast path and reports the swap for narration", () => {
    // Anchors carry no order: reversal is a property of the resolved lines of the
    // `anchor_from`/`anchor_to` slot pair, so the lease path swaps the lines and
    // returns the heal for the caller to narrate as `[W_REVERSED_ANCHORS]`.
    // WHY: the served window is the leases' own record — the served snapshot held the two anchors
    // WHY: the other way round, so the identity gate runs over the whole window the heal names.
    const src = source({
      leases: {
        AAA: lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 3 }),
        Q: lease({ lineId: 3, servedSnapshotHash: "S", servedLineNumber: 2 }),
        BBB: lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 1 }),
      },
      positions: { 1: 3, 2: 1, 3: 2 },
      currentSnapshotHash: "S",
    });
    const result = resolveLeasedEdit({
      edit,
      snapshot: { fileHashes: ["BBB", "Q", "AAA"], fileLines: ["b", "q", "a"] },
      served: ["BBB", "Q", "AAA"],
      source: src,
    });
    expect(result.status).toBe("fast");
    expect(result.resolved.hash_bounds[0].line).toBe(1);
    expect(result.resolved.hash_bounds[1].line).toBe(3);
    expect(result.reversed).toEqual({ fromHash: "AAA", toHash: "BBB" });
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

  it("fails closed with [E_UNKNOWN_ANCHOR] instead of applying at the colliding content anchor", () => {
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
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect((caught as DomainError).code).toBe("E_UNKNOWN_ANCHOR");
    expect((caught as DomainError).servedRows).toEqual([]);
  });

  it("heals a lease-resolved reversal and narrates [USER] [W_REVERSED_ANCHORS]", () => {
    // WHY: the served snapshot held the two anchors in the opposite order (#151): the leases name
    // WHY: those served window rows, and the identity gate accepts the healed rigid remap.
    const crossed: LeaseSpanSource = {
      currentSnapshotHash: "S",
      leaseFor: (anchor) =>
        anchor === hashes[0]
          ? lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 2 })
          : anchor === hashes[1]
            ? lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 1 })
            : undefined,
      rebasedLineOf: (lineId) => (lineId === 1 ? 2 : lineId === 2 ? 1 : undefined),
    };
    const crossedServed: (string | null)[] = [hashes[1]!, hashes[0]!, hashes[2]!];
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served: crossedServed,
      identity: crossed,
    });
    expect(result.content).toBe("X\ngamma");
    expect((result.warnings ?? []).some((w) => w.includes("[USER] [W_REVERSED_ANCHORS]"))).toBe(
      true,
    );
  });

  it("rejects a retired lease absent from the content with [MODEL] [E_UNVERIFIED_RANGE] and a fresh read", () => {
    // Spec §3.1.1 line 89 / §5.3: `retired_at` is set -> unverified fresh read, never E_STALE_ANCHOR,
    // even when the anchor string is gone from the content entirely.
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
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_UNVERIFIED_RANGE");
    expect(caught?.message).toMatch(/\[MODEL\] \[E_UNVERIFIED_RANGE\]/);
    expect(caught?.message).not.toMatch(/E_STALE_ANCHOR/);
    expect(caught?.message).toContain("Current range (fresh read):");
    expect(caught?.message).not.toContain("Retry with these anchors");
    expect((caught as DomainError).servedRows.length).toBeGreaterThan(0);
    expect((caught as DomainError).details.cause).toBe("retirement");
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

  it("reports E_STALE_RANGE for a never-served boundary row (a two-line window is all boundary)", () => {
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
    ).toThrow(/E_STALE_RANGE/);
  });

  it("accepts an unread interior row between two leased boundaries (ADR-0024)", () => {
    const leases = new Map([
      ["AAA", lease({ lineId: 1 })],
      [hashes[2]!, lease({ lineId: 3 })],
    ]);
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA", null, hashes[2]!],
        servedStart: 1,
        servedEnd: 3,
        rebasedStart: 1,
        rebasedEnd: 3,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: (anchor) => leases.get(anchor),
        rebasedLineOf: (lineId) => lineId,
      }),
    ).not.toThrow();
  });

  it("still rejects an unread boundary row of a three-line window (ADR-0024)", () => {
    const leases = new Map([
      [hashes[1]!, lease({ lineId: 2 })],
      [hashes[2]!, lease({ lineId: 3 })],
    ]);
    expect(() =>
      verifyRebasedSpan({
        served: [null, hashes[1]!, hashes[2]!],
        servedStart: 1,
        servedEnd: 3,
        rebasedStart: 1,
        rebasedEnd: 3,
        snapshot: { fileHashes: hashes, fileLines },
        leaseFor: (anchor) => leases.get(anchor),
        rebasedLineOf: (lineId) => lineId,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("reports E_STALE_RANGE when a served anchor has no lease", () => {
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
    ).toThrow(/E_STALE_RANGE/);
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
      cause: "served-range staleness",
    });
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.firstOffendingLine).toBe(2);
    expect(err.servedRows).toEqual([
      { position: 0, hash: hashes[0] },
      { position: 1, hash: hashes[1] },
      { position: 2, hash: hashes[2] },
    ]);
    // WHY: the rows are the current on-disk range, so they are served as a fresh read with no
    // WHY: blind-retry mandate (issue #149).
    expect(err.message).toContain("Current range (fresh read):");
    expect(err.message).not.toContain("Retry with these anchors");
  });

  it("caps a large serve block with a pagination hint", () => {
    const many = _lineHashesPure(Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n"));
    const err = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "torn",
      startLine: 1,
      endLine: 200,
      snapshot: { fileHashes: many, fileLines: many },
      cause: "served-range staleness",
    });
    expect(err.servedRows).toHaveLength(150);
    expect(err.message).toMatch(/50 more — read offset=151/);
  });
});

describe("resolveLeasedEdit — target-lost range rule (spec stale-identity-reject-and-serve D1/D5/D6)", () => {
  const editBoth = resEdit({ anchor_from: "AAA", anchor_to: "AAA", replace_with: "X" });

  it("emits [E_TARGET_LOST] with no rows and no retry hint when both bounds share one dead anchor", () => {
    const dead = lease({ lineId: 7, servedSnapshotHash: "S", servedLineNumber: 3, retiredAt: 9 });
    const src = source({ leases: { AAA: dead }, positions: {}, currentSnapshotHash: "C" });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: editBoth,
        snapshot: { fileHashes: ["QQQ", "WWW"], fileLines: ["q", "w"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_TARGET_LOST");
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.message).toMatch(/\[MODEL\] \[E_TARGET_LOST\] line 3/);
    expect(err.message).not.toContain("Current range:");
    expect(err.message).not.toContain("Retry with these anchors");
    expect(err.message).toMatch(/Read the file and re-target/);
    expect(err.firstOffendingLine).toBe(3);
  });

  it("bans content placement: a retired bound re-added elsewhere still names the served coordinate", () => {
    const dead = lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2, retiredAt: 4 });
    const src = source({ leases: { BBB: dead }, positions: {}, currentSnapshotHash: "C" });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "BBB", anchor_to: "BBB", replace_with: "X" }),
        // The retired text re-appears at line 4, but the payload must not place a window there.
        snapshot: { fileHashes: ["A1", "A2", "A3", "BBB"], fileLines: ["a1", "a2", "a3", "beta"] },
        served: ["A1", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_TARGET_LOST");
    expect(err.message).toMatch(/line 2/);
    expect(err.message).not.toMatch(/line 4/);
    expect(err.servedRows).toEqual([]);
  });

  it("serves [E_UNVERIFIED_RANGE] with the named window when the survivor is live and unshifted", () => {
    const dead = lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1, retiredAt: 6 });
    const live = lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 });
    const src = source({
      leases: { AAA: dead, BBB: live },
      positions: { 2: 2 },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: { fileHashes: ["QQQ", "BBB"], fileLines: ["q", "b"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_UNVERIFIED_RANGE");
    expect(err.message).toContain("Current range (fresh read):");
    expect(err.message).not.toContain("Retry with these anchors");
    expect(err.message).not.toContain("No action is required");
    expect(err.servedRows.length).toBeGreaterThan(0);
    expect(err.firstOffendingLine).toBe(1);
    expect(err.details.cause).toBe("retirement");
  });

  it("emits [E_TARGET_LOST] when the live bound shifted (one stale, one moved)", () => {
    const dead = lease({ lineId: 1, servedSnapshotHash: "S", servedLineNumber: 1, retiredAt: 6 });
    const moved = lease({ lineId: 2, servedSnapshotHash: "S", servedLineNumber: 2 });
    const src = source({
      leases: { AAA: dead, BBB: moved },
      positions: { 2: 3 },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: { fileHashes: ["Q", "Q", "BBB"], fileLines: ["q", "q", "b"] },
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

  it("fails closed to [E_TARGET_LOST] when the named window collapses against a short file", () => {
    // The survivor reads live+unshifted in the fake source, but the served window (lines 10-11)
    // collapses against the 4-line file — the guard fails closed instead of serving nothing.
    const survivor = lease({ lineId: 10, servedSnapshotHash: "S", servedLineNumber: 10 });
    const dead = lease({ lineId: 11, servedSnapshotHash: "S", servedLineNumber: 11, retiredAt: 3 });
    const src = source({
      leases: { AAA: survivor, BBB: dead },
      positions: { 10: 10 },
      currentSnapshotHash: "C",
    });
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" }),
        snapshot: { fileHashes: ["a", "b", "c", "d"], fileLines: ["a", "b", "c", "d"] },
        served: ["AAA", "BBB"],
        source: src,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("E_TARGET_LOST");
    expect((caught as DomainError).servedRows).toEqual([]);
    expect((caught as DomainError).details.cause).toBe("retirement");
  });
});
