import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import {
	getServed,
	upsertServed,
	getReported,
	addReported,
	clearReported,
	deleteServed,
	wipeServed,
} from "../../src/served-store";
import {
	pruneMissing,
	upsertSnapshot,
	getSnapshot,
} from "../../src/snapshot-store";
import { upsertUndo, getUndoEntry } from "../../src/undo-store";
import { HASH_STORE_VERSION } from "../../src/constants";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

let tmpHome: string;
beforeAll(async () => {
	await initHasher();
});

describe("hash-store — served state (issue #2)", () => {
	it("round-trips served entries per file and position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/a.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			expect(getServed(store, "/a.ts")).toEqual(["abc", "def", "ghi"]);
		});
	});

	it("returns an empty record for a path with no served entries", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(getServed(store, "/missing.ts")).toEqual([]);
		});
	});

	it("exposes interior gaps as never-served markers", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			expect(getServed(store, "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});

	it("exposes leading gaps as never-served markers", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 3, hash: "abc" }]);
			expect(getServed(store, "/p.ts")).toEqual([null, null, null, "abc"]);
		});
	});

	it("grows the record to the highest served position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "/p.ts", [{ position: 5, hash: "def" }]);
			expect(getServed(store, "/p.ts")).toEqual([
				"abc",
				null,
				null,
				null,
				null,
				"def",
			]);
		});
	});

	it("overwrites a previously served position", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "/p.ts", [{ position: 0, hash: "def" }]);
			expect(getServed(store, "/p.ts")).toEqual(["def"]);
		});
	});

	it("marks a served position as never-served with a null hash", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 1, hash: "def" },
				{ position: 2, hash: "ghi" },
			]);
			upsertServed(store, "/p.ts", [{ position: 1, hash: null }]);
			expect(getServed(store, "/p.ts")).toEqual(["abc", null, "ghi"]);
		});
	});

	it("ignores an empty entries batch", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", []);
			expect(getServed(store, "/p.ts")).toEqual([]);
		});
	});

	it("rejects an invalid hash without a partial write", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(() =>
				upsertServed(store, "/p.ts", [
					{ position: 0, hash: "abc" },
					{ position: 1, hash: "ZZZZ" },
				]),
			).toThrow(/Invalid served hash/);
			expect(getServed(store, "/p.ts")).toEqual([]);
		});
	});

	it("rejects a negative position without a partial write", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(() =>
				upsertServed(store, "/p.ts", [{ position: -1, hash: "abc" }]),
			).toThrow(/Invalid served position/);
			expect(getServed(store, "/p.ts")).toEqual([]);
		});
	});

	it("deletes the served record for a path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "abc" }]);
			deleteServed(store, "/p.ts");
			expect(getServed(store, "/p.ts")).toEqual([]);
		});
	});

	it("keeps unrelated served records intact when upserting another path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/a.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "/b.ts", [
				{ position: 0, hash: "def" },
				{ position: 1, hash: "ghi" },
			]);
			expect(getServed(store, "/a.ts")).toEqual(["abc"]);
			expect(getServed(store, "/b.ts")).toEqual(["def", "ghi"]);
			deleteServed(store, "/a.ts");
			expect(getServed(store, "/b.ts")).toEqual(["def", "ghi"]);
		});
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [
				{ position: 0, hash: "abc" },
				{ position: 2, hash: "def" },
			]);
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "/p.ts")).toEqual(["abc", null, "def"]);
		});
	});
});

describe("hash-store — served wipe", () => {
	it("removes all served records while keeping snapshots and undo", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/a.ts", [{ position: 0, hash: "abc" }]);
			upsertServed(store, "/b.ts", [{ position: 1, hash: "def" }]);
			upsertSnapshot(store, "/a.ts", contentChecksum("a\n"), 1, ["abc"]);
			upsertUndo(store, "/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});

			wipeServed(store);

			expect(getServed(store, "/a.ts")).toEqual([]);
			expect(getServed(store, "/b.ts")).toEqual([]);
			expect(getSnapshot(store, "/a.ts", "a\n")).toEqual(["abc"]);
			expect(getUndoEntry(store, "/u.ts")).toBeDefined();
		});
	});
});

describe("hash-store — served corrupt row handling", () => {
	async function corruptServed(
		home: string,
		path: string,
		value: string,
	): Promise<void> {
		const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
		db.prepare("UPDATE served SET hashes = ? WHERE path = ?").run(value, path);
		db.close();
	}

	it("treats a row with unparseable hashes as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "/p.ts", "not json");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?")
				.get("/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});

	it("treats a row with malformed hash strings as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "/p.ts", '["ZZ", "ZZZZ", "a!b"]');
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?")
				.get("/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});

	it("treats a row with non-string entries as an empty record and deletes it", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "AAA" }]);
			await corruptServed(home, "/p.ts", "[42]");
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "/p.ts")).toEqual([]);
			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const remaining = check
				.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?")
				.get("/p.ts") as { n: number };
			check.close();
			expect(remaining.n).toBe(0);
		});
	});
});

