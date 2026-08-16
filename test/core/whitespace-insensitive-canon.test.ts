import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import { lineHashes, _lineHashesPure, CANON_VERSION } from "../../src/hashline";
import { initHasher } from "../../src/hashline/hasher";
import {
	loadHashStore,
	shutdownHashStore,
} from "../../src/hash-store";
import {
	getSnapshot,
	upsertSnapshot,
	snapshotStmts,
} from "../../src/snapshot-store";
import { contentChecksum } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
	await initHasher();
});

describe("canon — ASCII whitespace stripping (ADR-0005)", () => {
	it("hashes whitespace variants of a line identically", async () => {
		const base = await _lineHashesPure("func hello\n");
		const double = await _lineHashesPure("func  hello\n");
		const leading = await _lineHashesPure("  func hello\n");
		const trailing = await _lineHashesPure("func hello \n");
		const tab = await _lineHashesPure("func\thello\n");
		expect(base[0]).toBe(double[0]);
		expect(base[0]).toBe(leading[0]);
		expect(base[0]).toBe(trailing[0]);
		expect(base[0]).toBe(tab[0]);
	});

	it("keeps NBSP and Unicode whitespace significant", async () => {
		const ascii = await _lineHashesPure("func hello\n");
		const nbsp = await _lineHashesPure("func\u00A0hello\n");
		const em = await _lineHashesPure("func\u2003hello\n");
		expect(nbsp[0]).not.toBe(ascii[0]);
		expect(em[0]).not.toBe(ascii[0]);
		expect(nbsp[0]).not.toBe(em[0]);
	});

	it("hashes whitespace-only lines as blank lines", async () => {
		const blank = await _lineHashesPure("\n");
		const spaces = await _lineHashesPure("   \n");
		const tab = await _lineHashesPure("\t\n");
		expect(spaces[0]).toBe(blank[0]);
		expect(tab[0]).toBe(blank[0]);
	});
});

describe("stable mapping — whitespace-insensitive reuse (ADR-0005)", () => {
	it("reuses a hash across a whitespace-only edit", async () => {
		const old = await _lineHashesPure("a\nfunc hello\nc\n");
		const mapped = await lineHashes("a\nfunc  hello\nc\n", undefined, {
			content: "a\nfunc hello\nc\n",
			hashes: old,
			removedHashes: new Set([old[0]!]),
		});
		expect(mapped[1]).toBe(old[1]);
	});

	it("rotates when a token is added (brace merged onto the line)", async () => {
		const old = await _lineHashesPure("a\nfunc hello()\n");
		const mapped = await lineHashes("a\nfunc hello() {\n", undefined, {
			content: "a\nfunc hello()\n",
			hashes: old,
			removedHashes: new Set([old[0]!]),
		});
		expect(mapped[1]).not.toBe(old[1]);
	});
});

describe("snapshot cache — canon-version invalidation (ADR-0005)", () => {
	async function withTempHome(
		run: (home: string) => Promise<void>,
	): Promise<void> {
		const tmp = await mkdtemp(
			join(await getWritableTempRoot(), "pi-canon-version-test-"),
		);
		vi.stubEnv("HOME", tmp);
		vi.stubEnv("XDG_CONFIG_HOME", "");
		try {
			await run(tmp);
		} finally {
			shutdownHashStore();
			vi.unstubAllEnvs();
			await rm(tmp, { recursive: true, force: true });
		}
	}

	function sqlitePath(home: string): string {
		return join(home, ".config", "pi-hashline-edit-lsz", "hash-store.sqlite");
	}

	it("round-trips a snapshot under the current canon version", async () => {
		await withTempHome(async () => {
			const store = await loadHashStore();
			const content = "func hello\nworld\n";
			const hashes = ["aB3", "xY7"];
			upsertSnapshot(
				store,
				"/p.ts",
				contentChecksum(content),
				splitLines(content).length,
				hashes,
			);
			expect(getSnapshot(store, "/p.ts", content)).toEqual(hashes);
		});
	});

	it("treats a pre-bump (old-canon) snapshot as a cache miss", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const content = "func hello\n";
			snapshotStmts(store.db).upsert(
				"/old.ts",
				contentChecksum(content),
				splitLines(content).length,
				JSON.stringify(["ZZZ"]),
				Date.now(),
			);
			expect(getSnapshot(store, "/old.ts", content)).toBeUndefined();

			upsertSnapshot(
				store,
				"/old.ts",
				contentChecksum(content),
				splitLines(content).length,
				["ABC"],
			);
			expect(getSnapshot(store, "/old.ts", content)).toEqual(["ABC"]);
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = db
				.prepare("SELECT checksum FROM snapshots WHERE path = ?")
				.get("/old.ts") as { checksum: string } | undefined;
			db.close();
			expect(row?.checksum.startsWith(`${CANON_VERSION}:`)).toBe(true);
		});
	});

	it("uses the raw whole-file checksum as the cache key base", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const content = "func hello\n";
			upsertSnapshot(
				store,
				"/p.ts",
				contentChecksum(content),
				splitLines(content).length,
				["ABC"],
			);
			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = db
				.prepare("SELECT checksum FROM snapshots WHERE path = ?")
				.get("/p.ts") as { checksum: string } | undefined;
			db.close();
			expect(row?.checksum).toBe(
				`${CANON_VERSION}:${contentChecksum(content)}`,
			);
		});
	});
});
