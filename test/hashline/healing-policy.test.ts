import { describe, it, expect, beforeAll } from "vitest";
import { initHasher } from "../../src/hashline/hasher.js";
import { _lineHashesPure, createCanonStore } from "../../src/hashline/hash.js";
import { healingPolicy, healWithPolicy } from "../../src/hashline/healing/policy.js";
import { healSingleCanon } from "../../src/hashline/healing/single-canon.js";
import { healBoundaryCanon } from "../../src/hashline/healing/boundary.js";
import { healOrphanedSpan } from "../../src/hashline/healing/orphan.js";

beforeAll(async () => {
	await initHasher();
});

describe("HealingPolicy — deep module chain orphan → single-canon → boundary", () => {
	it("delegates to single-canon when single heals (orphan chain wins)", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "a\n1\nb\nc";
		_lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = _lineHashesPure(newContent, store);
		const served: (string | null)[] = [...oldHashes];
		const ctx = {
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
		};
		const viaPolicy = healingPolicy.tryHeal(ctx);
		const viaOrphan = healOrphanedSpan(ctx);
		const viaSingle = healSingleCanon({
			served,
			currentLen: 2,
			fileLines,
			startPositions: [1],
			endPositions: [2],
			store,
		});
		expect(viaPolicy).toEqual({ from: 2, to: 3 });
		expect(viaPolicy).toEqual(viaOrphan);
		expect(viaPolicy).toEqual(viaSingle);
	});

	it("delegates to boundary when single does not heal", () => {
		const store = createCanonStore();
		const oldContent = "alpha\nbeta\ngamma";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "alpha\nbeta\ngamma";
		_lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = _lineHashesPure(newContent, store);
		const served: (string | null)[] = [...oldHashes];
		const missingHash = "zzz";
		store.set(missingHash, "alpha");
		const ctx = {
			served,
			fileLines,
			fileHashes,
			startHash: missingHash,
			endHash: oldHashes[2]!,
			currentLen: 3,
			startLine: 1,
			startPositions: [] as number[],
			endPositions: [2],
			store,
		};
		const viaPolicy = healingPolicy.tryHeal(ctx);
		const viaBoundary = healBoundaryCanon({
			served,
			startHash: missingHash,
			endHash: oldHashes[2]!,
			currentLen: 3,
			fileLines,
			fileHashes,
			store,
		});
		// single would be undefined because startPositions not length 1
		expect(viaPolicy).toEqual({ from: 0, to: 2 });
		expect(viaPolicy).toEqual(viaBoundary);
	});

	it("returns undefined when neither strategy heals", () => {
		const store = createCanonStore();
		const content = "a\nb\nc";
		const hashes = _lineHashesPure(content, store);
		const fileLines = content.split("\n");
		const fileHashes = hashes;
		const served: (string | null)[] = [...hashes];
		const ctx = {
			served,
			fileLines,
			fileHashes,
			startHash: hashes[0]!,
			endHash: hashes[2]!,
			currentLen: 2,
			startLine: 1,
			startPositions: [0],
			endPositions: [2],
			store,
		};
		// both hashes still in file -> boundary returns undefined, single checks served span length matches but would find duplicate? for this case orphan returns undefined
		// policy should also be undefined
		expect(healingPolicy.tryHeal(ctx)).toBeUndefined();
	});

	it("healWithPolicy helper uses default policy when none supplied", () => {
		const store = createCanonStore();
		const oldContent = "a\nb\nc";
		const oldHashes = _lineHashesPure(oldContent, store);
		const newContent = "a\n1\nb\nc";
		_lineHashesPure(newContent, store);
		const fileLines = newContent.split("\n");
		const fileHashes = _lineHashesPure(newContent, store);
		const served: (string | null)[] = [...oldHashes];
		const ctx = {
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
		};
		expect(healWithPolicy(ctx)).toEqual(healingPolicy.tryHeal(ctx));
	});

	it("custom policy can be injected (typed boundary — trust inside)", () => {
		const store = createCanonStore();
		const ctx = {
			served: [] as (string | null)[],
			fileLines: [] as string[],
			fileHashes: [] as string[],
			startHash: "aaa",
			endHash: "bbb",
			currentLen: 1,
			startLine: 1,
			startPositions: [] as number[],
			endPositions: [] as number[],
			store,
		};
		const custom = {
			tryHeal: (_c: typeof ctx) => ({ from: 5, to: 5 }) as const,
		};
		expect(healWithPolicy(ctx, custom)).toEqual({ from: 5, to: 5 });
	});
});
