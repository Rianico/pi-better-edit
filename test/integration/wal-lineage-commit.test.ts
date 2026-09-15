import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor } from "../../src/served-session/session";
import { canon } from "../../src/hashline/index";
import { xxh32 } from "../../src/hashline/hasher";
import { pairSnapshots, type LineDescriptor } from "../../src/hashline/patience-pairing";

interface LineageRow {
  line_number: number;
  line_id: number;
  anchor: string;
}

function lineageRows(store: HashStore, path: string, content: string): LineageRow[] {
  return store.db
    .prepare(
      "SELECT ll.line_number, ll.line_id, ll.anchor FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? ORDER BY ll.line_number ASC",
    )
    .all(path, snapshotHashFor(content)) as unknown as LineageRow[];
}

function snapshotId(store: HashStore, path: string, content: string): number | undefined {
  const row = store.db
    .prepare(
      "SELECT snapshot_id FROM file_snapshots WHERE path = ? AND snapshot_hash = ? AND committed = 1",
    )
    .get(path, snapshotHashFor(content)) as { snapshot_id: number } | undefined;
  return row?.snapshot_id;
}

function snapshotCount(store: HashStore, path: string): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
    .get(path) as { n: number };
  return row.n;
}

function nextId(store: HashStore, path: string): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

function canonHashOf(line: string): string {
  return String(xxh32(canon(line)));
}

/**
 * Ticket #90 (spec §3.2.4 step 1): the post-write commit persists `S_final`'s `line_lineage` from
 * the in-memory working-buffer identity map instead of re-pairing against `S_latest`. The read path
 * keeps pairing (`pairSnapshots`) — it is the materialization mechanism, not the commit mechanism.
 */
describe("WAL lineage commit from the working buffer", () => {
  it("keeps the working-buffer identity of a surviving duplicate when re-pairing S_latest is ambiguous", async () => {
    // Two byte-identical canon lines: patience pairing cannot tell which of the two survives a
    // delete, so the read-path mechanism answers "no pairing" and would issue a brand-new `line_id`.
    const content = "same\nsame\n";
    const result = "same\n";
    const duplicateCanon = canonHashOf("same");
    const ambiguous: LineDescriptor[] = [
      { lineNumber: 1, canonHash: duplicateCanon },
      { lineNumber: 2, canonHash: duplicateCanon },
    ];
    const rePairing = pairSnapshots(ambiguous, [{ lineNumber: 1, canonHash: duplicateCanon }]);
    expect(rePairing.size).toBe(0);

    await withTempFile("dup.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute("r1", { path: "dup.txt" }, undefined, undefined, ctx);
      const lines = getText(readRes).split("\n");
      const first = extractHash(lines[0]!);
      const second = extractHash(lines[1]!);
      expect(second).not.toBe(first);

      const store = await loadHashStore();
      const before = lineageRows(store, path, content);
      expect(before.map((row) => row.line_id)).toEqual([1, 2]);
      const survivorId = before[1]!.line_id;
      const counterBefore = nextId(store, path);

      // Delete the earlier of the two identical lines. The surviving line is physically the second
      // one, so the working buffer keeps its `line_id`.
      await editTool.execute(
        "e1",
        { path: "dup.txt", edits: [[first, first, ""]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe(result);
      const after = lineageRows(store, path, result);
      expect(after).toEqual([{ line_number: 1, line_id: survivorId, anchor: second }]);
      // The surviving line was already known to the working buffer: zero counter allocations.
      expect(nextId(store, path)).toBe(counterBefore);

      // End to end: the lease the model still holds for the surviving anchor names the same
      // identity it named before the batch.
      const leases = loadLeases(store, sessionKeyFor(ctx), path);
      const survivorLease = leases.find((lease) => lease.anchor === second);
      expect(survivorLease?.line_id).toBe(survivorId);
      expect(survivorLease?.retired_at).toBeNull();
      const deletedLease = leases.find((lease) => lease.anchor === first);
      expect(deletedLease?.retired_at).not.toBeNull();
    });
  });

  it("allocates exactly N_inserted ids in one line_id_counters upsert for lines the batch creates", async () => {
    const content = "a\nb\nc\n";
    const result = "a\nb1\nb2\nc\n";
    await withTempFile("insert.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "insert.txt" },
        undefined,
        undefined,
        ctx,
      );
      const b = extractHash(getText(readRes).split("\n")[1]!);

      const store = await loadHashStore();
      const counterBefore = nextId(store, path);
      expect(counterBefore).toBe(4);

      await editTool.execute(
        "e1",
        { path: "insert.txt", edits: [[b, b, "b1\nb2"]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe(result);
      const ids = lineageRows(store, path, result).map((row) => row.line_id);
      const allocated = ids.filter((id) => id >= counterBefore!);
      expect(allocated).toEqual([4, 5]);
      // Exactly two ids, contiguous from the persisted counter, and one statement's worth of movement.
      expect(nextId(store, path)).toBe(counterBefore! + 2);
      expect(ids).toEqual([1, 4, 5, 3]);
    });
  });

  it("adopts the canonical snapshot with zero allocations when the batch reverts content", async () => {
    const original = "alpha\nbravo\ncharlie\n";
    await withTempFile("revert.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { path: "revert.txt" }, undefined, undefined, ctx);
      const bravo = extractHash(getText(r1).split("\n")[1]!);

      const store = await loadHashStore();
      const canonicalId = snapshotId(store, path, original);
      const canonicalLineage = lineageRows(store, path, original);
      expect(canonicalLineage.map((row) => row.line_id)).toEqual([1, 2, 3]);

      await editTool.execute(
        "e1",
        { path: "revert.txt", edits: [[bravo, bravo, "BRAVO"]] },
        undefined,
        undefined,
        ctx,
      );
      const counterAfterForward = nextId(store, path);
      const snapshotsAfterForward = snapshotCount(store, path);
      const bravoUpper = extractHash(
        getText(
          await readTool.execute("r2", { path: "revert.txt" }, undefined, undefined, ctx),
        ).split("\n")[1]!,
      );

      await editTool.execute(
        "e2",
        { path: "revert.txt", edits: [[bravoUpper, bravoUpper, "bravo"]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe(original);
      // Cache guard runs before the working-buffer commit: canonical snapshot adopted verbatim,
      // zero counter movement, no UNIQUE (path, snapshot_hash) violation.
      expect(snapshotId(store, path, original)).toBe(canonicalId);
      expect(lineageRows(store, path, original)).toEqual(canonicalLineage);
      expect(nextId(store, path)).toBe(counterAfterForward);
      expect(snapshotCount(store, path)).toBe(snapshotsAfterForward);

      const leases = loadLeases(store, sessionKeyFor(ctx), path);
      const restored = leases.find((lease) => lease.anchor === bravo);
      expect(restored?.line_id).toBe(canonicalLineage[1]!.line_id);
      expect(restored?.retired_at).toBeNull();
    });
  });
});
