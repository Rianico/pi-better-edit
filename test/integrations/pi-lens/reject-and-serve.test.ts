import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServedRow } from "../../../src/domain-errors.js";
import { createEditTool } from "../../../src/edit-tool.js";
import { LENS_BRIDGE_ENV_VAR } from "../../../src/integrations/pi-lens/config.js";
import { attachReadBridgeAdapter } from "../../../src/integrations/pi-lens/read-bridge-adapter.js";
import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  servedRowsToSpans,
  type ServedSpanNotification,
} from "../../../src/served-spans.js";
import {
  extractHash,
  getText,
  setupIntegrationTest,
  testSessionManager,
  useTestHome,
  withTempDir,
} from "../../support/fixtures";

useTestHome();

const BRIDGE_KEY = Symbol.for("pi-lens:read-bridge");
const CONSUMER = "pi-better-edit";
const notifications: ServedSpanNotification[] = [];
const calls: Array<Record<string, unknown>> = [];
const savedHome = process.env.HOME;
let previousBridge: unknown;

type Harness = ReturnType<typeof setupIntegrationTest>;

function installBridge(): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = {
    version: 1,
    recordRead: (entry: unknown): void => {
      calls.push(entry as Record<string, unknown>);
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

function refsOf(text: string): (needle: string) => string {
  const lines = text.split("\n");
  return (needle: string): string =>
    extractHash(lines.find((line) => line.includes(`│${needle}`))!);
}

async function withLensHarness(
  prefix: string,
  run: (harness: Harness, dir: string) => Promise<void>,
): Promise<void> {
  await withTempDir(prefix, async (dir) => {
    const harness = setupIntegrationTest(dir);
    // SAFETY: the registry is module-global and `register` already attached the shipped adapter, so
    // SAFETY: clearing first keeps exactly one adapter under test with an injected cwd.
    clearServedSpanObserversForTests();
    notifications.length = 0;
    calls.length = 0;
    addServedSpanObserver((notification) => notifications.push(notification));
    previousBridge = captureBridge();
    installBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachReadBridgeAdapter({ getCwd: () => dir });
    try {
      await run(harness, dir);
    } finally {
      detach();
      restoreBridge(previousBridge);
      delete process.env[LENS_BRIDGE_ENV_VAR];
      clearServedSpanObserversForTests();
    }
  });
}

/** Read, then drift the file on disk: the pre-mutation identity check rejects with served rows. */
async function seedDriftRejection(
  harness: Harness,
  dir: string,
): Promise<{ anchor_from: string; anchor_to: string; text: string }[]> {
  await writeFile(join(dir, "p.txt"), "alpha\nbeta\ngamma\ndelta\n", "utf-8");
  const read = await harness.readTool.execute(
    "r1",
    { file: "p.txt" },
    undefined,
    undefined,
    harness.ctx,
  );
  const ref = refsOf(getText(read));
  await writeFile(join(dir, "p.txt"), "alpha\nBETA-EXTERNAL\ngamma\ndelta\n", "utf-8");
  return [{ anchor_from: ref("alpha"), anchor_to: ref("delta"), text: "X" }];
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  notifications.length = 0;
  calls.length = 0;
});

describe("reject-and-serve mirror", () => {
  it("contains the preview rehearsal: the same rejection mirrors nothing", async () => {
    await withLensHarness("pbe-lens-preview-", async (harness, dir) => {
      const edits = await seedDriftRejection(harness, dir);
      notifications.length = 0;
      calls.length = 0;
      const previewTool = createEditTool();

      const preview = await previewTool.preview({ file: "p.txt", edits }, dir, {
        sessionManager: testSessionManager,
      });
      expect("error" in preview).toBe(true);
      expect(notifications).toEqual([]);
      expect(calls).toEqual([]);

      // WHY: a preview without the session the anchors were served to fails loud instead of minting
      // WHY: a fresh key whose lease lookups would miss as a misleading E_UNKNOWN_ANCHOR.
      const sessionless = await previewTool.preview({ file: "p.txt", edits }, dir, {});
      expect(sessionless).toEqual({ error: expect.any(String) });
      expect(notifications).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  it("mirrors a live rejection's own rows to the bridge", async () => {
    await withLensHarness("pbe-lens-reject-", async (harness, dir) => {
      const edits = await seedDriftRejection(harness, dir);
      notifications.length = 0;
      calls.length = 0;

      const rejection = await harness.editTool
        .execute("e1", { file: "p.txt", edits }, undefined, undefined, harness.ctx)
        .catch((error: unknown) => error);

      expect((rejection as { code?: unknown }).code).toBe("E_STALE_RANGE");
      const servedRows = (rejection as { servedRows: ServedRow[] }).servedRows;
      expect(servedRows.length).toBeGreaterThan(0);
      const path = join(dir, "p.txt");
      expect(servedRows.every((row) => Number.isInteger(row.position) && row.position >= 0)).toBe(
        true,
      );

      const spans = servedRowsToSpans(servedRows);
      expect(spans.length).toBeGreaterThan(0);
      expect(notifications).toEqual([{ filePath: path, spans, source: "reject-and-serve" }]);
      expect(calls).toEqual(
        spans.map((span) => ({
          filePath: path,
          requestedOffset: span.startLine,
          requestedLimit: span.lineCount,
          consumer: CONSUMER,
        })),
      );
    });
  });

  it("stays silent when a rejection carries no served rows at all", async () => {
    await withLensHarness("pbe-lens-empty-", async (harness, dir) => {
      await writeFile(join(dir, "q.txt"), "one\ntwo\n", "utf-8");
      await harness.readTool.execute("r1", { file: "q.txt" }, undefined, undefined, harness.ctx);
      notifications.length = 0;
      calls.length = 0;

      const rejection = await harness.editTool
        .execute(
          "e1",
          { file: "q.txt", edits: [{ anchor_from: "ZZZZ", anchor_to: "ZZZZ", text: "NEW" }] },
          undefined,
          undefined,
          harness.ctx,
        )
        .catch((error: unknown) => error);

      expect((rejection as { code?: unknown }).code).toBe("E_UNKNOWN_ANCHOR");
      expect((rejection as { servedRows: ServedRow[] }).servedRows).toEqual([]);
      expect(notifications).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
});
