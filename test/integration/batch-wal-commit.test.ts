import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { snapshotHashFor } from "../../src/snapshot-store";
import { loadLeases, sessionKeyFor } from "../../src/served-session/session";

interface LineageRow {
  line_number: number;
  line_id: number;
  anchor: string;
}

/** The atomicity trailer every item rejection of a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

function lineageRows(store: HashStore, path: string, snapshotHash: string): LineageRow[] {
  return store.db
    .prepare(
      "SELECT ll.line_number, ll.line_id, ll.anchor FROM line_lineage ll " +
        "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
        "WHERE fs.path = ? AND fs.snapshot_hash = ? ORDER BY ll.line_number ASC",
    )
    .all(path, snapshotHash) as unknown as LineageRow[];
}

function lineageIds(store: HashStore, path: string, content: string): number[] {
  return lineageRows(store, path, snapshotHashFor(content)).map((row) => row.line_id);
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

function undoCount(store: HashStore, path: string): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM file_undo WHERE path = ?").get(path) as {
    n: number;
  };
  return row.n;
}

function nextId(store: HashStore, path: string): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

/**
 * Ticket #84 (spec §3.2): the batch commit is a WAL protocol inside `BEGIN IMMEDIATE`.
 * - overlapping/nested spans abort the whole batch before anything is written;
 * - a cache miss preserves the `line_id`s of surviving lines and allocates only the
 *   inserted lines from `line_id_counters`;
 * - a cache hit (cyclical reversion) adopts the canonical snapshot with zero allocations.
 */
