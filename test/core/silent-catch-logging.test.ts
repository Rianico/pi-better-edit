import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { initHasher } from "../../src/hashline/hasher.js";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { createSessionHandle, ensureServedSchema } from "../../src/served-session/session.js";
import * as snapshotStore from "../../src/snapshot-store";
import {
  getWritableTempRoot,
  setupIntegrationTest,
  getText,
  withTempFile,
  readDiagnostics,
  clearDiagnostics,
} from "../support/fixtures.js";

/**
 * The sink's contract is the file, not the console: an assertion on `console.error` would re-assert
 * the fd-1/2 write the sink exists to remove (the terminal belongs to Pi's renderer).
 */
function diagnosticMessages(match: RegExp): string[] {
  return readDiagnostics()
    .map((record) => record.message)
    .filter((message) => match.test(message));
}

beforeAll(async () => {
  await initHasher();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "silent-catch-121-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  // WHY (#89): these tests open/assert the store under THIS temp home, so opt out of the worker-wide
  // WHY: setupFiles seam and let it resolve through HOME, which is fresh per call here.
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", "");
  try {
    await run(home);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

describe("issue #121 — silent catches log with context and stay best-effort", () => {
  it("has no empty catch blocks in the five issue sites", () => {
    const pattern = /catch\s*(\([^)]*\))?\s*\{\s*\}/;
    const offenders: string[] = [];
    for (const file of ["src/edit-undo.ts", "src/served-session/session.ts"]) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        if (pattern.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("ensureServedSchema logs a migration failure without throwing", () => {
    clearDiagnostics();
    const db = {
      exec: vi.fn(),
      prepare: vi.fn(() => {
        throw new Error("migration boom");
      }),
    } as unknown as DatabaseSync;
    expect(() => ensureServedSchema(db)).not.toThrow();
    const records = readDiagnostics();
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toMatch(/served/i);
  });

  it("lease grant failure logs once and keeps the serve (best-effort)", async () => {
    await withTempHome(async () => {
      // WHY: the lease grant is the best-effort step of a serve record (#151): the mirror row is
      // WHY: already committed, so a failed grant must log with context and leave the serve intact.
      // WHY: The injection point is the SQL itself — a trigger aborts only lease writes.
      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER lease_boom BEFORE INSERT ON served_leases " +
          "BEGIN SELECT RAISE(ABORT, 'lease boom'); END;",
      );
      const path = "/lease-121.ts";
      const content = "alpha\nbeta\n";
      const hashes = await lineHashes(content, path);
      const handle = createSessionHandle("sess-lease-121", path, store);
      await expect(
        handle.recordDiff(
          hashes.map((hash, position) => ({ position, hash })),
          { contentHash: snapshotStore.snapshotHashFor(content) },
        ),
      ).resolves.toBeUndefined();
      expect(await handle.load()).toEqual(hashes);
      const leaseLogs = diagnosticMessages(/lease/i);
      expect(leaseLogs).toHaveLength(1);
    });
  });

  it("undo anchor recovery logs and falls back to stored hashes", async () => {
    const original = "alpha\nbeta\ngamma\n";
    await withTempFile("undo-anchor-121.txt", original, async ({ cwd }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undoTool = getTool("undo_last_edit");
      vi.spyOn(snapshotStore, "anchorsForSnapshotHash").mockRejectedValue(
        new Error("anchor lookup boom"),
      );

      const r1 = await readTool.execute(
        "r1",
        { file: "undo-anchor-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const anchor = lines[1]?.split("│")[0] ?? "";
      expect(anchor).toMatch(/^[A-Za-z0-9]{4}$/);
      await editTool.execute(
        "e1",
        {
          file: "undo-anchor-121.txt",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BETA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const result = await undoTool.execute(
        "u1",
        { path: "undo-anchor-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError).toBeFalsy();
      expect(await readFile(join(cwd, "undo-anchor-121.txt"), "utf-8")).toBe(original);
      const anchorLogs = diagnosticMessages(/anchor/i);
      expect(anchorLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("undo restore-transaction failure logs and still restores the file", async () => {
    const original = "one\ntwo\nthree\n";
    await withTempFile("undo-restore-121.txt", original, async ({ cwd }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undoTool = getTool("undo_last_edit");

      const r1 = await readTool.execute(
        "r1",
        { file: "undo-restore-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const anchor = lines[1]?.split("│")[0] ?? "";
      await editTool.execute(
        "e1",
        {
          file: "undo-restore-121.txt",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "TWO" }],
        },
        undefined,
        undefined,
        ctx,
      );

      // WHY: CAND-3 folded the undo's retire/adopt/mirror writes into one restore transaction; the
      // injection aborts the mirror UPDATE so the whole transaction (and its log) exercises that path.
      const store = await loadHashStore();
      store.db.exec(
        "CREATE TRIGGER undo_mirror_boom BEFORE UPDATE OF hashes ON served " +
          "BEGIN SELECT RAISE(ABORT, 'undo mirror boom'); END;",
      );
      try {
        const result = await undoTool.execute(
          "u1",
          { path: "undo-restore-121.txt" },
          undefined,
          undefined,
          ctx,
        );
        expect(result.isError).toBeFalsy();
        expect(await readFile(join(cwd, "undo-restore-121.txt"), "utf-8")).toBe(original);
        expect(getText(result)).toContain("Store synchronization deferred");
        const restoreLogs = diagnosticMessages(/undo restore transaction/i);
        expect(restoreLogs.length).toBeGreaterThanOrEqual(1);
      } finally {
        store.db.exec("DROP TRIGGER IF EXISTS undo_mirror_boom");
      }
    });
  });
});
