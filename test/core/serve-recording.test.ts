import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { getServed, upsertServed } from "../../src/served-state";
import {
	planServeRecording,
	recordDiffServes,
	recordEchoServes,
} from "../../src/served-state";
import { scanDrift } from "../../src/drift";
import { initHasher } from "../../src/hashline";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
	await initHasher();
});

let tmpHome: string;
async function withTempHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "serve-recording-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		await run(tmpHome);
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(tmpHome, { recursive: true, force: true });
	}
}

describe("planServeRecording — pure recording policy", () => {
	it("plans plain recording when there is no post-mutation line count", () => {
		expect(planServeRecording({})).toEqual({ mode: "plain" });
		expect(planServeRecording({ firstChangedLine: 4 })).toEqual({
			mode: "plain",
		});
	});

	it("plans truncation clearing from firstChangedLine - 1", () => {
		expect(
			planServeRecording({ resultLineCount: 5, firstChangedLine: 2 }),
		).toEqual({ mode: "truncated", lineCount: 5, clearFrom: 1 });
	});

	it("plans truncation clearing from 0 when the first changed line is unknown", () => {
		expect(planServeRecording({ resultLineCount: 5 })).toEqual({
			mode: "truncated",
			lineCount: 5,
			clearFrom: 0,
		});
	});
});

describe("recordDiffServes — persistence through served-state", () => {
	it("records plain rows when no line count is provided, keeping the unchanged prefix", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
			]);
			await recordDiffServes({
				sessionKey: "s1",
				path,
				servedRows: [{ position: 1, hash: "BET" }],
			});
			expect(getServed(store, "s1", path)).toEqual(["aaa", "BET", "ccc"]);
		});
	});

	it("truncates to the post-mutation line count and clears from the first changed line", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
				{ position: 3, hash: "ddd" },
				{ position: 4, hash: "eee" },
			]);
			await recordDiffServes({
				sessionKey: "s1",
				path,
				servedRows: [
					{ position: 0, hash: "aaa" },
					{ position: 1, hash: "BET" },
					{ position: 2, hash: "ccc" },
				],
				resultLineCount: 3,
				firstChangedLine: 2,
			});
			expect(getServed(store, "s1", path)).toEqual(["aaa", "BET", "ccc"]);
		});
	});

	it("clears from 0 when the first changed line is unknown (full re-serve)", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
			]);
			await recordDiffServes({
				sessionKey: "s1",
				path,
				servedRows: [
					{ position: 0, hash: "AAA" },
					{ position: 1, hash: "BBB" },
				],
				resultLineCount: 2,
			});
			expect(getServed(store, "s1", path)).toEqual(["AAA", "BBB"]);
		});
	});

	it("truncates a full preview to the post-write line count, dropping stale tail serves", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
				{ position: 3, hash: "bbb" },
				{ position: 4, hash: "ddd" },
			]);
			await recordDiffServes({
				sessionKey: "s1",
				path,
				servedRows: [
					{ position: 0, hash: "bbb" },
					{ position: 1, hash: "ddd" },
					{ position: 2, hash: "eee" },
				],
				resultLineCount: 3,
			});
			expect(getServed(store, "s1", path)).toEqual(["bbb", "ddd", "eee"]);
		});
	});

	it("is a no-op for empty rows", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			await recordDiffServes({
				sessionKey: "s1",
				path,
				servedRows: [],
				resultLineCount: 3,
				firstChangedLine: 1,
			});
			expect(getServed(store, "s1", path)).toEqual([]);
		});
	});
});

describe("recordEchoServes — truncation after an external shrink (issue #27)", () => {
	it("truncates the served array to the current line count when the count is provided", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
				{ position: 3, hash: "ddd" },
				{ position: 4, hash: "eee" },
				{ position: 5, hash: "fff" },
				{ position: 6, hash: "ggg" },
				{ position: 7, hash: "hhh" },
			]);
			await recordEchoServes(
				"s1",
				path,
				[
					{ position: 0, hash: "fff" },
					{ position: 1, hash: "ggg" },
				],
				"live",
				2,
			);
			expect(getServed(store, "s1", path)).toEqual(["fff", "ggg"]);
		});
	});

	it("keeps plain recording when no line count is provided", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [{ position: 0, hash: "aaa" }]);
			await recordEchoServes(
				"s1",
				path,
				[{ position: 1, hash: "bbb" }],
				"live",
			);
			expect(getServed(store, "s1", path)).toEqual(["aaa", "bbb"]);
		});
	});
});

describe("scanDrift — truncation after an external shrink (issue #27)", () => {
	it("records drift rows against the current line count, dropping the stale tail", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const path = join(home, "f.txt");
			upsertServed(store, "s1", path, [
				{ position: 0, hash: "aaa" },
				{ position: 1, hash: "bbb" },
				{ position: 2, hash: "ccc" },
				{ position: 3, hash: "ddd" },
				{ position: 4, hash: "eee" },
				{ position: 5, hash: "fff" },
				{ position: 6, hash: "ggg" },
				{ position: 7, hash: "hhh" },
			]);
			const served = getServed(store, "s1", path);
			await scanDrift({
				sessionKey: "s1",
				served,
				resultHashes: ["xxx", "fff", "ggg"],
				resultLines: ["X", "f", "g"],
				range: {
					startLine: 1,
					endLine: 1,
					startHash: "xxx",
					endHash: "xxx",
					delta: 0,
				},
				path,
			});
			const after = getServed(store, "s1", path);
			const fffPositions = after
				.map((h, i) => (h === "fff" ? i : -1))
				.filter((i) => i >= 0);
			const gggPositions = after
				.map((h, i) => (h === "ggg" ? i : -1))
				.filter((i) => i >= 0);
			expect(fffPositions.length).toBeLessThanOrEqual(1);
			expect(gggPositions.length).toBeLessThanOrEqual(1);
		});
	});
});
