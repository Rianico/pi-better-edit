import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure, createCanonStore, canon } from "../../src/hashline/hash";
import {
	ServedVerification,
	verifyServedRange,
	verifyServedRangeResult,
	buildRangeEcho,
	fmtServedRows,
	servedPositionsOf,
} from "../../src/hashline/served-verification";
import { SERVED_ECHO_CAP } from "../../src/constants";

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

	it("duplicate candidate → E_RANGE_UNVERIFIED with duplicate position hint", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		// Served has duplicate for 'a' at positions 0 and 1 (orphaned serve duplicate)
		const served: (string | null)[] = [oldHashes[0]!, oldHashes[0]!, oldHashes[2]!];
		const newContent = "a\nb\nc";
		const fileHashes = _lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");

		const verifier = new ServedVerification(store);
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
			expect(result.code).toBe("E_RANGE_UNVERIFIED");
			expect(result.message).toMatch(/remove_from.*was served at 2 positions/);
			expect(result.servedRows.length).toBeGreaterThan(0);
		}
	});

	it("single-candidate canon heal: a b c -> a 1 b c (relocated line keeps hash)", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "a\n1\nb\nc";
		const newHashes = _lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = newHashes;
		const served: (string | null)[] = [...oldHashes];

		// b was at line 2 in old, now at line 3 in new; c at 3 -> 4
		const bHash = oldHashes[1]!;
		const cHash = oldHashes[2]!;

		const verifier = new ServedVerification(store);
		// Verify via canon healing — should succeed despite hash position shift
		const result = verifier.verify({
			range: {
				startHash: bHash,
				endHash: cHash,
				startLine: 3,
				endLine: 4,
			},
			served,
			fileHashes,
			fileLines,
		});
		expect(result.ok).toBe(true);

		// Also test throwing variant does not throw
		expect(() =>
			verifier.verifyOrThrow({
				range: { startHash: bHash, endHash: cHash, startLine: 3, endLine: 4 },
				served,
				fileHashes,
				fileLines,
			}),
		).not.toThrow();
	});

	it("never-served gap → E_RANGE_UNSERVED (first offending line)", () => {
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
			expect(result.code).toBe("E_RANGE_UNSERVED");
			expect(result.firstOffendingLine).toBe(4);
			expect(result.message).toMatch(/E_RANGE_UNSERVED.*line 4/);
		}
	});

	it("length mismatch without unique heal → E_RANGE_STALE", () => {
		const store = createCanonStore();
		// Use duplicate canon lines so length-heal via canon is ambiguous (matches >1) → not healed
		const fileLinesDup = ["a", "b", "a", "b"];
		const hashesDup = _lineHashesPure(fileLinesDup.join("\n"), store);
		const servedDup: (string | null)[] = [hashesDup[0]!, hashesDup[1]!]; // "a","b" at 0,1
		const verifier = new ServedVerification(store);
		// Request range 1..3 ("a","b","a") length 3 vs servedLen 2 — served span 0..1 (len 2) vs current 3
		// Fast-path gives from 0 to1; length mismatch 2 vs 3; canon heal looks for ["a","b"] which appears twice (at 0 and 2) → matches 2 → not healed → E_RANGE_STALE
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
			expect(result.code).toBe("E_RANGE_STALE");
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
			expect(["E_RANGE_STALE", "E_RANGE_UNVERIFIED"]).toContain(result2.code);
		}
	});

	it("E_RANGE_STALE after healed canon mismatch (interior drift)", () => {
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
		// Range alpha..gamma includes interior beta which is now stale; but hash for beta changed, so hash mismatch -> stale
		// However healing might trigger canon path; we need to ensure stale is reported
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
			expect(result.code).toBe("E_RANGE_STALE");
			expect(result.firstOffendingLine).toBe(2);
		}
	});

	it("pagination: large range echo is capped and includes pagination hint", () => {
		const store = createCanonStore();
		const lines = Array.from({ length: 200 }, (_, i) => `line_${String(i + 1).padStart(3, "0")}`);
		const content = lines.join("\n");
		const hashes = _lineHashesPure(content, store);
		const fileLines = lines;
		const fileHashes = hashes;
		const served: (string | null)[] = [...hashes];

		// Create a stale interior at line 100 to trigger rejection with large echo
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
			expect(result.code).toBe("E_RANGE_STALE");
			// Echo should be capped at SERVED_ECHO_CAP
			expect(result.servedRows.length).toBe(SERVED_ECHO_CAP);
			expect(result.echo).toContain("more — read offset=");
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
			range: { startHash: hashesA[0]!, endHash: hashesA[2]!, startLine: 1, endLine: 3 },
			served: [...hashesA],
			fileHashes: hashesA,
			fileLines: ["a", "b", "c"],
		});
		expect(okA.ok).toBe(true);

		// Same hashes but wrong store should still succeed via population from fileLines (store will be populated)
		const verifierB = new ServedVerification(storeB);
		const okB = verifierB.verify({
			range: { startHash: hashesA[0]!, endHash: hashesA[2]!, startLine: 1, endLine: 3 },
			served: [...hashesA],
			fileHashes: hashesA,
			fileLines: ["a", "b", "c"],
		});
		// storeB will populate missing canons from fileLines/fileHashes during verification
		expect(okB.ok).toBe(true);
	});

	it("global verifyServedRange delegates to deep module and throws ServedRejectionError", () => {
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
		).toThrow(/E_RANGE_UNSERVED/);
	});

	it("servedPositionsOf / buildRangeEcho / fmtServedRows remain accessible", () => {
		const hashes = ["aaa", "bbb", "ccc"];
		const lines = ["a", "b", "c"];
		const served = ["aaa", null, "ccc"];
		expect(servedPositionsOf(served, "aaa")).toEqual([0]);
		expect(servedPositionsOf(served, "bbb")).toEqual([]);
		const echo = buildRangeEcho(1, 2, hashes);
		expect(echo).toHaveLength(2);
		expect(echo[0]!.hash).toBe("aaa");
		const formatted = fmtServedRows(echo, lines);
		expect(formatted).toContain("aaa│a");
	});
});
