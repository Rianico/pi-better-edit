import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure, createCanonStore, canon } from "../../src/hashline/hash";
import {
  ServedVerification,
  verifyServedRange,
  verifyServedRangeResult as _verifyServedRangeResult,
  buildRangeServeRows,
  fmtServedRows,
  servedPositionsOf,
} from "../../src/hashline/served-verification";
import { SERVED_ROWS_CAP } from "../../src/constants";

beforeAll(async () => {
  await initHasher();
});

describe("ServedVerification deep module — isolated store & decision table", () => {
  it("unique served positions fast-path succeeds (ok)", () => {
    const store = createCanonStore();
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content, store);
    const fileLines = content.split("\n");
    const served: (string | null)[] = [...hashes];

    const verifier = new ServedVerification(store);
    const result = verifier.verify({
      range: {
        startHash: hashes[0]!,
        endHash: hashes[2]!,
        startLine: 1,
        endLine: 3,
      },
      served,
      fileHashes: hashes,
      fileLines,
    });
    expect(result.ok).toBe(true);
  });

  it("duplicate candidate → E_UNKNOWN_ANCHOR with no rows", () => {
    const store = createCanonStore();
    const oldContent = "a\nb\nc";
    const oldHashes = _lineHashesPure(oldContent, store);
    // Served has duplicate for 'a' at positions 0 and 1 (orphaned serve duplicate)
    const served: (string | null)[] = [oldHashes[0]!, oldHashes[0]!, oldHashes[2]!];
    const newContent = "a\nb\nc";
    const fileHashes = _lineHashesPure(newContent, store);
    const fileLines = newContent.split("\n");

    const verifier = new ServedVerification(store);
    let caught: unknown;
    try {
      verifier.verifyOrThrow({
        range: {
          startHash: oldHashes[0]!,
          endHash: oldHashes[2]!,
          startLine: 1,
          endLine: 3,
        },
        served,
        fileHashes,
        fileLines,
      });
    } catch (error) {
      caught = error;
    }
    const err = caught as { code?: string; message: string; servedRows: Array<unknown> };
    expect(err.code).toBe("E_UNKNOWN_ANCHOR");
    expect(err.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect(err.servedRows).toEqual([]);
  });

  it("un-rebased served array fails closed with E_UNKNOWN_ANCHOR (ADR-0008 retired)", () => {
    const store = createCanonStore();
    const oldContent = "a\nb\nc";
    const oldHashes = _lineHashesPure(oldContent, store);
    const newContent = "a\n1\nb\nc";
    const newHashes = _lineHashesPure(newContent, store);
    const fileLines = newContent.split("\n");
    // The relocated line keeps its content-derived hash (b at 2 -> 3), which is exactly why an
    // un-rebased served array used to be silently relocated by the canon scan.
    expect(oldHashes[1]).toBe(newHashes[2]);
    const served: (string | null)[] = [...oldHashes];

    const verifier = new ServedVerification(store);
    // MVCC owns coordinate realignment (`pairSnapshots` + `line_lineage`); a caller that did not
    // rebase has no served position for the shifted line, so `verify` rejects instead of healing.
    let caught: unknown;
    try {
      verifier.verifyOrThrow({
        range: {
          startHash: newHashes[1]!,
          endHash: oldHashes[2]!,
          startLine: 2,
          endLine: 3,
        },
        served,
        fileHashes: newHashes,
        fileLines,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("E_UNKNOWN_ANCHOR");

    // The throwing variant rejects too — no silent canon relocation.
    expect(() =>
      verifier.verifyOrThrow({
        range: {
          startHash: newHashes[1]!,
          endHash: oldHashes[2]!,
          startLine: 2,
          endLine: 3,
        },
        served,
        fileHashes: newHashes,
        fileLines,
      }),
    ).toThrow(/E_UNKNOWN_ANCHOR/);
  });

  it("never-served gap → E_STALE_RANGE (first offending line, retry with served rows)", () => {
    const store = createCanonStore();
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9";
    const hashes = _lineHashesPure(content, store);
    const fileLines = content.split("\n");
    const fileHashes = hashes;
    // Simulate paged read: only lines 1-3 and 7-9 were served, middle gap is null
    const served: (string | null)[] = hashes.map((h, i) => (i < 3 || i >= 6 ? h : null));

    const verifier = new ServedVerification(store);
    const l1Hash = hashes[0]!;
    const l9Hash = hashes[8]!;
    const result = verifier.verify({
      range: { startHash: l1Hash, endHash: l9Hash, startLine: 1, endLine: 9 },
      served,
      fileHashes,
      fileLines,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_STALE_RANGE");
      expect(result.firstOffendingLine).toBe(4);
      expect(result.message).toMatch(/E_STALE_RANGE.*line 4/);
      expect(result.message).toContain("Retry with these anchors");
      expect(result.details.cause).toBe("never-served");
    }
  });

  it("length mismatch without unique heal → E_STALE_RANGE", () => {
    const store = createCanonStore();
    // Use duplicate canon lines so length-heal via canon is ambiguous (matches >1) → not healed
    const fileLinesDup = ["a", "b", "a", "b"];
    const hashesDup = _lineHashesPure(fileLinesDup.join("\n"), store);
    const servedDup: (string | null)[] = [hashesDup[0]!, hashesDup[1]!]; // "a","b" at 0,1
    const verifier = new ServedVerification(store);
    // Request range 1..3 ("a","b","a") length 3 vs servedLen 2 — served span 0..1 (len 2) vs current 3
    // Fast-path gives from 0 to1; length mismatch 2 vs 3; canon heal looks for ["a","b"] which appears twice (at 0 and 2) → matches 2 → not healed → E_STALE_RANGE
    const result = verifier.verify({
      range: {
        startHash: hashesDup[0]!,
        endHash: hashesDup[1]!,
        startLine: 1,
        endLine: 3,
      },
      served: servedDup,
      fileHashes: hashesDup,
      fileLines: fileLinesDup,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_STALE_RANGE");
      expect(result.message).toMatch(/served span.*no longer matches/);
    }
    // Also ensure simple hash mismatch case still gives stale
    const content2 = "alpha\nbeta\ngamma";
    const hashes2 = _lineHashesPure(content2, store);
    const served2: (string | null)[] = [hashes2[0]!, hashes2[1]!];
    const mutatedFileLines = ["alpha", "BETA", "INSERTED", "gamma"];
    const mutatedFileHashes = _lineHashesPure(mutatedFileLines.join("\n"), store);
    const result2 = verifier.verify({
      range: {
        startHash: hashes2[0]!,
        endHash: hashes2[1]!,
        startLine: 1,
        endLine: 3,
      },
      served: served2,
      fileHashes: mutatedFileHashes,
      fileLines: mutatedFileLines,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.code).toBe("E_STALE_RANGE");
    }
  });

  it("E_STALE_RANGE after healed canon mismatch (interior drift)", () => {
    const store = createCanonStore();
    const oldContent = "alpha\nbeta\ngamma";
    const oldHashes = _lineHashesPure(oldContent, store);
    // New file has same hashes for alpha/gamma but beta changed to BETA (different canon)
    const newContent = "alpha\nBETA\ngamma";
    const newHashes = _lineHashesPure(newContent, store);
    const fileLines = newContent.split("\n");
    const fileHashes = newHashes;
    const served: (string | null)[] = [...oldHashes];

    const verifier = new ServedVerification(store);
    // WHY: interior drift still reports the offending line (healing is retired, so the mismatch is
    // WHY: reported directly instead of being routed through a canon scan).
    const result = verifier.verify({
      range: {
        startHash: oldHashes[0]!,
        endHash: oldHashes[2]!,
        startLine: 1,
        endLine: 3,
      },
      served,
      fileHashes,
      fileLines,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_STALE_RANGE");
      expect(result.firstOffendingLine).toBe(2);
    }
  });

  it("pagination: large range serve block is capped and includes pagination hint", () => {
    const store = createCanonStore();
    const lines = Array.from({ length: 200 }, (_, i) => `line_${String(i + 1).padStart(3, "0")}`);
    const content = lines.join("\n");
    const hashes = _lineHashesPure(content, store);
    const _fileLines = lines;
    const _fileHashes = hashes;
    const served: (string | null)[] = [...hashes];

    // Create a stale interior at line 100 to trigger rejection with a large serve block
    const mutatedLines = [...lines];
    mutatedLines[99] = "MUTATED_100";
    const mutatedContent = mutatedLines.join("\n");
    const mutatedHashes = _lineHashesPure(mutatedContent, store);

    const verifier = new ServedVerification(store);
    const result = verifier.verify({
      range: {
        startHash: hashes[0]!,
        endHash: hashes[199]!,
        startLine: 1,
        endLine: 200,
      },
      served,
      fileHashes: mutatedHashes,
      fileLines: mutatedLines,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("E_STALE_RANGE");
      // Serve block should be capped at SERVED_ROWS_CAP
      expect(result.servedRows.length).toBe(SERVED_ROWS_CAP);
      expect(result.servedBlock).toContain("more — read offset=");
      expect(result.message).toContain("more — read offset=");
    }
  });

  it("adapter: in-memory served rows and canon store isolation (no global pollution)", () => {
    const storeA = createCanonStore();
    const storeB = createCanonStore();
    const hashesA = _lineHashesPure("a\nb\nc", storeA);
    const hashesB = _lineHashesPure("x\ny\nz", storeB);
    // storeA knows about a,b,c; storeB knows about x,y,z; they should not cross-pollute
    expect(storeA.get(hashesA[0]!)).toBe(canon("a"));
    expect(storeA.get(hashesB[0]!)).toBeUndefined();
    expect(storeB.get(hashesB[0]!)).toBe(canon("x"));
    expect(storeB.get(hashesA[0]!)).toBeUndefined();

    // Verify with storeA succeeds for its own content
    const verifierA = new ServedVerification(storeA);
    const okA = verifierA.verify({
      range: {
        startHash: hashesA[0]!,
        endHash: hashesA[2]!,
        startLine: 1,
        endLine: 3,
      },
      served: [...hashesA],
      fileHashes: hashesA,
      fileLines: ["a", "b", "c"],
    });
    expect(okA.ok).toBe(true);

    // Same hashes but wrong store should still succeed via population from fileLines (store will be populated)
    const verifierB = new ServedVerification(storeB);
    const okB = verifierB.verify({
      range: {
        startHash: hashesA[0]!,
        endHash: hashesA[2]!,
        startLine: 1,
        endLine: 3,
      },
      served: [...hashesA],
      fileHashes: hashesA,
      fileLines: ["a", "b", "c"],
    });
    // storeB will populate missing canons from fileLines/fileHashes during verification
    expect(okB.ok).toBe(true);
  });

  it("global verifyServedRange delegates to deep module and throws a DomainError", () => {
    const store = createCanonStore();
    const content = "a\nb\nc\nd";
    const hashes = _lineHashesPure(content, store);
    const served: (string | null)[] = [...hashes];
    // Inject via global for compatibility test: use top-level function with store param
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[3]!,
        startLine: 1,
        endLine: 4,
        fileHashes: hashes,
        fileLines: content.split("\n"),
        canonStore: store,
      }),
    ).not.toThrow();

    // Never-served gap should throw via top-level
    const servedGap: (string | null)[] = [hashes[0]!, null, hashes[2]!, hashes[3]!];
    expect(() =>
      verifyServedRange({
        served: servedGap,
        startHash: hashes[0]!,
        endHash: hashes[3]!,
        startLine: 1,
        endLine: 4,
        fileHashes: hashes,
        fileLines: content.split("\n"),
        canonStore: store,
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("tombstone boundary serves [E_STALE_ANCHOR] with the current range", () => {
    const store = createCanonStore();
    const servedContent = "a\nb\nc";
    const servedHashes = _lineHashesPure(servedContent, store);
    const servedCanons = servedContent.split("\n").map((l) => canon(l));
    // The boundary anchor string is still in the file bytes but its canon changed since serving.
    const fileLines = ["CHANGED", "b", "c"];
    const fileHashes = [...servedHashes];
    const verifier = new ServedVerification(store);
    let caught: unknown;
    try {
      verifier.verifyOrThrow({
        range: { startHash: servedHashes[0]!, endHash: servedHashes[2]!, startLine: 1, endLine: 3 },
        served: [...servedHashes],
        fileHashes,
        fileLines,
        tombstone: new Set([servedHashes[0]!]),
        servedCanons,
      });
    } catch (error) {
      caught = error;
    }
    const err = caught as {
      code?: string;
      message: string;
      servedRows: Array<unknown>;
      details?: { cause?: string };
    };
    expect(err.code).toBe("E_STALE_ANCHOR");
    expect(err.message).toMatch(/\[MODEL\] \[E_STALE_ANCHOR\]/);
    expect(err.message).toContain("Current range:");
    expect(err.message).toContain("Retry with these anchors");
    expect(err.details?.cause).toBe("tombstone");
    expect(err.servedRows.length).toBeGreaterThan(0);
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
