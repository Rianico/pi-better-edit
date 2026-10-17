import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { initHasher } from "../../src/hashline/hasher.js";
import { lineHashes } from "../../src/hashline/index.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { createSessionHandle, ensureServedSchema } from "../../src/served-session/session.js";
import * as snapshotStore from "../../src/snapshot-store";
import {
  getWritableTempRoot,
  setupIntegrationTest,
  getText,
  withTempFile,
} from "../support/fixtures.js";

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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      exec: vi.fn(),
      prepare: vi.fn(() => {
        throw new Error("migration boom");
      }),
    } as unknown as DatabaseSync;
    expect(() => ensureServedSchema(db)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toMatch(/served/i);
  });

  it("lease grant failure logs once and keeps the serve (best-effort)", async () => {
    await withTempHome(async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      const leaseLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0] ?? "")
          .toLowerCase()
          .includes("lease"),
      );
      expect(leaseLogs).toHaveLength(1);
    });
  });

  it("undo anchor recovery logs and falls back to stored hashes", async () => {
    const original = "alpha\nbeta\ngamma\n";
    await withTempFile("undo-anchor-121.txt", original, async ({ cwd }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undoTool = getTool("undo_last_edit");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      const anchorLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0] ?? "")
          .toLowerCase()
          .includes("anchor"),
      );
      expect(anchorLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("undo restore-transaction failure logs and still restores the file", async () => {
    const original = "one\ntwo\nthree\n";
    await withTempFile("undo-restore-121.txt", original, async ({ cwd }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undoTool = getTool("undo_last_edit");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
        const restoreLogs = errorSpy.mock.calls.filter((call) =>
          String(call[0] ?? "")
            .toLowerCase()
            .includes("undo restore transaction"),
        );
        expect(restoreLogs.length).toBeGreaterThanOrEqual(1);
      } finally {
        store.db.exec("DROP TRIGGER IF EXISTS undo_mirror_boom");
      }
    });
  });
});
