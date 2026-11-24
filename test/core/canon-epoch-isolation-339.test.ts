/**
 * Issue #339: stored canon evidence is scoped to its full snapshot epoch, `CANON_VERSION:ANCHOR_GENERATION`.
 *
 * Each case plants one benign two-line snapshot, its lease and its stat stamp, then asks the snapshot
 * store and the lease source the question an edit or a read asks next. The prior-canon fixture keeps the
 * current anchor generation and records a line digest that equals the current digest of an externally
 * rewritten line, which is what a canon that folded interior whitespace stored. That evidence must
 * neither carry a `line_id` nor serve a lease nor adopt on stat identity; the same rows planted under
 * the current epoch still do all three.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadHashStore, shutdownHashStore, type HashStore } from "../../src/hash-store";
import { leaseSpanSource } from "../../src/mutation-engine/edit-source";
import {
  adoptStatSnapshotFor,
  findStatSnapshotFor,
  positionsByIdentity,
  snapshotHashFor,
  upsertSnapshot,
} from "../../src/snapshot-store";
import { initHasher, contentChecksum } from "../../src/hashline/hasher";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  canonDigest,
  lineHashes,
} from "../../src/hashline/hash-identity.js";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

const PATH = "/canon-epoch-339/a.ts";
const SESSION = "session-339";
const SERVED = 'value="a b"\nconst plain=1;\n';
const REWRITTEN_LINE = 'value="ab"';
const REWRITTEN = `${REWRITTEN_LINE}\nconst plain=1;\n`;
const STAT_KEY = "stat-339";

const PRIOR_CANON = CANON_VERSION - 1;

beforeAll(async () => {
  await initHasher();
});

async function withStore(run: (store: HashStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-canon-epoch-339-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(await loadHashStore());
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

interface Planted {
  snapshotHash: string;
  anchor: string;
  lineId: number;
}

/**
 * Commits `SERVED` under `canonVersion` with line 1 leased and the file version stat-stamped, then
 * records line 1's digest as the current digest of `REWRITTEN_LINE` — the evidence a canon that
 * folded interior whitespace would have stored for `value="a b"`.
 */
async function plantServed(store: HashStore, canonVersion: number): Promise<Planted> {
  const snapshotHash = `${canonVersion}:${ANCHOR_GENERATION}:${contentChecksum(SERVED)}`;
  const hashes = await lineHashes(SERVED, PATH);
  const anchor = hashes[0]!;
  upsertSnapshot(
    store,
    {
      path: PATH,
      snapshotHash,
      lineCount: splitLines(SERVED).length,
      hashes,
      content: SERVED,
    },
    { leases: { sessionKey: SESSION, rows: [{ position: 0, hash: anchor }] }, statKey: STAT_KEY },
  );
  const { snapshot_id: snapshotId, line_id: lineId } = store.db
    .prepare(
      "SELECT fs.snapshot_id, ll.line_id FROM file_snapshots fs " +
        "JOIN line_lineage ll ON ll.snapshot_id = fs.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? AND ll.line_number = 1",
    )
    .get(PATH, snapshotHash) as { snapshot_id: number; line_id: number };
  const storedDigest = canonDigest(REWRITTEN_LINE);
  store.db
    .prepare("UPDATE line_lineage SET canon_hash = ? WHERE snapshot_id = ? AND line_number = 1")
    .run(storedDigest, snapshotId);
  store.db
    .prepare("UPDATE served_leases SET canon_hash = ? WHERE file_path = ? AND anchor = ?")
    .run(storedDigest, PATH, anchor);
  return { snapshotHash, anchor, lineId };
}

function materializeRewritten(store: HashStore): { lineId: number; retiredAt: number | null } {
  upsertSnapshot(
    store,
    {
      path: PATH,
      snapshotHash: snapshotHashFor(REWRITTEN),
      lineCount: splitLines(REWRITTEN).length,
      hashes: ["AAAA", "BBBB"],
      content: REWRITTEN,
    },
    { retireLeases: true },
  );
  const { line_id: lineId } = store.db
    .prepare(
      "SELECT ll.line_id FROM file_snapshots fs JOIN line_lineage ll ON ll.snapshot_id = fs.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? AND ll.line_number = 1",
    )
    .get(PATH, snapshotHashFor(REWRITTEN)) as { line_id: number };
  const { retired_at: retiredAt } = store.db
    .prepare("SELECT retired_at FROM served_leases WHERE session_id = ? AND file_path = ?")
    .get(SESSION, PATH) as { retired_at: number | null };
  return { lineId, retiredAt };
}

describe("issue #339 — prior-canon evidence is fenced by the snapshot epoch", () => {
  it("does not carry a line_id from a prior-canon snapshot into the rewritten content", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, PRIOR_CANON);

      expect(positionsByIdentity(store, PATH, REWRITTEN).get(planted.lineId)).toBeUndefined();

      const materialized = materializeRewritten(store);
      expect(materialized.lineId).not.toBe(planted.lineId);
      expect(materialized.retiredAt).not.toBeNull();
    });
  });

  it("does not honour a lease served under a prior canon", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, PRIOR_CANON);

      const source = leaseSpanSource({
        store,
        sessionKey: SESSION,
        absolutePath: PATH,
        content: REWRITTEN,
      });

      expect(source.leaseFor(planted.anchor)).toBeUndefined();
      expect(source.rebasedLineOf(planted.lineId)).toBeUndefined();
    });
  });

  it("does not adopt a prior-canon snapshot on stat identity", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, PRIOR_CANON);

      expect(await findStatSnapshotFor(PATH, STAT_KEY)).toBeUndefined();
      expect(
        await adoptStatSnapshotFor(
          { path: PATH, statKey: STAT_KEY, snapshotHash: planted.snapshotHash },
          { leases: { sessionKey: SESSION, rows: [{ position: 0, hash: planted.anchor }] } },
        ),
      ).toBe(false);
    });
  });
});

describe("issue #339 — matching-epoch evidence keeps its identity", () => {
  it("carries the line_id from a current-epoch snapshot whose stored digest pairs", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, CANON_VERSION);
      expect(planted.snapshotHash).toBe(snapshotHashFor(SERVED));

      expect(positionsByIdentity(store, PATH, REWRITTEN).get(planted.lineId)).toBe(1);

      const materialized = materializeRewritten(store);
      expect(materialized.lineId).toBe(planted.lineId);
      expect(materialized.retiredAt).toBeNull();
    });
  });

  it("honours a lease served under the current epoch", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, CANON_VERSION);

      const source = leaseSpanSource({
        store,
        sessionKey: SESSION,
        absolutePath: PATH,
        content: REWRITTEN,
      });

      expect(source.leaseFor(planted.anchor)).toMatchObject({
        lineId: planted.lineId,
        servedSnapshotHash: planted.snapshotHash,
        retiredAt: null,
      });
      expect(source.rebasedLineOf(planted.lineId)).toBe(1);
    });
  });

  it("adopts a current-epoch snapshot on stat identity", async () => {
    await withStore(async (store) => {
      const planted = await plantServed(store, CANON_VERSION);

      expect((await findStatSnapshotFor(PATH, STAT_KEY))?.snapshotHash).toBe(planted.snapshotHash);
      expect(
        await adoptStatSnapshotFor(
          { path: PATH, statKey: STAT_KEY, snapshotHash: planted.snapshotHash },
          { leases: { sessionKey: SESSION, rows: [{ position: 0, hash: planted.anchor }] } },
        ),
      ).toBe(true);
    });
  });
});
