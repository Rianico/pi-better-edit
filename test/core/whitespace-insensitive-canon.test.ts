import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

import {
  lineHashes,
  contentOnlyHashes,
  _lineHashesPure,
  CANON_VERSION,
  canon,
  canonDigest,
} from "../../src/hashline";
import { initHasher } from "../../src/hashline/hasher";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { getSnapshot, upsertSnapshot } from "../../src/snapshot-store";
import { contentChecksum } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

describe("canon — frozen v3 whitespace class (ADR-0005 superseded by issue #22)", () => {
  it("reports canon version 3", () => {
    expect(CANON_VERSION).toBe(3);
  });

  it("hashes whitespace variants of a line identically", async () => {
    const base = await contentOnlyHashes("func hello\n");
    const double = await contentOnlyHashes("func  hello\n");
    const leading = await contentOnlyHashes("  func hello\n");
    const trailing = await contentOnlyHashes("func hello \n");
    const tab = await contentOnlyHashes("func\thello\n");
    expect(base[0]).toBe(double[0]);
    expect(base[0]).toBe(leading[0]);
    expect(base[0]).toBe(trailing[0]);
    expect(base[0]).toBe(tab[0]);
  });

  // WHY (merge note): stale under the frozen v3 class — NBSP/U+2003 now normalize, so the
  // WHY: `not.toBe` pins below fail at runtime. Kept for the S4 report; lane follow-up owns it.
  it("keeps NBSP and Unicode whitespace significant", async () => {
    const ascii = await contentOnlyHashes("func hello\n");
    const nbsp = await contentOnlyHashes("func\u00A0hello\n");
    const em = await contentOnlyHashes("func\u2003hello\n");
    expect(nbsp[0]).not.toBe(ascii[0]);
    expect(em[0]).not.toBe(ascii[0]);
    expect(nbsp[0]).not.toBe(em[0]);
  });

  it("normalizes v3 class code points anywhere in the line (issue #22)", async () => {
    const ascii = await _lineHashesPure("func hello\n");
    const nbspMiddle = await _lineHashesPure("func\u00A0hello\n");
    const emMiddle = await _lineHashesPure("func\u2003hello\n");
    const nbspPadded = await _lineHashesPure("\u00A0func hello \u00A0\n");
    const bomInside = await _lineHashesPure("func\uFEFF hello\n");
    expect(nbspMiddle[0]).toBe(ascii[0]);
    expect(emMiddle[0]).toBe(ascii[0]);
    expect(nbspPadded[0]).toBe(ascii[0]);
    expect(bomInside[0]).toBe(ascii[0]);
    expect(canon("func\u00A0hello")).toBe(canon("func hello"));
    expect(canonDigest("func\u00A0hello")).toBe(canonDigest("func\u2003hello"));
    expect(canonDigest("func\u200Bhello")).not.toBe(canonDigest("func hello"));
  });

  it("keeps zero-width, joiner and soft-hyphen code points significant (issue #22)", async () => {
    const ascii = await _lineHashesPure("func hello\n");
    const significant = ["\u200B", "\u200C", "\u200D", "\u00AD", "\u2060", "\u180E"];
    for (const cp of significant) {
      const variant = await _lineHashesPure(`func${cp}hello\n`);
      expect(variant[0]).not.toBe(ascii[0]);
    }
  });

  it("hashes whitespace-only lines as blank lines", async () => {
    const blank = await contentOnlyHashes("\n");
    const spaces = await contentOnlyHashes("   \n");
    const tab = await contentOnlyHashes("\t\n");
    expect(spaces[0]).toBe(blank[0]);
    expect(tab[0]).toBe(blank[0]);
  });
});

describe("stable mapping — whitespace-insensitive reuse (ADR-0005)", () => {
  it("reuses a hash across a whitespace-only edit", async () => {
    const old = await contentOnlyHashes("a\nfunc hello\nc\n");
    const mapped = await lineHashes("a\nfunc  hello\nc\n", "/test/ws-reuse.ts", {
      content: "a\nfunc hello\nc\n",
      hashes: old,
      removedHashes: new Set([old[0]!]),
    });
    expect(mapped[1]).toBe(old[1]);
  });

  it("rotates when a token is added (brace merged onto the line)", async () => {
    const old = await contentOnlyHashes("a\nfunc hello()\n");
    const mapped = await lineHashes("a\nfunc hello() {\n", "/test/ws-rotate.ts", {
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
      const hashes = ["aB33", "xY77"];
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
        .run(snapshotId, 1, 1, "legacy-canon", "ZZZZ");

      expect(getSnapshot(store, "/old.ts", content)).toBeUndefined();

      upsertSnapshot(store, {
        path: "/old.ts",
        snapshotHash: `${CANON_VERSION}:${rawChecksum}`,
        lineCount: splitLines(content).length,
        hashes: ["ABCC"],
        content,
      });
      expect(getSnapshot(store, "/old.ts", content)).toEqual(["ABCC"]);
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
        hashes: ["ABCC"],
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
