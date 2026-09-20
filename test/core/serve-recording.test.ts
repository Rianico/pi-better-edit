import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { snapshotHashFor, upsertSnapshotFor } from "../../src/snapshot-store";
import {
  createSessionHandle,
  getServed,
  upsertServed,
  getReported,
  addReported,
  loadTombstone,
  loadEpochId,
  loadLeases,
} from "../../src/served-session/index.js";
import { apply, execEdits } from "../../src/mutation-engine/pipeline.js";
import type { NormalizedEditRequest } from "../../src/payload-contract.js";
import {
  planServeRecording,
  recordDiffServes,
  recordRejectionServes,
} from "../../src/served-session/index.js";
import { computeDrift, scanDrift } from "../../src/drift";
import { initHasher, lineHashes } from "../../src/hashline";
import { getWritableTempRoot } from "../support/fixtures";
import { canon } from "../../src/hashline/hash-identity.js";
import { readNormFile } from "../../src/file-reader.js";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";

beforeAll(async () => {
  await initHasher();
});

let tmpHome: string;
async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "serve-recording-test-"));
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
    expect(planServeRecording({ resultLineCount: 5, firstChangedLine: 2 })).toEqual({
      mode: "truncated",
      lineCount: 5,
      clearFrom: 1,
    });
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
  // WHY: these fake rows have no materialized snapshot; "" names none, so no lease is granted
  // WHY: and the assertions stay about the legacy served mirror.
  const NO_SNAPSHOT = snapshotHashFor("");
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
        contentHash: NO_SNAPSHOT,
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
        contentHash: NO_SNAPSHOT,
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
        contentHash: NO_SNAPSHOT,
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
        contentHash: NO_SNAPSHOT,
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
        contentHash: NO_SNAPSHOT,
        servedRows: [],
        resultLineCount: 3,
        firstChangedLine: 1,
      });
      expect(getServed(store, "s1", path)).toEqual([]);
    });
  });
});

describe("recordRejectionServes — truncation after an external shrink (issue #27)", () => {
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
      await recordRejectionServes(
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
      await recordRejectionServes("s1", path, [{ position: 1, hash: "bbb" }], "live");
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
        contentHash: snapshotHashFor("X\nf\ng"),
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
      const fffPositions = after.map((h, i) => (h === "fff" ? i : -1)).filter((i) => i >= 0);
      const gggPositions = after.map((h, i) => (h === "ggg" ? i : -1)).filter((i) => i >= 0);
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
          file: "w.txt",
          edits: [
            {
              anchor_from: served[0]!,
              anchor_to: served[0]!,
              replace_with: "A\n",
            },
          ],
        },
        home,
        { store, sessionKey: "s1" },
      );
      expect(file.appliedCount).toBe(1);
      expect(file.driftNotice).toBeUndefined();
    });
  });
});

describe("recordEpoch — epoch lifecycle belongs to full reads (#69)", () => {
  it("partial merges window rows without touching snapshotId, tombstone, or reported", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "f.txt");
      const handle = createSessionHandle("s1", path, store);
      await handle.record([
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
        { position: 2, hash: "ccc" },
      ]);
      addReported(store, "s1", path, ["bbb"]);
      await handle.retire(["zzz"]);
      await handle.recordEpoch({
        rows: [{ position: 1, hash: "BBB" }],
        lineCount: 3,
        fullReadHashes: ["aaa", "BBB", "ccc"],
        fullReadCanons: ["a", "b", "c"],
        snapshotId: "snap-partial",
        isFullRead: false,
      });
      expect(getServed(store, "s1", path)).toEqual(["aaa", "BBB", "ccc"]);
      expect(await loadEpochId("s1", path)).toBeUndefined();
      expect(getReported(store, "s1", path)).toEqual(new Set(["bbb"]));
      expect([...(await loadTombstone("s1", path))]).toContain("zzz");
    });
  });

  it("full stores snapshotId and clears tombstone", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "f.txt");
      const handle = createSessionHandle("s1", path, store);
      await handle.record([
        { position: 0, hash: "aaa" },
        { position: 1, hash: "bbb" },
      ]);
      await handle.retire(["zzz"]);
      await handle.recordEpoch({
        rows: [
          { position: 0, hash: "aaa" },
          { position: 1, hash: "bbb" },
        ],
        lineCount: 2,
        fullReadHashes: ["aaa", "bbb"],
        fullReadCanons: ["a", "b"],
        snapshotId: "snap-full",
        isFullRead: true,
      });
      expect(await loadEpochId("s1", path)).toBe("snap-full");
      expect([...(await loadTombstone("s1", path))]).toEqual([]);
    });
  });
});

