import { describe, it, expect, beforeAll, vi } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure } from "../../src/hashline/hash";
import { DomainError, type ErrorPayloadMap } from "../../src/domain-errors.js";
import {
  makeServedRejection,
  makeStaleAnchorRejection,
  makeTargetLostRejection,
  verifyRebasedSpan,
  ServedVerification,
  type FileSnapshotContext,
} from "../../src/hashline/served-verification";
import { fmtMismatchWithServes, resEdit, valEdit } from "../../src/hashline/resolve";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve";
import type { LeaseIdentityView, LeaseSpanSource } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

function snapshotFor(
  lines: string[],
  storeHashes: string[],
  path = "probe.ts",
): FileSnapshotContext {
  return { fileHashes: storeHashes, fileLines: lines, filePath: path };
}

describe("task-109: one typed serve block, one builder, one snapshot descriptor", () => {
  it("ServedRejectionError carries a typed readonly servedBlock populated at construction", () => {
    const lines = ["alpha", "beta", "gamma"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const err = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 differs from what was served.",
      startLine: 1,
      endLine: 3,
      snapshot,
      firstOffendingLine: 2,
      cause: "served-range staleness",
    });
    expect(err).toBeInstanceOf(DomainError);
    expect(typeof err.servedBlock).toBe("string");
    expect(err.servedBlock).toContain(`${hashes[1]}│beta`);
    expect(err.message).toContain("Current range (fresh read):");
    expect(err.message).not.toContain("Retry with these anchors");
    expect(err.message).toContain(err.servedBlock);
  });

  it("AnchorMismatchError carries the same typed servedBlock from the stale-anchor builder", () => {
    const lines = ["alpha", "beta"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const err = makeStaleAnchorRejection({
      headline: "anchor is not present in the served leases for probe.ts; nothing was written.",
      startLine: 1,
      endLine: 2,
      snapshot,
      cause: "never-served",
    });
    expect(err).toBeInstanceOf(DomainError);
    expect(typeof err.servedBlock).toBe("string");
    expect(err.servedBlock).toContain(`${hashes[0]}│alpha`);
    expect(err.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(err.message).toContain("Current range:");
    expect(err.message).toContain(err.servedBlock);
  });

  it("both builders share one formatting contract: prefix, serve block, served rows", () => {
    const lines = ["alpha", "beta", "gamma"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const stale = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 differs.",
      startLine: 1,
      endLine: 3,
      snapshot,
      firstOffendingLine: 2,
      cause: "served-range staleness",
    });
    const anchor = makeStaleAnchorRejection({
      headline: "anchor missing.",
      startLine: 1,
      endLine: 3,
      snapshot,
      cause: "never-served",
    });
    for (const err of [stale, anchor]) {
      expect(err.message).toMatch(/^\[MODEL\] \[E_[A-Z_]+\]/);
      expect(err.servedRows).toHaveLength(3);
    }
    // WHY: the range-family code serves a fresh read with no mandate; the stale-anchor code keeps the
    // WHY: retry hint (issue #149 made the two payload shapes deliberately different).
    expect(stale.message).toContain("Current range (fresh read):");
    expect(stale.message).not.toContain("Retry with these anchors");
    expect(anchor.message).toContain("Current range:");
    expect(anchor.message).toContain("Retry with these anchors");
    expect(stale.servedBlock).toBe(anchor.servedBlock);
  });

  it("verify() returns the typed servedBlock without a fallback rebuild", () => {
    const lines = ["alpha", "beta", "gamma"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const served: (string | null)[] = [...hashes];
    const mutatedLines = ["alpha", "BETA", "gamma"];
    const verifier = new ServedVerification();
    const result = verifier.verify({
      range: { startHash: hashes[0]!, endHash: hashes[2]!, startLine: 1, endLine: 3 },
      served,
      fileHashes: _lineHashesPure(mutatedLines.join("\n")),
      fileLines: mutatedLines,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_STALE_RANGE");
      expect(typeof result.servedBlock).toBe("string");
      expect(result.servedBlock).toContain("BETA");
      expect(result.message).toContain(result.servedBlock);
    }
  });

  it("FileSnapshotContext threads through fmtMismatchWithServes", () => {
    const lines = ["a", "b"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const edit = resEdit({ anchor_from: "ZZZ", anchor_to: "YYY", replace_with: "X" });
    const { mismatches } = valEdit(edit, snapshotFor(lines, hashes), undefined);
    const snapshot = snapshotFor(lines, hashes);
    const { message, servedRows } = fmtMismatchWithServes(mismatches, snapshot);
    expect(message).toMatch(/stale anchor/);
    expect(Array.isArray(servedRows)).toBe(true);
  });

  it("FileSnapshotContext threads through valEdit content resolution", () => {
    const lines = ["a", "b", "c"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const edit = resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[2]!, replace_with: "X" });
    const { resolved, mismatches } = valEdit(edit, snapshot, undefined);
    expect(mismatches).toHaveLength(0);
    expect(resolved?.hash_bounds[0].line).toBe(1);
    expect(resolved?.hash_bounds[1].line).toBe(3);
  });

  it("FileSnapshotContext threads through verifyRebasedSpan and resolveLeasedEdit", () => {
    const lines = ["row 1", "row 2"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const leases = new Map<string, LeaseIdentityView>([
      [
        "AAA",
        {
          lineId: 1,
          canonHash: "0",
          servedSnapshotHash: "S",
          servedLineNumber: 1,
          retiredAt: null,
        },
      ],
      [
        "BBB",
        {
          lineId: 2,
          canonHash: "0",
          servedSnapshotHash: "S",
          servedLineNumber: 2,
          retiredAt: null,
        },
      ],
    ]);
    expect(() =>
      verifyRebasedSpan({
        served: ["AAA", "BBB"],
        servedStart: 1,
        servedEnd: 2,
        rebasedStart: 1,
        rebasedEnd: 2,
        snapshot,
        leaseFor: (anchor: string) => leases.get(anchor),
        rebasedLineOf: (lineId: number) => lineId,
      }),
    ).not.toThrow();

    const src: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor: string) =>
        anchor === "AAA"
          ? {
              lineId: 1,
              canonHash: "0",
              servedSnapshotHash: "C",
              servedLineNumber: 1,
              retiredAt: null,
            }
          : anchor === "BBB"
            ? {
                lineId: 3,
                canonHash: "0",
                servedSnapshotHash: "C",
                servedLineNumber: 3,
                retiredAt: null,
              }
            : undefined,
      rebasedLineOf: (lineId: number) => (lineId === 1 ? 1 : lineId === 3 ? 3 : undefined),
    };
    const dupeLines = ["x", "y", "z"];
    const dupeHashes = _lineHashesPure(dupeLines.join("\n"));
    const dupeSnapshot = snapshotFor(dupeLines, dupeHashes);
    const dupeEdit = resEdit({ anchor_from: "AAA", anchor_to: "BBB", replace_with: "X" });
    const resolved = resolveLeasedEdit({
      edit: dupeEdit,
      snapshot: dupeSnapshot,
      served: ["AAA", "m", "BBB"],
      source: src,
    });
    expect(resolved.status).toBe("fast");
  });
});

describe("range-family cause uniformity: explicit evidence, never a borrowed default (G3)", () => {
  it("makeStaleAnchorRejection pins the caller cause and invents none when omitted", () => {
    const lines = ["alpha", "beta"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const explicit = makeStaleAnchorRejection({
      headline: "anchor missing.",
      startLine: 1,
      endLine: 2,
      snapshot,
      cause: "tombstone",
    });
    expect(explicit.details.cause).toBe("tombstone");
    expect(explicit.cause).toBe("tombstone");
    // SAFETY: the cast omits the required cause to pin that no default is invented.
    const omitted = makeStaleAnchorRejection({
      headline: "anchor missing.",
      startLine: 1,
      endLine: 2,
      snapshot,
    } as unknown as Parameters<typeof makeStaleAnchorRejection>[0]);
    expect(omitted.cause).toBeUndefined();
    expect("cause" in omitted.details).toBe(false);
  });

  it("makeTargetLostRejection pins the caller cause and invents none when omitted", () => {
    const explicit = makeTargetLostRejection({
      servedLine: 2,
      path: "probe.ts",
      cause: "retirement",
    });
    expect(explicit.details.cause).toBe("retirement");
    expect(explicit.cause).toBe("retirement");
    // SAFETY: the cast omits the required cause to pin that no default is invented.
    const omitted = makeTargetLostRejection({
      servedLine: 2,
      path: "probe.ts",
    } as unknown as Parameters<typeof makeTargetLostRejection>[0]);
    expect(omitted.cause).toBeUndefined();
    expect("cause" in omitted.details).toBe(false);
  });

  it("every production range rejection carries its explicit cause end to end", () => {
    const lines = ["alpha", "beta", "gamma"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = snapshotFor(lines, hashes);
    const stale = makeServedRejection({
      code: "E_STALE_RANGE",
      headline: "line 2 differs.",
      startLine: 1,
      endLine: 3,
      snapshot,
      firstOffendingLine: 2,
      cause: "served-range staleness",
    });
    const anchor = makeStaleAnchorRejection({
      headline: "anchor missing.",
      startLine: 1,
      endLine: 3,
      snapshot,
      cause: "never-served",
    });
    for (const err of [stale, anchor]) {
      expect(typeof err.details.cause).toBe("string");
      expect(err.details.cause).toBe(err.cause);
    }
    expect(stale.details.cause).toBe("served-range staleness");
    expect(anchor.details.cause).toBe("never-served");
  });

  it("verify() rethrows a causeless range rejection instead of inventing a cause", () => {
    // SAFETY: the cast builds the causeless rejection the type now forbids, pinning the
    // SAFETY: adapter: a missing cause is a builder defect and must surface loud, never as
    // SAFETY: an invented "served-range staleness".
    const causeless = new DomainError("E_TARGET_LOST", {
      servedLine: 2,
    } as unknown as ErrorPayloadMap["E_TARGET_LOST"]);
    const verifier = new ServedVerification();
    const spy = vi.spyOn(verifier, "verifyOrThrow").mockImplementation(() => {
      throw causeless;
    });
    try {
      expect(() =>
        verifier.verify({
          range: { startHash: "AAA", endHash: "BBB", startLine: 1, endLine: 2 },
          served: ["AAA", "BBB"],
          fileHashes: ["AAA", "BBB"],
          fileLines: ["a", "b"],
        }),
      ).toThrow(causeless);
    } finally {
      spy.mockRestore();
    }
  });
});
