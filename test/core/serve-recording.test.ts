import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import {
	createSessionHandle,
	getServed,
	upsertServed,
} from "../../src/served-session/index.js";
import {
	planServeRecording,
	recordDiffServes,
	recordEchoServes,
} from "../../src/served-session/index.js";
import { computeDrift, scanDrift } from "../../src/drift";
import { initHasher } from "../../src/hashline";
import { getWritableTempRoot } from "../support/fixtures";
import { execEdits } from "../../src/mutation-engine/pipeline.js";
import { canon } from "../../src/hashline/hash-identity.js";
import { readNormFile } from "../../src/file-reader.js";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";

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
			await recordEchoServes("s1", path, [{ position: 1, hash: "bbb" }], "live");
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

describe("write then edit — same-session drift-free (#70)", () => {
  it("dense write-serve clears stale rows so the next edit reports no drift", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const absPath = join(home, "w.txt");
      await writeFile(absPath, "a\nb\nc\n");
      upsertServed(store, "s1", absPath, [
        { position: 0, hash: "zz0" },
        { position: 1, hash: "zz1" },
        { position: 5, hash: "zz5" },
      ]);
      const hooks = createLifecycleHooks({ sessionKeyFor: () => "s1" });
      await hooks.onWrite(
        {
          toolName: "write",
          isError: false,
          input: { path: "w.txt" },
          content: [{ type: "text", text: "ok" }],
        },
        {
          cwd: home,
          sessionManager: { getSessionId: () => "s1" },
          ui: { notify: vi.fn() },
        },
      );
      const served = getServed(store, "s1", absPath);
      expect(served).toHaveLength(3);
      expect(served).not.toContain("zz0");
      expect(served).not.toContain("zz1");
      expect(served).not.toContain("zz5");
      const file = await execEdits(
        {
          path: "w.txt",
          edits: [{ remove_from: served[0]!, remove_to: served[0]!, replacement_text: "A\n" }],
        },
        home,
        { store, sessionKey: "s1" },
      );
      expect(file.appliedCount).toBe(1);
      expect(file.driftNotice).toBeUndefined();
    });
  });
});

describe("sequential edits — rotated serves with surviving canons stay silent (#68)", () => {
	it("edit, failed edit, partial read, then edit elsewhere reports no drift", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const absPath = join(home, "dup.ts");
			const dup = "});";
			const startLines = [
				'import { x } from "y";',
				"const a = 1;",
				"const b = 2;",
				"function f() {",
				dup,
				dup,
				dup,
				dup,
				"const c = 3;",
				dup,
				dup,
				dup,
				dup,
				"const d = 4;",
				"export default f;",
			];
			await writeFile(absPath, startLines.join("\n") + "\n");
			const seed = await readNormFile("dup.ts", home, { store });
			const handle = createSessionHandle("s1", seed.absolutePath, store);
			const seedCanons = seed.normalized.split("\n").map((line) => canon(line));
			await handle.record(
				seed.fileHashes.map((hash, position) => ({ position, hash })),
			);
			await handle.recordEpoch({
				rows: seed.fileHashes.map((hash, position) => ({ position, hash })),
				lineCount: seed.fileHashes.length,
				fullReadHashes: [...seed.fileHashes],
				fullReadCanons: [...seedCanons],
				snapshotId: "snap-e2e-full",
				isFullRead: true,
			});
			const first = await execEdits(
				{
					path: "dup.ts",
					edits: [
						{
							remove_from: seed.fileHashes[0]!,
							remove_to: seed.fileHashes[0]!,
							replacement_text: `${startLines[0]}\n${Array(10).fill(dup).join("\n")}`,
						},
					],
				},
				home,
				{ store, sessionKey: "s1" },
			);
			expect(first.appliedCount).toBe(1);
			expect(first.driftNotice).toBeUndefined();
			await expect(
				execEdits(
					{
						path: "dup.ts",
						edits: [
							{
								remove_from: "findActivatingFile,",
								remove_to: "x",
								replacement_text: "y",
							},
						],
					},
					home,
					{ store, sessionKey: "s1" },
				),
			).rejects.toThrow();
			const afterFirst = getServed(store, "s1", absPath);
			const curText = await readFile(absPath, "utf8");
			const curLines = curText.split("\n");
			if (curLines.at(-1) === "") curLines.pop();
			const curCanons = curLines.map((line) => canon(line));
			const curHashes = afterFirst.filter((h): h is string => h !== null);
			await handle.recordEpoch({
				rows: [2, 3, 4, 5].map((position) => ({
					position,
					hash: afterFirst[position]!,
				})),
				lineCount: curLines.length,
				fullReadHashes: [...curHashes],
				fullReadCanons: [...curCanons],
				snapshotId: "snap-e2e-partial",
				isFullRead: false,
			});
			const dupPositions: number[] = [];
			curLines.forEach((line, index) => {
				if (line === dup) dupPositions.push(index);
			});
			const rotated = dupPositions.slice(-3);
			const fresh = ["q01", "q02", "q03"];
			rotated.forEach((position, i) => {
				expect(curHashes).not.toContain(fresh[i]!);
			});
			upsertServed(
				store,
				"s1",
				absPath,
				rotated.map((position, i) => ({ position, hash: fresh[i]! })),
			);
			const driftedServed = getServed(store, "s1", absPath);
			const targetLine = "const d = 4;";
			const targetPos = curLines.indexOf(targetLine);
			expect(targetPos).toBeGreaterThan(-1);
			expect(rotated).not.toContain(targetPos);
			const second = await execEdits(
				{
					path: "dup.ts",
					edits: [
						{
							remove_from: afterFirst[targetPos]!,
							remove_to: afterFirst[targetPos]!,
							replacement_text: "const d = 40;",
						},
					],
				},
				home,
				{ store, sessionKey: "s1" },
			);
			expect(second.appliedCount).toBe(1);
			expect(second.result).toContain("const d = 40;");
			expect(second.driftNotice).toBeUndefined();
			const legacyLines = second.result.split("\n");
			if (legacyLines.at(-1) === "") legacyLines.pop();
			const legacy = computeDrift({
				served: driftedServed,
				resultHashes: second.resultHashes,
				resultLines: legacyLines,
				range: second.range,
				reported: new Set(),
			});
			expect(legacy).toBeDefined();
			expect(legacy!.total).toBe(3);
		});
	});
});