describe("rejected edits — pre-load failures write zero serves (#69)", () => {
  it("malformed anchors throw before any serve write", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const absPath = join(home, "nope.txt");
      await expect(
        execEdits(
          {
            file: "nope.txt",
            edits: [
              {
                anchor_from: "findActivatingFile,",
                anchor_to: "x",
                replace_with: "y",
              },
            ],
          } as unknown as NormalizedEditRequest,
          home,
          { store, sessionKey: "s1" },
        ),
      ).rejects.toThrow(/E_MALFORMED_ANCHOR/);
      expect(getServed(store, "s1", absPath)).toEqual([]);
      expect(await loadEpochId("s1", absPath)).toBeUndefined();
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
      await handle.record(seed.fileHashes.map((hash, position) => ({ position, hash })));
      // WHY: a real `read` names the snapshot it served, so every row is leased (spec §3.1.2). A
      // WHY: hand-seeded mirror row without a contentHash grants no lease and now fails closed with
      // WHY: [E_STALE_ANCHOR] instead of content-resolving (ADR-0016, issue #96).
      await handle.recordEpoch({
        rows: seed.fileHashes.map((hash, position) => ({ position, hash })),
        lineCount: seed.fileHashes.length,
        fullReadHashes: [...seed.fileHashes],
        fullReadCanons: [...seedCanons],
        snapshotId: "snap-e2e-full",
        contentHash: snapshotHashFor(seed.normalized),
        isFullRead: true,
      });
      const first = await execEdits(
        {
          file: "dup.ts",
          edits: [
            {
              anchor_from: seed.fileHashes[0]!,
              anchor_to: seed.fileHashes[0]!,
              replace_with: `${startLines[0]}\n${Array(10).fill(dup).join("\n")}`,
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
            file: "dup.ts",
            edits: [
              {
                anchor_from: "findActivatingFile,",
                anchor_to: "x",
                replace_with: "y",
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
          file: "dup.ts",
          edits: [
            {
              anchor_from: afterFirst[targetPos]!,
              anchor_to: afterFirst[targetPos]!,
              replace_with: "const d = 40;",
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

describe("serve hooks grant served_leases (issue #81)", () => {
  const SESSION = "s-lease";

  it("recordEpoch (read) grants an active lease per served anchor", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "epoch.txt");
      const hashes = await lineHashes("alpha\nbravo\ncharlie\n", path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordEpoch({
        rows: hashes.map((hash, position) => ({ position, hash })),
        lineCount: hashes.length,
        fullReadHashes: hashes,
        isFullRead: true,
        contentHash: snapshotHashFor("alpha\nbravo\ncharlie\n"),
      });
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.map((lease) => lease.served_line_number)).toEqual([1, 2, 3]);
      expect(leases.every((lease) => lease.retired_at === null)).toBe(true);
    });
  });

  it("recordEpoch binds leases to the served snapshot, not the newest one", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "revert.txt");
      const original = "alpha\nbravo\ncharlie\n";
      const originalHashes = await lineHashes(original, path);
      // a later snapshot for the same path must not steal the identity of the served content
      await lineHashes("alpha\nBRAVO\ncharlie\n", path);

      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordEpoch({
        rows: originalHashes.map((hash, position) => ({ position, hash })),
        lineCount: originalHashes.length,
        fullReadHashes: originalHashes,
        isFullRead: true,
        contentHash: snapshotHashFor(original),
      });

      const served = snapshotHashFor(original);
      const lineage = store.db
        .prepare(
          "SELECT ll.line_id FROM line_lineage ll " +
            "JOIN file_snapshots fs ON fs.snapshot_id = ll.snapshot_id " +
            "WHERE fs.path = ? AND fs.snapshot_hash = ? ORDER BY ll.line_number ASC",
        )
        .all(path, served) as { line_id: number }[];
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual(originalHashes);
      expect(leases.map((lease) => lease.line_id)).toEqual(lineage.map((row) => row.line_id));
      expect(leases.every((lease) => lease.served_snapshot_hash === served)).toBe(true);
    });
  });

  it("recordDiff (post-edit dense serve) grants a lease per served row", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "diff.txt");
      const hashes = await lineHashes("alpha\nbravo\ncharlie\n", path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordDiff(
        hashes.map((hash, position) => ({ position, hash })),
        {
          resultLineCount: hashes.length,
          firstChangedLine: 1,
          contentHash: snapshotHashFor("alpha\nbravo\ncharlie\n"),
        },
      );
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.every((lease) => lease.retired_at === null)).toBe(true);
    });
  });

  it("recordServeFeedback (live rejection serve) grants a lease per served row", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "serve.txt");
      const hashes = await lineHashes("alpha\nbravo\n", path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordServeFeedback(
        [{ position: 1, hash: hashes[1]! }],
        "live",
        hashes.length,
        snapshotHashFor("alpha\nbravo\n"),
      );
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual([hashes[1]]);
      expect(leases[0]!.served_line_number).toBe(2);
    });
  });

  it("recordTruncated (drift notice) grants a lease per drifted row", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "trunc.txt");
      const hashes = await lineHashes("alpha\nbravo\n", path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordTruncated(
        [{ position: 0, hash: hashes[0]! }],
        hashes.length,
        0,
        snapshotHashFor("alpha\nbravo\n"),
      );
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual([hashes[0]]);
      expect(leases[0]!.retired_at).toBeNull();
    });
  });

  it("recordLeases (undo re-serve) grants a lease per restored row", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "undo.txt");
      const hashes = await lineHashes("alpha\nbravo\n", path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordLeases(
        hashes.map((hash, position) => ({ position, hash })),
        snapshotHashFor("alpha\nbravo\n"),
      );
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.every((lease) => lease.retired_at === null)).toBe(true);
    });
  });

  it("re-serving an older snapshot rebinds its anchors to that snapshot, not the newest", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "cyclic.txt");
      const contentA = "alpha\nbravo\ncharlie\n";
      const hashesA = await lineHashes(contentA, path);
      const handle = createSessionHandle(SESSION, path, store);

      // read A: snapA materializes and leases its anchors
      await handle.recordEpoch({
        rows: hashesA.map((hash, position) => ({ position, hash })),
        lineCount: hashesA.length,
        fullReadHashes: hashesA,
        isFullRead: true,
        contentHash: snapshotHashFor(contentA),
      });
      const idsA = new Map(loadLeases(store, SESSION, path).map((l) => [l.anchor, l.line_id]));

      // edit to B: the edit path's post-write commit materializes snapB authoritatively,
      // which retires A's leases; the dense diff serve then leases B's anchors
      const contentB = "alpha\nBRAVO\ncharlie\n";
      const hashesB = await lineHashes(contentB, path);
      await upsertSnapshotFor(
        {
          path,
          snapshotHash: snapshotHashFor(contentB),
          lineCount: hashesB.length,
          hashes: hashesB,
          content: contentB,
        },
        { retireLeases: true },
      );
      await handle.recordDiff(
        hashesB.map((hash, position) => ({ position, hash })),
        {
          resultLineCount: hashesB.length,
          firstChangedLine: 2,
          contentHash: snapshotHashFor(contentB),
        },
      );
      expect(
        loadLeases(store, SESSION, path)
          .filter((lease) => lease.retired_at === null)
          .map((lease) => lease.anchor),
      ).toEqual(hashesB);

      // serve A again (cyclic edit bar->foo, or undo revert): snapA is a cache hit, zero new ids
      await handle.recordDiff(
        hashesA.map((hash, position) => ({ position, hash })),
        {
          resultLineCount: hashesA.length,
          firstChangedLine: 2,
          contentHash: snapshotHashFor(contentA),
        },
      );

      const reServed = loadLeases(store, SESSION, path).filter((lease) =>
        hashesA.includes(lease.anchor),
      );
      expect(reServed.map((lease) => lease.line_id)).toEqual(hashesA.map((hash) => idsA.get(hash)));
      expect(reServed.every((lease) => lease.retired_at === null)).toBe(true);
      expect(
        reServed.every((lease) => lease.served_snapshot_hash === snapshotHashFor(contentA)),
      ).toBe(true);
    });
  });

  it("recordLeases (undo re-serve) binds to the restored snapshot, not the newest", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const path = join(home, "undo-revert.txt");
      const contentA = "alpha\nbravo\ncharlie\n";
      const hashesA = await lineHashes(contentA, path);
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordEpoch({
        rows: hashesA.map((hash, position) => ({ position, hash })),
        lineCount: hashesA.length,
        fullReadHashes: hashesA,
        isFullRead: true,
        contentHash: snapshotHashFor(contentA),
      });
      const idsA = new Map(loadLeases(store, SESSION, path).map((l) => [l.anchor, l.line_id]));

      // the edit that undo reverts
      const contentB = "alpha\nBRAVO\ncharlie\n";
      const hashesB = await lineHashes(contentB, path);
      await handle.recordDiff(
        hashesB.map((hash, position) => ({ position, hash })),
        {
          resultLineCount: hashesB.length,
          firstChangedLine: 2,
          contentHash: snapshotHashFor(contentB),
        },
      );

      // undo restores A; its snapshot is a cache hit so no new ids are issued
      await handle.recordLeases(
        hashesA.map((hash, position) => ({ position, hash })),
        snapshotHashFor(contentA),
      );

      const reServed = loadLeases(store, SESSION, path).filter((lease) =>
        hashesA.includes(lease.anchor),
      );
      expect(reServed.map((lease) => lease.line_id)).toEqual(hashesA.map((hash) => idsA.get(hash)));
      expect(reServed.every((lease) => lease.retired_at === null)).toBe(true);
      expect(
        reServed.every((lease) => lease.served_snapshot_hash === snapshotHashFor(contentA)),
      ).toBe(true);
    });
  });

  it("a cyclic edit back to served content rebinds leases to that content's snapshot", async () => {
    await withTempHome(async (home) => {
      const store = await loadHashStore();
      const contentA = "alpha\nbravo\ncharlie\n";
      await writeFile(join(home, "cyclic-pipeline.txt"), contentA);
      const seed = await readNormFile("cyclic-pipeline.txt", home, { store });
      const path = seed.absolutePath;
      const hashesA = seed.fileHashes;
      const handle = createSessionHandle(SESSION, path, store);
      await handle.recordEpoch({
        rows: hashesA.map((hash, position) => ({ position, hash })),
        lineCount: hashesA.length,
        fullReadHashes: hashesA,
        fullReadCanons: seed.normalized.split("\n").map((line) => canon(line)),
        isFullRead: true,
        contentHash: snapshotHashFor(contentA),
      });
      const idsA = new Map(loadLeases(store, SESSION, path).map((l) => [l.anchor, l.line_id]));

      // edit A -> B: the post-edit diff serve materializes snapB and retires A's leases
      const contentB = "alpha\nBRAVO\ncharlie\n";
      const first = await apply(
        {
          file: "cyclic-pipeline.txt",
          edits: [{ anchor_from: hashesA[1]!, anchor_to: hashesA[1]!, replace_with: "BRAVO" }],
        },
        home,
        { store, sessionKey: SESSION },
      );
      expect(first.raw.appliedCount).toBe(1);
      expect(await readFile(path, "utf-8")).toBe(contentB);
      const hashesB = await lineHashes(contentB, path);

      // edit B -> A: snapA is a cache hit, so the diff serve must re-bind A's leases to snapA
      const second = await apply(
        {
          file: "cyclic-pipeline.txt",
          edits: [{ anchor_from: hashesB[1]!, anchor_to: hashesB[1]!, replace_with: "bravo" }],
        },
        home,
        { store, sessionKey: SESSION },
      );
      expect(second.raw.appliedCount).toBe(1);
      expect(await readFile(path, "utf-8")).toBe(contentA);

      const reServed = loadLeases(store, SESSION, path).filter((lease) =>
        hashesA.includes(lease.anchor),
      );
      expect(reServed.map((lease) => lease.line_id)).toEqual(hashesA.map((hash) => idsA.get(hash)));
      expect(reServed.every((lease) => lease.retired_at === null)).toBe(true);
      expect(
        reServed.every((lease) => lease.served_snapshot_hash === snapshotHashFor(contentA)),
      ).toBe(true);
    });
  });
});

