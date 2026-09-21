import { beforeAll, describe, expect, it } from "vitest";

import { applyEdit } from "../../src/hashline/apply";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import type { HEdit, LeaseIdentityView, LeaseSpanSource } from "../../src/hashline/resolve";
import { DomainError } from "../../src/domain-errors.js";

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
  /**
   * The reproducer from #151 scoping note §1. Paged reads leave a served mirror whose interior
   * belongs to an older snapshot than its boundaries, and the externally rewritten interior line
   * happens to hash to the same 3-char anchor — so the hash tier of `verifyServedRange` cannot see
   * the drift. Before #151 the canon tier was the only thing rejecting this span, which is why the
   * span must still reject with NO canon evidence at all: the interior check is a lease-identity
   * question, not a content question.
   */
  it("rejects the span with [E_STALE_RANGE] with no canon evidence supplied", () => {
    const servedLines = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`);
    const servedHashes = _lineHashesPure(servedLines.join("\n")); // S0 read of lines 1-10
    const diskLines = [...servedLines];
    diskLines[4] = "row 5 rewritten externally";
    const diskHashes = _lineHashesPure(diskLines.join("\n")); // S1 on disk
    // SAFETY: inject the collision. Without it the anchor rotates and the hash tier alone catches
    // SAFETY: the drift, so a stale-mirror test would pass for the wrong reason and prove nothing.
    diskHashes[4] = servedHashes[4]!;

    const served: (string | null)[] = [...servedHashes];
    const leases = new Map<string, LeaseIdentityView>();
    // The partial re-read of lines 1 and 10 re-leases only the boundaries, under S1 = C.
    leases.set(
      servedHashes[0]!,
      lease({ lineId: 1, servedSnapshotHash: "C", servedLineNumber: 1 }),
    );
    leases.set(
      servedHashes[9]!,
      lease({ lineId: 10, servedSnapshotHash: "C", servedLineNumber: 10 }),
    );
    // The interior keeps its S0 leases; line 5's identity is gone from S1's lineage, so
    // materialization retired it and its anchor now names a line that no longer exists.
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
    expect(err.details.cause).toBe("served-range staleness");
  });
});
