import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { applyEdit, EditHashEchoError } from "../../src/hashline/apply";
import { initHasher } from "../../src/hashline/hasher";
import { HASH_SEP } from "../../src/hashline/hash-identity";
import type { LeaseIdentityView, LeaseSpanSource, HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

describe("applyEdit — verification descriptor (issue #115)", () => {
  it("carries filePath + served in one descriptor and still denies a served hash echo", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: [`${hashes[1]}${HASH_SEP}NEW-beta`],
    } as unknown as HEdit;
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served }),
    ).toThrow(EditHashEchoError);
  });

  it("accepts a clean retry through the descriptor", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: ["NEW-beta"],
    } as unknown as HEdit;
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
    });
    expect(result.content).toBe("alpha\nNEW-beta\ngamma\ndelta");
  });

  it("E_SERVED_ECHO pinned: boundary-anchor repetition at a non-corresponding line is accepted", () => {
    const content = "z\nq\nw";
    const hashes = _lineHashesPure(content);
    expect(hashes).not.toContain("AAA");
    expect(hashes).not.toContain("BBB");
    const served: (string | null)[] = ["AAA", "BBB", null];
    const leases: Record<string, LeaseIdentityView> = {
      AAA: {
        lineId: 1,
        canonHash: "z",
        servedSnapshotHash: "S",
        servedLineNumber: 1,
        retiredAt: null,
      },
      BBB: {
        lineId: 2,
        canonHash: "q",
        servedSnapshotHash: "S",
        servedLineNumber: 2,
        retiredAt: null,
      },
    };
    const identity: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => leases[anchor],
      rebasedLineOf: (lineId) => ({ 1: 2, 2: 3 })[lineId],
    };
    const edit = {
      hash_bounds: [{ hash: "AAA" }, { hash: "BBB" }],
      content_lines: ["plain", `AAA${HASH_SEP}BOOM`],
    } as unknown as HEdit;
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      identity,
    });
    expect(result.content).toBe("z\nplain\nAAA│BOOM");
  });

  it("E_SERVED_ECHO pinned: exact served HASH│ at the replaced line is rejected", () => {
    const content = "z\nq\nw";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = ["AAA", "BBB", null];
    const leases: Record<string, LeaseIdentityView> = {
      AAA: {
        lineId: 1,
        canonHash: "z",
        servedSnapshotHash: "S",
        servedLineNumber: 1,
        retiredAt: null,
      },
      BBB: {
        lineId: 2,
        canonHash: "q",
        servedSnapshotHash: "S",
        servedLineNumber: 2,
        retiredAt: null,
      },
    };
    const identity: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: (anchor) => leases[anchor],
      rebasedLineOf: (lineId) => ({ 1: 2, 2: 3 })[lineId],
    };
    const edit = {
      hash_bounds: [{ hash: "AAA" }, { hash: "BBB" }],
      content_lines: [`AAA${HASH_SEP}BOOM`, "plain"],
    } as unknown as HEdit;
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, identity }),
    ).toThrow(/\[E_SERVED_ECHO\]/);
  });
});