describe("write-nothing paths never retire active leases (issue #81 §3.2.4)", () => {
  const SESSION = "s-write-nothing";
  const ORIGINAL = "alpha\nbravo\ncharlie\n";

  async function seedServedLeases(home: string): Promise<{
    store: Awaited<ReturnType<typeof loadHashStore>>;
    path: string;
    hashes: string[];
  }> {
    const store = await loadHashStore();
    await writeFile(join(home, "nothing.txt"), ORIGINAL, "utf-8");
    const seed = await readNormFile("nothing.txt", home, { store });
    const handle = createSessionHandle(SESSION, seed.absolutePath, store);
    await handle.recordEpoch({
      rows: seed.fileHashes.map((hash, position) => ({ position, hash })),
      lineCount: seed.fileHashes.length,
      fullReadHashes: seed.fileHashes,
      fullReadCanons: seed.normalized.split("\n").map((line) => canon(line)),
      isFullRead: true,
      contentHash: snapshotHashFor(ORIGINAL),
    });
    return { store, path: seed.absolutePath, hashes: seed.fileHashes };
  }

  it("an aborted batch leaves pre-batch leases active and the bytes unchanged", async () => {
    await withTempHome(async (home) => {
      const { store, path, hashes } = await seedServedLeases(home);
      expect(loadLeases(store, SESSION, path).map((lease) => lease.retired_at)).toEqual([
        null,
        null,
        null,
      ]);

      const rejection = (await apply(
        {
          file: "nothing.txt",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" },
            { anchor_from: "zzz", anchor_to: "zzz", replace_with: "zzz" },
          ],
        },
        home,
        { store, sessionKey: SESSION },
      ).catch((error: unknown) => error)) as Error;

      // The failing item keeps its OWN code — the unleased anchor is what the model must fix — plus
      // the atomicity trailer; `[E_BATCH_ABORT]` is reserved for overlapping/nested spans.
      expect(rejection.message).toContain("[E_UNKNOWN_ANCHOR]");
      expect(rejection.message).not.toContain("[E_BATCH_ABORT]");
      expect(rejection.message).toContain(
        "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.",
      );

      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);
      const leases = loadLeases(store, SESSION, path);
      expect(leases.map((lease) => lease.anchor)).toEqual(hashes);
      expect(leases.map((lease) => lease.retired_at)).toEqual([null, null, null]);

      // 0 stale retries: the model can immediately retry with the anchors it already holds.
      const retried = await apply(
        {
          file: "nothing.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "BRAVO" }],
        },
        home,
        { store, sessionKey: SESSION },
      );
      expect(retried.raw.appliedCount).toBe(1);
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("an undo-persist failure (E_UNDO_UNAVAILABLE) leaves leases active and the bytes unchanged", async () => {
    await withTempHome(async (home) => {
      const { store, path, hashes } = await seedServedLeases(home);
      const undoStore = await import("../../src/undo-store");
      const spy = vi.spyOn(undoStore, "writeUndo").mockImplementation(() => {
        throw new Error("store down");
      });
      try {
        await expect(
          apply(
            {
              file: "nothing.txt",
              edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" }],
            },
            home,
            { store, sessionKey: SESSION },
          ),
        ).rejects.toThrow(/E_UNDO_UNAVAILABLE/);
      } finally {
        spy.mockRestore();
      }

      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);
      expect(loadLeases(store, SESSION, path).map((lease) => lease.retired_at)).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  it("a preview (noPersist) leaves leases active and the bytes unchanged", async () => {
    await withTempHome(async (home) => {
      const { store, path, hashes } = await seedServedLeases(home);
      const previewed = await execEdits(
        {
          file: "nothing.txt",
          edits: [{ anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: "ALPHA" }],
        },
        home,
        { store, sessionKey: SESSION, noPersist: true },
      );
      expect(previewed.appliedCount).toBe(1);

      expect(await readFile(path, "utf-8")).toBe(ORIGINAL);
      expect(loadLeases(store, SESSION, path).map((lease) => lease.retired_at)).toEqual([
        null,
        null,
        null,
      ]);
    });
  });
});
