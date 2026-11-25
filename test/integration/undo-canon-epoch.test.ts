/**
 * Issue #339, producer side: `undo_last_edit` re-derives a pin recorded under a foreign snapshot
 * epoch before it adopts (spec §7.2.9).
 *
 * A pin is `CANON_VERSION:ANCHOR_GENERATION:checksum`, so a canon-only change moves the epoch while
 * leaving raw anchor identity untouched. Re-adopting the foreign-epoch key verbatim would lease the
 * restored rows under a key the next edit refuses to read, which is the §7.2.9 failure: the undo's
 * own anchors become unusable without an intermediate read. The re-derived key carries the current
 * epoch, so the restored lease serves the next edit directly.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHashStore } from "../../src/hash-store.js";
import { upsertUndo } from "../../src/undo-store.js";
import {
  ANCHOR_GENERATION,
  CANON_VERSION,
  fileHashesFor,
  initHasher,
} from "../../src/hashline/hash-identity.js";
import { contentChecksum } from "../../src/hashline/hasher.js";
import { snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { splitLines } from "../../src/utils.js";
import { setupIntegrationTest, withTempFile } from "../support/fixtures";

const PRE = "aaa\nbbb\nccc\n";
const POST = "aaa\nBBB\nccc\n";

beforeAll(async () => {
  await initHasher();
});

/**
 * The state an edit leaves behind: `POST` committed as the file's current snapshot, and the
 * `POST` -> `PRE` undo row pinned to `snapshotHash`. `POST` is committed so the undo's pre-image
 * derivation is a cache hit, leaving the `line_id_counters` delta owned by the adoption alone.
 */
async function plantPinnedUndo(abs: string, snapshotHash: string): Promise<void> {
  const store = await loadHashStore();
  const hashes = await fileHashesFor(abs, PRE);
  upsertSnapshot(store, {
    path: abs,
    snapshotHash,
    lineCount: splitLines(PRE).length,
    hashes,
    content: PRE,
  });
  upsertSnapshot(store, {
    path: abs,
    snapshotHash: snapshotHashFor(POST),
    lineCount: splitLines(POST).length,
    hashes: await fileHashesFor(abs, POST),
    content: POST,
  });
  upsertUndo(store, abs, {
    content: PRE,
    bom: "",
    ending: "\n",
    hashes,
    resultContent: POST,
    anchorGeneration: ANCHOR_GENERATION,
    snapshotHash,
  });
}

async function activeLeaseHashes(abs: string): Promise<string[]> {
  const store = await loadHashStore();
  const rows = store.db
    .prepare(
      "SELECT served_snapshot_hash AS h FROM served_leases WHERE file_path = ? AND retired_at IS NULL",
    )
    .all(abs) as unknown as { h: string }[];
  return rows.map((row) => row.h);
}
type Store = Awaited<ReturnType<typeof loadHashStore>>;

function counterOf(abs: string, store: Store): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(abs) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

describe("issue #339 — the undo producer re-derives a foreign-epoch pin", () => {
  it("undo of a prior-canon pin serves anchors the next edit accepts without an intermediate read", async () => {
    await withTempFile("u.txt", POST, async ({ cwd }) => {
      const abs = join(cwd, "u.txt");
      const priorEpochPin = `${CANON_VERSION - 1}:${ANCHOR_GENERATION}:${contentChecksum(PRE)}`;
      await plantPinnedUndo(abs, priorEpochPin);

      const { getTool, ctx } = setupIntegrationTest(cwd);
      const undoResult = await getTool("undo_last_edit").execute(
        "u1",
        { path: "u.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(abs, "utf-8")).toBe(PRE);

      expect(await activeLeaseHashes(abs)).toEqual([
        snapshotHashFor(PRE),
        snapshotHashFor(PRE),
        snapshotHashFor(PRE),
      ]);

      const servedRows = undoResult.details?.servedRows as { position: number; hash: string }[];
      expect(servedRows).toHaveLength(3);
      const anchor = servedRows[1]!.hash;
      expect(anchor).toMatch(/^[A-Za-z0-9]{4}$/);

      await getTool("edit").execute(
        "e1",
        { file: "u.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "bbbX" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(abs, "utf-8")).toBe("aaa\nbbbX\nccc\n");
    });
  });

  it("a same-epoch pin is reused, allocating no line_id", async () => {
    await withTempFile("s.txt", POST, async ({ cwd }) => {
      const abs = join(cwd, "s.txt");
      await plantPinnedUndo(abs, snapshotHashFor(PRE));
      const store = await loadHashStore();
      const allocatedBefore = counterOf(abs, store);

      const { getTool, ctx } = setupIntegrationTest(cwd);
      await getTool("undo_last_edit").execute("u1", { path: "s.txt" }, undefined, undefined, ctx);

      expect(await readFile(abs, "utf-8")).toBe(PRE);
      expect(counterOf(abs, store)).toBe(allocatedBefore);
    });
  });
});
