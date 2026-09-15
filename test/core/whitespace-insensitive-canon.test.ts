import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import { lineHashes, _lineHashesPure, CANON_VERSION } from "../../src/hashline";
import { initHasher } from "../../src/hashline/hasher";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { getSnapshot, upsertSnapshot } from "../../src/snapshot-store";
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
  async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
    const tmp = await mkdtemp(join(await getWritableTempRoot(), "pi-canon-version-test-"));
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
    return join(home, ".config", "pi-better-edit", "hash-store.sqlite");
  }

  it("round-trips a snapshot under the current canon version", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const content = "func hello\nworld\n";
      const hashes = ["aB3", "xY7"];
      upsertSnapshot(store, {
        path: "/p.ts",
        snapshotHash: `${CANON_VERSION}:${contentChecksum(content)}`,
        lineCount: splitLines(content).length,
        hashes,
        content,
      });
      expect(getSnapshot(store, "/p.ts", content)).toEqual(hashes);
    });
  });

  it("treats a pre-bump (old-canon) snapshot as a cache miss", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const content = "func hello\n";
      const rawChecksum = contentChecksum(content);
      store.db
        .prepare(
          "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed) VALUES (?, ?, ?, ?, 1)",
        )
        .run("/old.ts", rawChecksum, splitLines(content).length, Date.now());
      const snapshotId = (
        store.db
          .prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ?")
          .get("/old.ts") as {
          snapshot_id: number;
        }
      ).snapshot_id;
      store.db
        .prepare(
          "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?, ?, ?, ?, ?)",
        )
        .run(snapshotId, 1, 1, "legacy-canon", "ZZZ");

      expect(getSnapshot(store, "/old.ts", content)).toBeUndefined();

      upsertSnapshot(store, {
        path: "/old.ts",
        snapshotHash: `${CANON_VERSION}:${rawChecksum}`,
        lineCount: splitLines(content).length,
        hashes: ["ABC"],
        content,
      });
      expect(getSnapshot(store, "/old.ts", content)).toEqual(["ABC"]);
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = db
        .prepare("SELECT snapshot_hash FROM file_snapshots WHERE path = ? AND snapshot_hash LIKE ?")
        .get("/old.ts", `${CANON_VERSION}:%`) as { snapshot_hash: string } | undefined;
      db.close();
      expect(row?.snapshot_hash).toBe(`${CANON_VERSION}:${rawChecksum}`);
    });
  });

  it("uses the raw whole-file checksum as the cache key base", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const content = "func hello\n";
      upsertSnapshot(store, {
        path: "/p.ts",
        snapshotHash: `${CANON_VERSION}:${contentChecksum(content)}`,
        lineCount: splitLines(content).length,
        hashes: ["ABC"],
        content,
      });
      const db = new DatabaseSync(sqlitePath(home), {
        defensive: false,
      } as any);
      const row = db
        .prepare("SELECT snapshot_hash FROM file_snapshots WHERE path = ?")
        .get("/p.ts") as { snapshot_hash: string } | undefined;
      db.close();
      expect(row?.snapshot_hash).toBe(`${CANON_VERSION}:${contentChecksum(content)}`);
      expect(row?.snapshot_hash.startsWith(`${CANON_VERSION}:`)).toBe(true);
      expect(row?.snapshot_hash.endsWith(contentChecksum(content))).toBe(true);
    });
  });
});