describe("hash-store — served schema versioning", () => {
	it("clears served state alongside snapshots and undo when the stored version differs", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			upsertServed(store, "/p.ts", [{ position: 0, hash: "XYZ" }]);
			upsertSnapshot(store, "/p.ts", contentChecksum("x\n"), 1, ["XYZ"]);
			upsertUndo(store, "/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			db.close();

			const reloaded = await loadHashStore();
			expect(getServed(reloaded, "/p.ts")).toEqual([]);
			expect(getSnapshot(reloaded, "/p.ts", "x\n")).toBeUndefined();
			expect(getUndoEntry(reloaded, "/u.ts")).toBeUndefined();

			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = check
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			check.close();
			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});
});

describe("hash-store — served pruneMissing", () => {
	it("removes served records for files that no longer exist", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/gone.ts", [{ position: 0, hash: "ZZZ" }]);
			await pruneMissing(store);
			expect(getServed(store, "/gone.ts")).toEqual([]);
		});
	});

	it("keeps served records for files that still exist", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			upsertServed(store, existing, [{ position: 0, hash: "KEP" }]);
			await pruneMissing(store);
			expect(getServed(store, existing)).toEqual(["KEP"]);
		});
	});

	it("prunes served-only records for files with no snapshot or undo row", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			upsertServed(store, "/orphan.ts", [{ position: 0, hash: "ORG" }]);
			await pruneMissing(store);
			expect(getServed(store, "/orphan.ts")).toEqual([]);
		});
	});

	it("prunes served records alongside snapshots and undo in one pass", async () => {
		await withTempHome(async (home) => {
			const existing = join(home, "keep.ts");
			await writeFile(existing, "keep\n", "utf-8");
			const store = await loadHashStore();
			upsertServed(store, existing, [{ position: 0, hash: "KEP" }]);
			upsertServed(store, "/gone.ts", [{ position: 0, hash: "GON" }]);
			upsertSnapshot(store, existing, contentChecksum("keep\n"), 1, ["KEP"]);
			upsertSnapshot(store, "/gone.ts", contentChecksum("gone\n"), 1, ["GON"]);
			upsertUndo(store, existing, {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["KEP"],
				resultContent: "new",
			});
			upsertUndo(store, "/gone.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["GON"],
				resultContent: "new",
			});
			await pruneMissing(store);

			expect(getServed(store, existing)).toEqual(["KEP"]);
			expect(getServed(store, "/gone.ts")).toEqual([]);
			expect(getSnapshot(store, existing, "keep\n")).toEqual(["KEP"]);
			expect(getSnapshot(store, "/gone.ts", "gone\n")).toBeUndefined();
			expect(getUndoEntry(store, existing)).toBeDefined();
			expect(getUndoEntry(store, "/gone.ts")).toBeUndefined();
		});
	});
});

describe("hash-store — reported drift set (issue #6)", () => {
	it("merges reported hashes per file", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "/a.ts", ["abc", "def"]);
			addReported(store, "/a.ts", ["def", "ghi"]);
			expect(getReported(store, "/a.ts")).toEqual(
				new Set(["abc", "def", "ghi"]),
			);
		});
	});

	it("returns an empty set for a path with no reported data", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			expect(getReported(store, "/missing.ts")).toEqual(new Set());
		});
	});

	it("ignores malformed reported data", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			addReported(store, "/p.ts", ["abc"]);
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare("UPDATE served SET reported = 'not json' WHERE path = ?").run(
				"/p.ts",
			);
			db.close();
			expect(getReported(store, "/p.ts")).toEqual(new Set());
		});
	});

	it("clears the reported set for a path", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "/p.ts", ["abc"]);
			clearReported(store, "/p.ts");
			expect(getReported(store, "/p.ts")).toEqual(new Set());
		});
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "/p.ts", ["abc"]);
			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(getReported(reloaded, "/p.ts")).toEqual(new Set(["abc"]));
		});
	});

	it("is wiped alongside the served table", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "/a.ts", ["abc"]);
			wipeServed(store);
			expect(getReported(store, "/a.ts")).toEqual(new Set());
		});
	});

	it("is pruned when the file no longer exists", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			addReported(store, "/gone.ts", ["abc"]);
			await pruneMissing(store);
			expect(getReported(store, "/gone.ts")).toEqual(new Set());
		});
	});

	it("migrates a pre-existing served table to add the reported column", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.exec(
				"CREATE TABLE served (path TEXT PRIMARY KEY, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			db.close();
			const store = await loadHashStore();
			addReported(store, "/p.ts", ["abc"]);
			expect(getReported(store, "/p.ts")).toEqual(new Set(["abc"]));
		});
	});
});

async function withTempHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-served-test-"),
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

function configHome(home: string): string {
	return join(home, ".config", "pi-hashline-edit-lsz");
}

function sqlitePath(home: string): string {
	return join(configHome(home), "hash-store.sqlite");
}
