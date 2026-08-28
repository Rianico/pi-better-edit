import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure, createCanonStore } from "../../src/hashline/hash";
import { healSingleCanon } from "../../src/hashline/healing/single-canon";
import { healBoundaryCanon } from "../../src/hashline/healing/boundary";
import { healOrphanedSpan } from "../../src/hashline/healing/orphan";
import { isLengthHealedViaCanon, findCanonMatches, isUniqueSection } from "../../src/hashline/healing/helpers";

beforeAll(async () => {
	await initHasher();
});

describe("healing adapters — focused fixtures, no outer collision crafting", () => {
	it("SingleCanonHeal: relocates b c via canon scan (served a b c -> file a 1 b c)", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "a\n1\nb\nc";
		const newHashes = _lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const served: (string | null)[] = [...oldHashes];
		const startPositions = [1];
		const endPositions = [2];
		const result = healSingleCanon({
			served,
			currentLen: 2,
			fileLines,
			startPositions,
			endPositions,
			store,
		});
		expect(result).toEqual({ from: 2, to: 3 });
		expect(fileLines[result!.from]).toBe("b");
		expect(newHashes[2]).toBeDefined();
	});

	it("SingleCanonHeal: returns undefined when duplicate positions", () => {
		const store = createCanonStore();
		const fileLines = ["a", "b", "c"];
		_lineHashesPure(fileLines.join("\n"), store);
		const served: (string | null)[] = ["aaa", "aaa", "ccc"];
		const result = healSingleCanon({
			served,
			currentLen: 2,
			fileLines,
			startPositions: [0, 1],
			endPositions: [2],
			store,
		});
		expect(result).toBeUndefined();
	});

	it("SingleCanonHeal: returns undefined when null gap in served span", () => {
		const store = createCanonStore();
		const content = "a\nb\nc";
		const hashes = _lineHashesPure(content, store);
		const served: (string | null)[] = [hashes[0]!, null, hashes[2]!];
		const result = healSingleCanon({
			served,
			currentLen: 2,
			fileLines: content.split("\n"),
			startPositions: [0],
			endPositions: [0],
			store,
		});
		expect(result).toBeUndefined();
	});

	it("BoundaryHeal: heals when hashes not in file but canons are unique", () => {
		const store = createCanonStore();
		const oldContent = "alpha\nbeta\ngamma";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "alpha\nbeta\ngamma";
		_lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = _lineHashesPure(newContent, store);
		const served: (string | null)[] = [...oldHashes];
		const result = healBoundaryCanon({
			served,
			startHash: oldHashes[0]!,
			endHash: oldHashes[2]!,
			currentLen: 3,
			fileLines,
			fileHashes,
			store,
		});
		expect(result).toBeUndefined();
		const missingHash = "zzz";
		store.set(missingHash, "alpha");
		const result2 = healBoundaryCanon({
			served,
			startHash: missingHash,
			endHash: oldHashes[2]!,
			currentLen: 3,
			fileLines,
			fileHashes,
			store,
		});
		expect(result2).toEqual({ from: 0, to: 2 });
	});

	it("BoundaryHeal: returns undefined when both hashes still in file", () => {
		const store = createCanonStore();
		const content = "a\nb\nc";
		const hashes = _lineHashesPure(content, store);
		const served: (string | null)[] = [...hashes];
		const result = healBoundaryCanon({
			served,
			startHash: hashes[0]!,
			endHash: hashes[2]!,
			currentLen: 3,
			fileLines: content.split("\n"),
			fileHashes: hashes,
			store,
		});
		expect(result).toBeUndefined();
	});

	it("OrphanHeal: delegates to SingleCanon then Boundary (single wins)", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "a\n1\nb\nc";
		_lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = _lineHashesPure(newContent, store);
		const served: (string | null)[] = [...oldHashes];
		const result = healOrphanedSpan({
			served,
			fileLines,
			fileHashes,
			startHash: oldHashes[1]!,
			endHash: oldHashes[2]!,
			currentLen: 2,
			startLine: 3,
			startPositions: [1],
			endPositions: [2],
			store,
		});
		expect(result).toEqual({ from: 2, to: 3 });
	});

	it("helpers: isLengthHealedViaCanon finds unique canon sequence", () => {
		const store = createCanonStore();
		const fileLines = ["a", "b", "c", "d"];
		const hashes = _lineHashesPure(fileLines.join("\n"), store);
		const served: (string | null)[] = [hashes[0]!, hashes[1]!];
		expect(isLengthHealedViaCanon(served, 0, 2, fileLines, store)).toBe(true);
		const dupLines = ["a", "b", "a", "b"];
		const dupHashes = _lineHashesPure(dupLines.join("\n"), store);
		const dupServed: (string | null)[] = [dupHashes[0]!, dupHashes[1]!];
		expect(isLengthHealedViaCanon(dupServed, 0, 2, dupLines, store)).toBe(false);
	});

	it("helpers: findCanonMatches and isUniqueSection", () => {
		const store = createCanonStore();
		const lines = ["hello world", "hello   world", "other"];
		_lineHashesPure(lines.join("\n"), store);
		expect(findCanonMatches(lines, "helloworld")).toEqual([0, 1]);
		expect(isUniqueSection(["a", "b", "c", "d"], 0, 2)).toBe(true);
		expect(isUniqueSection(["a", "b", "c", "d"], 0, 3)).toBe(true);
		expect(isUniqueSection(["a", "b", "c", "a", "b", "c"], 0, 3)).toBe(false);
		expect(isUniqueSection(["a", "b"], 0, 2)).toBe(true);
	});
});
