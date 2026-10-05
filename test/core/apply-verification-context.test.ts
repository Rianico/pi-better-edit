import { describe, expect, it, beforeAll } from "vitest";
import { contentOnlyHashes } from "../../src/hashline/hash";
import { applyEdit, ServedHashEchoError } from "../../src/hashline/apply";
import { initHasher } from "../../src/hashline/hasher";
import { HASH_SEP, canonDigest } from "../../src/hashline/hash-identity";
import type { LeaseIdentityView, LeaseSpanSource, HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

function canonDigestsFor(content: string): (string | null)[] {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (content === "") return [];
  return lines.map((line) => canonDigest(line));
}

describe("applyEdit — verification descriptor (issue #115)", () => {
  it("carries filePath + served in one descriptor and still refuses a served row", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = contentOnlyHashes(content);
    const served: (string | null)[] = [...hashes];
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    } as unknown as HEdit;
    expect(() =>
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        canonDigests: canonDigestsFor(content),
      }),
    ).toThrow(ServedHashEchoError);
  });

  it("accepts a clean retry through the descriptor", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = contentOnlyHashes(content);
    const served: (string | null)[] = [...hashes];
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }],
      content_lines: ["NEW-beta"],
    } as unknown as HEdit;
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      canonDigests: canonDigestsFor(content),
    });
    expect(result.content).toBe("alpha\nNEW-beta\ngamma\ndelta");
  });

  it("E_SUSPICIOUS_TEXT pinned: anchor-shaped repeat with differing content is accepted", () => {
    const content = "z\nq\nw";
    const hashes = contentOnlyHashes(content);
    expect(hashes).not.toContain("AAAA");
    expect(hashes).not.toContain("BBBB");
    const served: (string | null)[] = ["AAAA", "BBBB", null];
    const leases: Record<string, LeaseIdentityView> = {
      AAAA: {
        lineId: 1,
        canonHash: canonDigest("z"),
        servedSnapshotHash: "S",
        servedLineNumber: 1,
        retiredAt: null,
      },
      BBBB: {
        lineId: 2,
        canonHash: canonDigest("q"),
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
      hash_bounds: [{ hash: "AAAA" }, { hash: "BBBB" }],
      content_lines: ["plain", `AAAA${HASH_SEP}BOOM`],
    } as unknown as HEdit;
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      canonDigests: [canonDigest("z"), canonDigest("q"), null],
      identity,
    });
    expect(result.content).toBe("z\nplain\nAAAA│BOOM");
  });

  it("E_SUSPICIOUS_TEXT pinned: reproduced served row is refused", () => {
    const content = "z\nq\nw";
    const hashes = contentOnlyHashes(content);
    const served: (string | null)[] = ["AAAA", "BBBB", null];
    const leases: Record<string, LeaseIdentityView> = {
      AAAA: {
        lineId: 1,
        canonHash: canonDigest("z"),
        servedSnapshotHash: "S",
        servedLineNumber: 1,
        retiredAt: null,
      },
      BBBB: {
        lineId: 2,
        canonHash: canonDigest("q"),
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
      hash_bounds: [{ hash: "AAAA" }, { hash: "BBBB" }],
      content_lines: [`AAAA${HASH_SEP}z`, "plain"],
    } as unknown as HEdit;
    expect(() =>
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        canonDigests: [canonDigest("z"), canonDigest("q"), null],
        identity,
      }),
    ).toThrow(/\[E_SUSPICIOUS_TEXT\]/);
  });
});
