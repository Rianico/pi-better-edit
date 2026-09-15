import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { createSessionHandle, loadLeases } from "../../src/served-session/session";
import { readNormFile } from "../../src/file-reader.js";
import { getWritableTempRoot } from "../support/fixtures";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { initHasher } from "../../src/hashline/hasher";
import { lineHashes } from "../../src/hashline/index.js";
import { snapshotHashFor } from "../../src/snapshot-store";

beforeAll(async () => {
  await initHasher();
});

describe("ServedSession — handle deep interface", () => {
  it("hides sessionKey threading: record + load via handle", async () => {
    await withTempHome(async () => {
      const handleA = createSessionHandle("sessA", "/a.ts");
      await handleA.record([
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
      ]);
      expect(await handleA.load()).toEqual(["abc", "def"]);
      const handleB = createSessionHandle("sessB", "/a.ts");
      expect(await handleB.load()).toEqual([]);
    });
  });

  it("recordTruncated retires the vanished lines and keeps surviving + re-served anchors leased", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const filePath = join(home, "p.ts");
      await writeFile(filePath, "alpha\nbravo\ncharlie\n", "utf-8");
      const seeded = await readNormFile("p.ts", home, { store });
      const h = createSessionHandle("sessA", seeded.absolutePath, store);
      const content = "alpha\nbravo\ncharlie\n";
      await h.recordDiff(
        seeded.fileHashes.map((hash, position) => ({ position, hash })),
        { contentHash: snapshotHashFor(content) },
      );

      // An external shrink is materialized by the read path, which retires the vanished leases.
      const shortContent = "alpha\nBRAVO\n";
      await writeFile(filePath, shortContent, "utf-8");
      const shrunk = await readNormFile("p.ts", home, { store });
      const shortHashes = shrunk.fileHashes;
      await h.recordTruncated(
        [{ position: 1, hash: shortHashes[1]! }],
        2,
        undefined,
        snapshotHashFor(shortContent),
      );

      expect(await h.load()).toEqual([seeded.fileHashes[0], shortHashes[1]]);
      const leases = loadLeases(store, "sessA", seeded.absolutePath);
      const active = leases.filter((lease) => lease.retired_at === null);
      // `alpha` survives the shrink with its identity, and the re-served `BRAVO` is leased into the
      // truncated range; `bravo` and `charlie` vanished, so the authoritative writer retired them.
      expect(active.map((lease) => lease.anchor)).toEqual([seeded.fileHashes[0], shortHashes[1]]);
      expect(active[1]!.served_line_number).toBe(2);
      expect(
        leases
          .filter((lease) => lease.retired_at !== null)
          .map((lease) => lease.anchor)
          .sort(),
      ).toEqual([seeded.fileHashes[1]!, seeded.fileHashes[2]!].sort());
    });
  });

  it("recordDiff plans truncation internally (plain vs truncated)", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      const content = "alpha\nbravo\n";
      const hashes = await lineHashes(content, "/p.ts");
      const store = await loadHashStore();

      await h.recordDiff(
        hashes.map((hash, position) => ({ position, hash })),
        {
          contentHash: snapshotHashFor(content),
          resultLineCount: hashes.length,
          firstChangedLine: 1,
        },
      );
      expect(await h.load()).toEqual(hashes);
      const leases = loadLeases(store, "sessA", "/p.ts");
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.every((lease) => lease.retired_at === null)).toBe(true);
      expect(leases.every((lease) => lease.served_snapshot_hash === snapshotHashFor(content))).toBe(
        true,
      );

      // plain mode: no line count, so the mirror rows are upserted without truncation
      await h.recordDiff([{ position: 5, hash: "zzz" }], { contentHash: snapshotHashFor("") });
      expect((await h.load())[5]).toBe("zzz");
    });
  });

  it("recordServeFeedback respects preview policy (no-op)", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      await h.recordServeFeedback([{ position: 0, hash: "abc" }], "preview");
      expect(await h.load()).toEqual([]);
      await h.recordServeFeedback([{ position: 0, hash: "abc" }], "live", 1);
      expect(await h.load()).toEqual(["abc"]);
    });
  });

  it("drift reported set is per (session,path) and clearable via handle", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/a.ts");
      await h.markDriftReported(["abc", "def"]);
      expect(await h.driftReported()).toEqual(new Set(["abc", "def"]));
      await h.clearDrift();
      expect(await h.driftReported()).toEqual(new Set());
    });
  });

  it("sessionFromContext binds sessionKey without caller threading", async () => {
    await withTempHome(async () => {
      const { sessionFromContext } = await import("../../src/served-session/session");
      const ctx = { sessionManager: { getSessionId: () => "ctxSess" } };
      const h = sessionFromContext(ctx, "/x.ts");
      expect(h.sessionKey).toBe("ctxSess");
      expect(h.path).toBe("/x.ts");
      await h.record([{ position: 0, hash: "abc" }]);
      expect(await h.load()).toEqual(["abc"]);
    });
  });

  it("re-serving a relocated anchor upserts its lease and preserves the line's identity", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      const content = "aaa\nbbb\nccc\n";
      const hashes = await lineHashes(content, "/p.ts");
      await h.recordDiff(
        hashes.map((hash, position) => ({ position, hash })),
        { contentHash: snapshotHashFor(content) },
      );

      const store = await loadHashStore();
      const before = loadLeases(store, "sessA", "/p.ts").find(
        (lease) => lease.served_line_number === 3,
      )!;

      // external insert relocates ccc from line 3 to line 4 without changing its text
      const drifted = "aaa\nbbb\nddd\nccc\n";
      const driftedHashes = await lineHashes(drifted, "/p.ts");
      const movedAnchor = driftedHashes[3]!;
      await h.recordLeases([{ position: 3, hash: movedAnchor }], snapshotHashFor(drifted));

      const rows = loadLeases(store, "sessA", "/p.ts").filter(
        (lease) => lease.anchor === movedAnchor,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.retired_at).toBeNull();
      expect(rows[0]!.served_line_number).toBe(4);
      // The insert shifted the coordinate, not the line: S_latest -> S_curr pairing inherits the
      // exact `line_id` (spec §3.1.3.2), and only the served snapshot is restamped.
      expect(rows[0]!.line_id).toBe(before.line_id);
      expect(rows[0]!.served_snapshot_hash).not.toBe(before.served_snapshot_hash);
    });
  });

  it("fails closed on an empty contentHash instead of binding to the latest snapshot", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      const content = "alpha\nbravo\n";
      const hashes = await lineHashes(content, "/p.ts");
      const store = await loadHashStore();

      // A newer materialization exists, so a `latest` fallback would bind the lease to a
      // different content version — the silent-miswrite class the empty hash must not open.
      await lineHashes("alpha\nBRAVO\n", "/p.ts");

      await h.recordDiff(
        hashes.map((hash, position) => ({ position, hash })),
        { contentHash: "", resultLineCount: hashes.length, firstChangedLine: 1 },
      );
      // The rejection/truncated hooks fail closed for an omitted hash too: no content version named.
      await h.recordServeFeedback([{ position: 0, hash: hashes[0]! }], "live", 2);
      await h.recordTruncated([{ position: 1, hash: hashes[1]! }], 2, undefined, undefined);

      expect(loadLeases(store, "sessA", "/p.ts")).toEqual([]);
    });
  });

  it("recordServeFeedback binds the lease to the served content, not the newest materialization", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      const served = "alpha\nbravo\n";
      const servedHashes = await lineHashes(served, "/p.ts");
      // A DIFFERENT content version materializes afterwards: a symmetric reorder, so the patience
      // engine pairs nothing and `alpha`'s line_id in the newer snapshot differs from the served one.
      const reordered = "bravo\nalpha\n";
      const newerHashes = await lineHashes(reordered, "/p.ts");
      // …and both snapshots share the first line's anchor (same line text), which is what made the
      // `latest` fallback a silent miswrite rather than an obvious miss.
      expect(newerHashes[1]).toBe(servedHashes[0]);

      await h.recordServeFeedback(
        [{ position: 0, hash: servedHashes[0]! }],
        "live",
        2,
        snapshotHashFor(served),
      );

      const store = await loadHashStore();
      const leases = loadLeases(store, "sessA", "/p.ts");
      expect(leases.map((lease) => lease.anchor)).toEqual([servedHashes[0]]);
      expect(leases[0]!.served_snapshot_hash).toBe(snapshotHashFor(served));
      expect(leases[0]!.line_id).toBe(
        await lineageLineId(store, "/p.ts", snapshotHashFor(served), servedHashes[0]!),
      );
      expect(leases[0]!.line_id).not.toBe(
        await lineageLineId(store, "/p.ts", snapshotHashFor(reordered), servedHashes[0]!),
      );
    });
  });

  it("recordTruncated binds the lease to the served content, not the newest materialization", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      const served = "alpha\nbravo\n";
      const servedHashes = await lineHashes(served, "/p.ts");
      const newerHashes = await lineHashes("alpha\nBRAVO\n", "/p.ts");
      expect(newerHashes[0]).toBe(servedHashes[0]);

      await h.recordTruncated(
        [{ position: 0, hash: servedHashes[0]! }],
        servedHashes.length,
        undefined,
        snapshotHashFor(served),
      );

      const store = await loadHashStore();
      const leases = loadLeases(store, "sessA", "/p.ts");
      expect(leases.map((lease) => lease.anchor)).toEqual([servedHashes[0]]);
      expect(leases[0]!.served_snapshot_hash).toBe(snapshotHashFor(served));
      expect(leases[0]!.line_id).toBe(
        await lineageLineId(store, "/p.ts", snapshotHashFor(served), servedHashes[0]!),
      );
    });
  });
});

async function lineageLineId(
  store: Awaited<ReturnType<typeof loadHashStore>>,
  path: string,
  snapshotHash: string,
  anchor: string,
): Promise<number | undefined> {
  const row = store.db
    .prepare(
      "SELECT ll.line_id AS line_id FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? AND ll.anchor = ?",
    )
    .get(path, snapshotHash, anchor) as { line_id: number } | undefined;
  return row?.line_id;
}

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(
    join(await getWritableTempRoot(), "pi-hashline-served-session-test-"),
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
