import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServedRow } from "../../src/domain-errors.js";
import type { EditDetails } from "../../src/edit-response.js";
import { LENS_BRIDGE_ENV_VAR } from "../../src/integrations/pi-lens/config.js";
import { attachMutationBridgeAdapter } from "../../src/integrations/pi-lens/mutation-bridge-adapter.js";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";
import {
  addMutatedFileObserver,
  clearMutatedFileObserversForTests,
  type MutatedFileNotification,
} from "../../src/mutated-files.js";
import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  type ServedSpanNotification,
} from "../../src/served-spans.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  useTestHome,
  withTempDir,
} from "../support/fixtures";

useTestHome();

const BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");
const CONSUMER = "pi-better-edit";
const notifications: MutatedFileNotification[] = [];
const served: ServedSpanNotification[] = [];
const entries: Array<Record<string, unknown>> = [];
const savedEnv = process.env[LENS_BRIDGE_ENV_VAR];
let previousBridge: unknown;

type Harness = ReturnType<typeof setupIntegrationTest>;
type Hooks = ReturnType<typeof createLifecycleHooks>;

function installBridge(): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = {
    version: 1,
    recordMutation: (entry: unknown): boolean => {
      entries.push(entry as Record<string, unknown>);
      return true;
    },
  };
}

function captureBridge(): unknown {
  return (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
}

function restoreBridge(previous: unknown): void {
  if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  else (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = previous;
}

function restoreEnv(): void {
  if (savedEnv === undefined) delete process.env[LENS_BRIDGE_ENV_VAR];
  else process.env[LENS_BRIDGE_ENV_VAR] = savedEnv;
}

function refsOf(text: string): (needle: string) => string {
  const lines = text.split("\n");
  return (needle: string): string =>
    extractHash(lines.find((line) => line.includes(`│${needle}`))!);
}

async function withHarness(
  prefix: string,
  run: (harness: Harness, dir: string, hooks: Hooks) => Promise<void>,
): Promise<void> {
  await withTempDir(prefix, async (dir) => {
    const harness = setupIntegrationTest(dir);
    // WHY: the observer registries are module-global and `register` already attached the shipped
    // WHY: adapter, so clearing first leaves exactly one mutation adapter under test, with a cwd
    // WHY: injected to make the mode lookup deterministic.
    clearMutatedFileObserversForTests();
    clearServedSpanObserversForTests();
    notifications.length = 0;
    served.length = 0;
    entries.length = 0;
    addMutatedFileObserver((notification) => notifications.push(notification));
    addServedSpanObserver((notification) => served.push(notification));
    previousBridge = captureBridge();
    installBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachMutationBridgeAdapter({ getCwd: () => dir });
    const hooks = createLifecycleHooks();
    try {
      await run(harness, dir, hooks);
    } finally {
      detach();
      restoreBridge(previousBridge);
      restoreEnv();
      clearMutatedFileObserversForTests();
      clearServedSpanObserversForTests();
    }
  });
}

afterEach(() => {
  restoreEnv();
  notifications.length = 0;
  served.length = 0;
  entries.length = 0;
});

describe("lifecycle mutation-bridge wiring", () => {
  it("mirrors one whole-file mutation for a landed write", async () => {
    await withHarness("pbe-mut-write-", async (harness, dir, hooks) => {
      const path = join(dir, "p.txt");
      await writeFile(path, "one\ntwo\n", "utf-8");

      await hooks.onWrite(
        {
          toolName: "write",
          isError: false,
          input: { path: "p.txt", content: "one\ntwo\n" },
          content: [],
        },
        harness.ctx,
      );

      expect(notifications).toEqual([
        { filePath: path, kind: "write", ranges: [], sourceTool: "write" },
      ]);
      expect(entries).toEqual([{ filePath: path, kind: "write", consumer: CONSUMER }]);
      expect(entries[0]).not.toHaveProperty("touchedLines");
      expect(entries[0]).not.toHaveProperty("editRanges");
    });
  });

  it("mirrors one ranged mutation for a landed edit, matching the served change span", async () => {
    await withHarness("pbe-mut-edit-", async (harness, dir, hooks) => {
      const path = join(dir, "p.txt");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { path: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      const result = (await harness.editTool.execute(
        "e1",
        { path: "p.txt", edits: [[ref("beta"), ref("beta"), "BETA"]] },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: EditDetails };
      const first = result.details.servedByPath?.[0]?.firstChangedLine;
      const last = result.details.servedByPath?.[0]?.lastChangedLine;
      expect([first, last]).toEqual([2, 2]);

      await hooks.onEdit(
        {
          toolName: "edit",
          isError: false,
          input: { path: "p.txt" },
          details: result.details,
          content: [],
        },
        harness.ctx,
      );

      expect(notifications).toEqual([
        {
          filePath: path,
          kind: "edit",
          ranges: [{ startLine: 2, lineCount: 1 }],
          sourceTool: "edit",
        },
      ]);
      expect(entries).toEqual([
        {
          filePath: path,
          kind: "edit",
          touchedLines: [2, 2],
          editRanges: [[2, 2]],
          consumer: CONSUMER,
        },
      ]);
    });
  });

  it("labels a restored undo as its own source and mirrors the restored span", async () => {
    await withHarness("pbe-mut-undo-", async (harness, dir, hooks) => {
      const path = join(dir, "p.txt");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { path: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      await harness.editTool.execute(
        "e1",
        { path: "p.txt", edits: [[ref("beta"), ref("beta"), "BETA"]] },
        undefined,
        undefined,
        harness.ctx,
      );
      const undo = (await harness.undoTool.execute(
        "u1",
        { path: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: EditDetails };

      await hooks.onEdit(
        {
          toolName: "undo_last_edit",
          isError: false,
          input: { path: "p.txt" },
          details: undo.details,
          content: [],
        },
        harness.ctx,
      );

      expect(notifications).toEqual([
        {
          filePath: path,
          kind: "edit",
          ranges: [{ startLine: 2, lineCount: 1 }],
          sourceTool: "undo_last_edit",
        },
      ]);
      expect(entries.at(-1)).toEqual({
        filePath: path,
        kind: "edit",
        touchedLines: [2, 2],
        editRanges: [[2, 2]],
        consumer: CONSUMER,
      });
    });
  });

  it("never mirrors a reject-and-serve rejection, even though it serves rows", async () => {
    await withHarness("pbe-mut-reject-", async (harness, dir, hooks) => {
      await writeFile(join(dir, "p.txt"), "alpha\nbeta\ngamma\ndelta\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { path: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      await writeFile(join(dir, "p.txt"), "alpha\nBETA-EXTERNAL\ngamma\ndelta\n", "utf-8");
      notifications.length = 0;
      served.length = 0;
      entries.length = 0;

      const rejection = await harness.editTool
        .execute(
          "e1",
          { path: "p.txt", edits: [[ref("alpha"), ref("delta"), "X"]] },
          undefined,
          undefined,
          harness.ctx,
        )
        .catch((error: unknown) => error);
      expect((rejection as { code?: unknown }).code).toBe("E_STALE_RANGE");
      const rows = (rejection as { servedRows?: ServedRow[] }).servedRows ?? [];
      expect(rows.length).toBeGreaterThan(0);

      // The refusal is a read: the read bridge is told, the mutation bridge must stay untouched.
      expect(served.map((notification) => notification.source)).toEqual(["reject-and-serve"]);
      expect(notifications).toEqual([]);
      expect(entries).toEqual([]);

      const asResult = await hooks.onEdit(
        {
          toolName: "edit",
          isError: false,
          input: { path: "p.txt" },
          details: rejection,
          content: [],
        },
        harness.ctx,
      );
      expect(asResult).toBeUndefined();
      expect(notifications).toEqual([]);
      expect(entries).toEqual([]);
    });
  });

  it("never mirrors a noop edit", async () => {
    await withHarness("pbe-mut-noop-", async (harness, dir, hooks) => {
      await writeFile(join(dir, "p.txt"), "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { path: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      const outcome = (await harness.editTool
        .execute(
          "e1",
          { path: "p.txt", edits: [[ref("beta"), ref("beta"), "beta"]] },
          undefined,
          undefined,
          harness.ctx,
        )
        .catch((error: unknown) => error)) as { details?: EditDetails };
      expect(outcome.details?.metrics?.classification).toBe("noop");

      notifications.length = 0;
      served.length = 0;
      entries.length = 0;
      await hooks.onEdit(
        {
          toolName: "edit",
          isError: false,
          input: { path: "p.txt" },
          details: outcome.details,
          content: [],
        },
        harness.ctx,
      );

      expect(notifications).toEqual([]);
      expect(entries).toEqual([]);
      // Observation: with no diff to serve, the read bridge stays silent on a noop too.
      expect(served).toEqual([]);
    });
  });
});
