import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { initHasher } from "../../src/hashline/hasher.js";
import { globalCanonStore } from "../../src/hashline/hash.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import { createSessionHandle, ensureServedSchema } from "../../src/served-session/session.js";
import * as snapshotStore from "../../src/snapshot-store";
import * as sessionModule from "../../src/served-session/session.js";
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

  it("canon sync failure logs once and keeps the serve (best-effort)", async () => {
    await withTempHome(async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalCanonStore, "get").mockImplementation(() => {
        throw new Error("canon boom");
      });
      const store = await loadHashStore();
      const handle = createSessionHandle("sess-canon-121", "/canon-121.ts", store);
      const rows = [
        { position: 0, hash: "abc" },
        { position: 1, hash: "def" },
      ];
      await expect(handle.record(rows)).resolves.toBeUndefined();
      expect(await handle.load()).toEqual(["abc", "def"]);
      const canonLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0] ?? "")
          .toLowerCase()
          .includes("canon"),
      );
      expect(canonLogs).toHaveLength(1);
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
        { path: "undo-anchor-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const anchor = lines[1]?.split("│")[0] ?? "";
      expect(anchor).toMatch(/^[A-Za-z0-9]{3}$/);
      await editTool.execute(
        "e1",
        { path: "undo-anchor-121.txt", edits: [[anchor, anchor, "BETA"]] },
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

  it("undo retire failure logs and still restores the file", async () => {
    const original = "one\ntwo\nthree\n";
    await withTempFile("undo-retire-121.txt", original, async ({ cwd }) => {
      const { ctx, readTool, editTool, getTool } = setupIntegrationTest(cwd);
      const undoTool = getTool("undo_last_edit");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const r1 = await readTool.execute(
        "r1",
        { path: "undo-retire-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(r1).split("\n");
      const anchor = lines[1]?.split("│")[0] ?? "";
      await editTool.execute(
        "e1",
        { path: "undo-retire-121.txt", edits: [[anchor, anchor, "TWO"]] },
        undefined,
        undefined,
        ctx,
      );

      const realCreate = sessionModule.createSessionHandle;
      vi.spyOn(sessionModule, "createSessionHandle").mockImplementation(((
        sessionKey: string,
        path: string,
        store?: never,
      ) => {
        const handle = realCreate(sessionKey, path, store);
        return {
          ...handle,
          retire: async () => {
            throw new Error("retire boom");
          },
        };
      }) as typeof sessionModule.createSessionHandle);

      const result = await undoTool.execute(
        "u1",
        { path: "undo-retire-121.txt" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.isError).toBeFalsy();
      expect(await readFile(join(cwd, "undo-retire-121.txt"), "utf-8")).toBe(original);
      const retireLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0] ?? "")
          .toLowerCase()
          .includes("retire"),
      );
      expect(retireLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
