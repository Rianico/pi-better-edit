import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure, canon } from "../../src/hashline/hash";
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

describe("ServedVerification deep module — decision table", () => {
  it("unique served positions fast-path succeeds (ok)", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const fileLines = content.split("\n");
    const served: (string | null)[] = [...hashes];

    const verifier = new ServedVerification();
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
    const oldContent = "a\nb\nc";
    const oldHashes = _lineHashesPure(oldContent);
    // Served has duplicate for 'a' at positions 0 and 1 (orphaned serve duplicate)
    const served: (string | null)[] = [oldHashes[0]!, oldHashes[0]!, oldHashes[2]!];
    const newContent = "a\nb\nc";
    const fileHashes = _lineHashesPure(newContent);
    const fileLines = newContent.split("\n");

    const verifier = new ServedVerification();
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
    const oldContent = "a\nb\nc";
    const oldHashes = _lineHashesPure(oldContent);
    const newContent = "a\n1\nb\nc";
    const newHashes = _lineHashesPure(newContent);
    const fileLines = newContent.split("\n");
    // The relocated line keeps its content-derived hash (b at 2 -> 3), which is exactly why an
    // un-rebased served array used to be silently relocated by the canon scan.
    expect(oldHashes[1]).toBe(newHashes[2]);
    const served: (string | null)[] = [...oldHashes];

    const verifier = new ServedVerification();
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

  it("never-served gap → E_STALE_RANGE (first offending line, fresh-read serve)", () => {
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9";
    const hashes = _lineHashesPure(content);
    const fileLines = content.split("\n");
    const fileHashes = hashes;
    // Simulate paged read: only lines 1-3 and 7-9 were served, middle gap is null
    const served: (string | null)[] = hashes.map((h, i) => (i < 3 || i >= 6 ? h : null));

    const verifier = new ServedVerification();
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
      expect(result.message).toContain("Current range (fresh read):");
      expect(result.message).not.toContain("Retry with these anchors");
      expect(result.details.cause).toBe("never-served");
    }
  });

  it("length mismatch without unique heal → E_STALE_RANGE", () => {
    // Use duplicate canon lines so length-heal via canon is ambiguous (matches >1) → not healed
    const fileLinesDup = ["a", "b", "a", "b"];
    const hashesDup = _lineHashesPure(fileLinesDup.join("\n"));
    const servedDup: (string | null)[] = [hashesDup[0]!, hashesDup[1]!]; // "a","b" at 0,1
    const verifier = new ServedVerification();
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
    const hashes2 = _lineHashesPure(content2);
    const served2: (string | null)[] = [hashes2[0]!, hashes2[1]!];
    const mutatedFileLines = ["alpha", "BETA", "INSERTED", "gamma"];
    const mutatedFileHashes = _lineHashesPure(mutatedFileLines.join("\n"));
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
    const oldContent = "alpha\nbeta\ngamma";
    const oldHashes = _lineHashesPure(oldContent);
    // New file has same hashes for alpha/gamma but beta changed to BETA (different canon)
    const newContent = "alpha\nBETA\ngamma";
    const newHashes = _lineHashesPure(newContent);
    const fileLines = newContent.split("\n");
    const fileHashes = newHashes;
    const served: (string | null)[] = [...oldHashes];

    const verifier = new ServedVerification();
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
    const lines = Array.from({ length: 200 }, (_, i) => `line_${String(i + 1).padStart(3, "0")}`);
    const content = lines.join("\n");
    const hashes = _lineHashesPure(content);
    const _fileLines = lines;
    const _fileHashes = hashes;
    const served: (string | null)[] = [...hashes];

    // Create a stale interior at line 100 to trigger rejection with a large serve block
    const mutatedLines = [...lines];
    mutatedLines[99] = "MUTATED_100";
    const mutatedContent = mutatedLines.join("\n");
    const mutatedHashes = _lineHashesPure(mutatedContent);

    const verifier = new ServedVerification();
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

  it("stamps each served row with its own file's canon (no hash-keyed cross-file lookup)", () => {
    const linesA = ["a", "b", "c"];
    const hashesA = _lineHashesPure(linesA.join("\n"));
    const rowsA = buildRangeServeRows(1, 3, hashesA, linesA);
    expect(rowsA.map((row) => row.canon)).toEqual(["a", "b", "c"]);

    // WHY: the same 3-char anchor from another file carries THAT file's canon. A hash-keyed global
    // WHY: map would hand back the first file's line here (issue #149).
    const rowsB = buildRangeServeRows(1, 1, [hashesA[0]!], ["x"]);
    expect(rowsB[0]!.canon).toBe("x");

    // WHY: a caller with only hashes claims no canon rather than guessing one.
    expect(buildRangeServeRows(1, 1, hashesA)[0]!.canon).toBeUndefined();
  });

  it("global verifyServedRange delegates to deep module and throws a DomainError", () => {
    const content = "a\nb\nc\nd";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    // Compatibility check for the top-level function.
    expect(() =>
      verifyServedRange({
        served,
        startHash: hashes[0]!,
        endHash: hashes[3]!,
        startLine: 1,
        endLine: 4,
        fileHashes: hashes,
        fileLines: content.split("\n"),
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
      }),
    ).toThrow(/E_STALE_RANGE/);
  });

  it("tombstone boundary serves [E_STALE_ANCHOR] with the current range", () => {
    const servedContent = "a\nb\nc";
    const servedHashes = _lineHashesPure(servedContent);
    const servedCanons = servedContent.split("\n").map((l) => canon(l));
    // The boundary anchor string is still in the file bytes but its canon changed since serving.
    const fileLines = ["CHANGED", "b", "c"];
    const fileHashes = [...servedHashes];
    const verifier = new ServedVerification();
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