describe("multi-edit batch WAL commit", () => {
  it("rejects a nested batch span with [MODEL] [E_BATCH_ABORT] and writes nothing to disk or store", async () => {
    const content = "a\nb\nc\nd\ne\n";
    await withTempFile("nest.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute("r1", { path: "nest.txt" }, undefined, undefined, ctx);
      const lines = getText(readRes).split("\n");
      const h1 = extractHash(lines[0]!);
      const h2 = extractHash(lines[1]!);
      const h3 = extractHash(lines[2]!);

      const store = await loadHashStore();
      const counterBefore = nextId(store, path);
      const snapshotsBefore = snapshotCount(store, path);

      // edit[1] (lines 1..3) strictly nests edit[0] (line 2): both anchors of edit[1]
      // survive edit[0], so only an explicit span check can reject the batch.
      const editPromise = editTool.execute(
        "e1",
        {
          path: "nest.txt",
          edits: [
            [h2, h2, "B"],
            [h1, h3, "X"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/\[MODEL\] \[E_BATCH_ABORT\]/);
      expect(await readFile(path, "utf-8")).toBe(content);
      expect(nextId(store, path)).toBe(counterBefore);
      expect(snapshotCount(store, path)).toBe(snapshotsBefore);
    });
  });

  it("rejects a partially overlapping batch span before any edit is applied", async () => {
    const content = "a\nb\nc\nd\ne\n";
    await withTempFile("overlap.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "overlap.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const h2 = extractHash(lines[1]!);
      const h4 = extractHash(lines[3]!);
      const h5 = extractHash(lines[4]!);

      const editPromise = editTool.execute(
        "e1",
        {
          path: "overlap.txt",
          edits: [
            [h2, h4, "X"],
            [h4, h5, "Y"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/\[MODEL\] \[E_BATCH_ABORT\]/);
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  });

  it("rejects a batch whose spans overlap only after an external shift, before any mutation", async () => {
    // `dup` and `  dup` share one canon, so the fresh hashing pass hands the shifted duplicate the
    // anchor the model still holds for the line that moved; only the leased `line_id` says which
    // occurrence the model is allowed to write.
    const content = "alpha\ndup\nbeta\ngamma\n";
    const shifted = "  dup\nalpha\ndup\nbeta\ngamma\n";
    await withTempFile("shift-overlap.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "shift-overlap.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const dupRef = extractHash(lines[1]!);
      const alphaRef = extractHash(lines[0]!);
      const betaRef = extractHash(lines[2]!);

      const store = await loadHashStore();
      const undoBefore = undoCount(store, path);

      // External insert at the top: the leased `dup` line shifts to 3 while its presentation anchor
      // now also sits on the inserted line 1.
      await writeFile(path, shifted, "utf-8");

      const editPromise = editTool.execute(
        "e1",
        {
          path: "shift-overlap.txt",
          edits: [
            [dupRef, dupRef, "X"],
            [alphaRef, betaRef, "YZ"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(editPromise).rejects.toThrow(/\[MODEL\] \[E_BATCH_ABORT\]/);
      // Rebased to the leased identity the spans nest (3-3 inside 2-4); the shift is what makes them
      // overlap, and no edit of the batch may reach the file.
      const rejection = await editPromise.catch((error: unknown) => error as Error);
      expect(rejection.message).toContain("targets lines 3-3");
      expect(rejection.message).toContain("targets lines 2-4");
      expect(await readFile(path, "utf-8")).toBe(shifted);
      // No item reached the persist stage: no undo entry was written and no snapshot of a mutated
      // batch result was materialized.
      expect(undoCount(store, path)).toBe(undoBefore);
      expect(snapshotId(store, path, "  dup\nalpha\nX\nbeta\ngamma\n")).toBeUndefined();
    });
  });

  it("resolves duplicate canons through the leased identity, never through indexOf first-match", async () => {
    const content = "alpha\ndup\nbeta\ngamma\n";
    const shifted = "  dup\nalpha\ndup\nbeta\ngamma\n";
    await withTempFile("duplicate-canon.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "duplicate-canon.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const dupRef = extractHash(lines[1]!);
      const alphaRef = extractHash(lines[0]!);
      const betaRef = extractHash(lines[2]!);

      await writeFile(path, shifted, "utf-8");

      // `dupRef` is the FIRST occurrence of the duplicate canon on disk (the inserted line 1), but the
      // leased `line_id` it names lives at line 3. The batch span gate must use the leased coordinate:
      // 3-3 nests inside 2-4, so the whole batch aborts instead of applying at the first occurrence.
      const editPromise = editTool.execute(
        "e1",
        {
          path: "duplicate-canon.txt",
          edits: [
            [dupRef, dupRef, "X"],
            [alphaRef, betaRef, "YZ"],
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const rejection = await editPromise.catch((error: unknown) => error as Error);
      expect(rejection.message).toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain("targets lines 3-3");
      expect(rejection.message).not.toContain("targets lines 1-1");
      expect(await readFile(path, "utf-8")).toBe(shifted);

      // Control: the same anchor, applied on its own, lands on the leased occurrence — the duplicate
      // canon at line 3 changes while the first occurrence at line 1 keeps its bytes.
      await editTool.execute(
        "e2",
        { path: "duplicate-canon.txt", edits: [[dupRef, dupRef, "X"]] },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("  dup\nalpha\nX\nbeta\ngamma\n");
    });
  });

  it("preserves surviving line_ids and allocates only inserted lines from line_id_counters", async () => {
    const content = "l1\nl2\nl3\nl4\nl5\n";
    const edited = "l1\nl2\nl3-modified\nl4\nl5\n";
    await withTempFile("survive.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const readRes = await readTool.execute(
        "r1",
        { path: "survive.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readRes).split("\n");
      const h3 = extractHash(lines[2]!);

      const store = await loadHashStore();
      expect(lineageIds(store, path, content)).toEqual([1, 2, 3, 4, 5]);
      expect(nextId(store, path)).toBe(6);

      await editTool.execute(
        "e1",
        { path: "survive.txt", edits: [[h3, h3, "l3-modified"]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe(edited);
      expect(lineageIds(store, path, edited)).toEqual([1, 2, 6, 4, 5]);
      // Exactly one fresh id was allocated for the one inserted line.
      expect(nextId(store, path)).toBe(7);
    });
  });

  it("adopts the canonical snapshot with zero allocations when a batch reverts content (cyclical edit)", async () => {
    const original = "alpha\nbravo\ncharlie\n";
    await withTempFile("cycle.txt", original, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { path: "cycle.txt" }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const bravo = extractHash(lines[1]!);

      const store = await loadHashStore();
      const canonicalId = snapshotId(store, path, original);
      expect(canonicalId).toBeDefined();

      await editTool.execute(
        "e1",
        { path: "cycle.txt", edits: [[bravo, bravo, "BRAVO"]] },
        undefined,
        undefined,
        ctx,
      );
      const counterAfterForward = nextId(store, path);
      const snapshotsAfterForward = snapshotCount(store, path);
      const forwardLines = getText(
        await readTool.execute("r2", { path: "cycle.txt" }, undefined, undefined, ctx),
      ).split("\n");
      const bravoUpper = extractHash(forwardLines[1]!);

      await editTool.execute(
        "e2",
        { path: "cycle.txt", edits: [[bravoUpper, bravoUpper, "bravo"]] },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe(original);
      // Cache hit: no counter movement, no new file_snapshots row, canonical id adopted.
      expect(nextId(store, path)).toBe(counterAfterForward);
      expect(snapshotCount(store, path)).toBe(snapshotsAfterForward);
      expect(snapshotId(store, path, original)).toBe(canonicalId);
      expect(await readFile(path, "utf-8")).toBe(original);
    });
  });

  it("retires the leased lines a batch deleted and leaves the surviving leases active", async () => {
    const content = "row1\nrow2\nrow3\n";
    await withTempFile("retire.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { path: "retire.txt" }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const row2 = extractHash(lines[1]!);

      await editTool.execute(
        "e1",
        { path: "retire.txt", edits: [[row2, row2, "row2-new"]] },
        undefined,
        undefined,
        ctx,
      );

      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(ctx);
      const leases = loadLeases(store, sessionKey, path);
      const retired = leases.find((lease) => lease.anchor === row2);
      expect(retired).toBeDefined();
      expect(retired!.retired_at).not.toBeNull();

      // Every active lease still references a line present in the committed lineage.
      const lineage = lineageRows(store, path, snapshotHashFor(await readFile(path, "utf-8")));
      const active = leases.filter((lease) => lease.retired_at === null);
      expect(active.length).toBeGreaterThan(0);
      for (const lease of active) {
        expect(lineage.some((row) => row.line_id === lease.line_id)).toBe(true);
      }
    });
  });

  it("keeps [E_BAD_ANCHOR] on the parse-time item rejection and prefixes it with [MODEL]", async () => {
    await withTempFile("parse-abort.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "parse-abort.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const aaa = extractHash(lines[0]!);

      // edit[1] carries a `HASH│` prefix, so `resEdit` throws; with more than one item the parse loop
      // keeps that diagnostic's own code and appends the atomicity trailer — never `E_BATCH_ABORT`,
      // which would send the model hunting for coordinate overlap instead of fixing the anchor.
      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "parse-abort.txt",
            edits: [
              [aaa, aaa, "AAA"],
              [`${aaa}│aaa`, aaa, "BBB"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message.startsWith("[MODEL] ")).toBe(true);
      expect(rejection.message).toContain("[E_BAD_ANCHOR]");
      expect(rejection.message).toContain("edit[1] (parse-abort.txt) failed");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("keeps [E_STALE_RANGE] on the served-state item rejection and serves the shared abort block", async () => {
    await withTempFile("reject-abort.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute(
        "r1",
        { path: "reject-abort.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const alpha = extractHash(lines[0]!);
      const beta = extractHash(lines[1]!);
      const gamma = extractHash(lines[2]!);

      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");

      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "reject-abort.txt",
            edits: [
              [alpha, alpha, "ALPHA"],
              [beta, gamma, "BETA\ngamma"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message.startsWith("[MODEL] ")).toBe(true);
      expect(rejection.message).toContain("[E_STALE_RANGE]");
      expect(rejection.message).toContain("edit[1] (reject-abort.txt) failed");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      // The single shared helper renders the serve block verbatim at this call site too.
      expect(rejection.message).toContain(
        "Current on-disk range for edit[1] (unchanged — nothing was written):",
      );
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("resolves a chained batch's later edit through the working buffer's in-memory line identity", async () => {
    // edit[0] replaces `alpha` with `dup`, so the working buffer holds three byte-identical `dup`
    // lines. Re-diffing that buffer against S_latest cannot tell which `dup` carries line_id 2 and
    // retires it; the working buffer's own identity map still names it, so edit[1] must resolve
    // through those in-memory identities and land on the leased line 2.
    const content = "alpha\ndup\ndup\n";
    await withTempFile("chain.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const r1 = await readTool.execute("r1", { path: "chain.txt" }, undefined, undefined, ctx);
      const lines = getText(r1).split("\n");
      const alpha = extractHash(lines[0]!);
      const dupSecond = extractHash(lines[1]!);

      const snapshotStore = await import("../../src/snapshot-store");
      const positionsSpy = vi.spyOn(snapshotStore, "positionsByIdentity");
      let editRes: Awaited<ReturnType<typeof editTool.execute>>;
      let reDiffed: string[];
      try {
        editRes = await editTool.execute(
          "e1",
          {
            path: "chain.txt",
            edits: [
              [alpha, alpha, "dup"],
              [dupSecond, dupSecond, "X"],
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        reDiffed = positionsSpy.mock.calls.map((call) => call[2]);
      } finally {
        positionsSpy.mockRestore();
      }

      // In-memory identity resolution: the intermediate `dup\ndup\ndup` buffer is never re-diffed
      // against S_latest, only the baseline content the spans and working-buffer map are read from.
      expect(reDiffed).not.toContain("dup\ndup\ndup\n");
      expect(reDiffed).toContain("alpha\ndup\ndup\n");
      expect(getText(editRes)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("dup\nX\ndup\n");
    });
  });
});
