/**
 * The #151 scoping-note reproducer: paged reads leave a served mirror whose interior belongs to an
 * older snapshot than its boundaries, and an externally rewritten interior line that happens to hash
 * to the same 4-char anchor. With the mirror hash tier retired (#10) only the canon tier rejected
 * such a span, so this file pins the replacement: the span rejects with NO canon evidence at all,
 * because the interior check is a lease-identity question, not a content question.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { applyEdit } from "../../src/hashline/apply";
import { contentOnlyHashes } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";
import type { HEdit, LeaseIdentityView, LeaseSpanSource } from "../../src/hashline/resolve";
import { verifyRebasedSpan } from "../../src/served-session/serve-render";
import { DomainError } from "../../src/domain-errors.js";
import type { SpanMode } from "../../src/span-mode-config.js";

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

describe("mixed-snapshot interior under a same-anchor collision (#151)", () => {
  it("rejects the span with [E_STALE_RANGE] with no canon evidence supplied", () => {
    const servedLines = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`);
    const servedHashes = contentOnlyHashes(servedLines.join("\n"));
    const diskLines = [...servedLines];
    diskLines[4] = "row 5 rewritten externally";
    const diskHashes = contentOnlyHashes(diskLines.join("\n"));
    // SAFETY: inject the collision. Without it the anchor rotates and the hash tier alone catches
    // SAFETY: the drift, so a stale-mirror test would pass for the wrong reason and prove nothing.
    diskHashes[4] = servedHashes[4]!;

    const served: (string | null)[] = [...servedHashes];
    const leases = new Map<string, LeaseIdentityView>();
    leases.set(
      servedHashes[0]!,
      lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 }),
    );
    leases.set(
      servedHashes[9]!,
      lease({ lineId: 10, servedSnapshotHash: "C", servedLineNumber: 10 }),
    );
    for (const i of [1, 2, 3, 5, 6, 7, 8]) {
      leases.set(
        servedHashes[i]!,
        lease({ lineId: i + 1, servedSnapshotHash: "S0", servedLineNumber: i + 1 }),
      );
    }
    leases.set(
      servedHashes[4]!,
      lease({
        lineId: 5,
        servedSnapshotHash: "S0",
        servedLineNumber: 5,
        retiredAt: 7,
      }),
    );
    const positions: Record<number, number> = {};
    for (const lineId of [1, 2, 3, 4, 6, 7, 8, 9, 10]) positions[lineId] = lineId;

    const identity: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => leases.get(anchor),
      rebasedLineOf: (lineId) => positions[lineId],
    };
    const edit: HEdit = {
      hash_bounds: [{ hash: servedHashes[0]! }, { hash: servedHashes[9]! }],
      content_lines: ["X"],
    };

    let caught: unknown;
    try {
      applyEdit(diskLines.join("\n"), edit, undefined, diskHashes, {
        filePath: "paged.txt",
        served,
        identity,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.message).toMatch(/\[MODEL\] \[E_STALE_RANGE\]/);
    expect(err.message).toContain("Current range (fresh read):");
    expect(err.details.cause).toBe("retirement");
  });
});

describe("verifyRebasedSpan — diagnosis for the mirror and lease rows (#151 review)", () => {
  const servedLines = ["row 1", "row 2", "row 3"];
  const hashes = contentOnlyHashes(servedLines.join("\n"));
  const snapshot = { fileHashes: hashes, fileLines: servedLines };
  const positions: Record<number, number> = { 1: 1, 2: 2, 3: 3 };

  function run(overrides: {
    served: (string | null)[];
    leasedRetired?: number;
    moved?: number;
    spanMode?: SpanMode;
  }): DomainError | undefined {
    const leases = new Map<string, LeaseIdentityView>();
    for (let i = 0; i < 3; i++) {
      leases.set(
        hashes[i]!,
        lease({
          lineId: i + 1,
          servedSnapshotHash: "S",
          servedLineNumber: i + 1,
          retiredAt: overrides.leasedRetired === i + 1 ? 7 : null,
        }),
      );
    }
    try {
      verifyRebasedSpan({
        served: overrides.served,
        servedStart: 1,
        servedEnd: 3,
        rebasedStart: 1,
        rebasedEnd: 3,
        snapshot,
        leaseFor: (anchor) => leases.get(anchor),
        rebasedLineOf: (lineId) => (overrides.moved === lineId ? lineId + 1 : positions[lineId]),
        ...(overrides.spanMode !== undefined ? { spanMode: overrides.spanMode } : {}),
      });
      return undefined;
    } catch (error) {
      return error as DomainError;
    }
  }

  function span(overrides: {
    served: (string | null)[];
    leasedRetired?: number;
    moved?: number;
    spanMode?: SpanMode;
  }): DomainError {
    const caught = run(overrides);
    expect(caught).toBeInstanceOf(DomainError);
    return caught as DomainError;
  }

  it("reports a truncated mirror row as an unreconcilable record, never 'was never served'", () => {
    const err = span({ served: [hashes[0]!, hashes[1]!] });
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.details.cause).toBe("served-range staleness");
    expect(err.message).toContain("no served mirror row left");
    expect(err.message).not.toContain("was never served");
  });

  it("accepts an explicitly cleared interior mirror slot — no identity to verify (ADR-0024)", () => {
    expect(run({ served: [hashes[0]!, null, hashes[2]!] })).toBeUndefined();
  });

  it("refuses an interior mirror slot the session never served under strict mode", () => {
    const err = span({ served: [hashes[0]!, null, hashes[2]!], spanMode: "strict" });
    expect(err.code).toBe("E_UNSERVED_RANGE");
    expect(err.servedRows).toEqual([]);
    expect(err.servedBlock).toBe("");
    expect(err.details.cause).toBe("never-served");
    expect(err.message.startsWith("[MODEL] [E_UNSERVED_RANGE] ")).toBe(true);
    expect(err.message).toContain("line 2");
  });

  it("reports a retired interior lease as retirement", () => {
    const err = span({ served: [...hashes], leasedRetired: 2 });
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.details.cause).toBe("retirement");
  });

  it("reports a live lease that moved off its coordinate as drift", () => {
    const err = span({ served: [...hashes], moved: 2 });
    expect(err.code).toBe("E_STALE_RANGE");
    expect(err.details.cause).toBe("served-range staleness");
  });
});
