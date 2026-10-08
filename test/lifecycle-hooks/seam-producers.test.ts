import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServedRow } from "../../src/domain-errors.js";
import type { EditDetails } from "../../src/edit-response.js";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";
import {
  addMutatedFileObserver,
  clearMutatedFileObserversForTests,
  type MutatedFileNotification,
} from "../../src/mutated-files.js";
import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  type ServedSpan,
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

type SeamEvent =
  | {
      seam: "mutated";
      filePath: string;
      kind: "edit" | "write";
      ranges: ServedSpan[];
      sourceTool: string;
    }
  | { seam: "served"; filePath: string; spans: ServedSpan[]; source: string; content?: string };

const timeline: SeamEvent[] = [];

type Harness = ReturnType<typeof setupIntegrationTest>;
type Hooks = ReturnType<typeof createLifecycleHooks>;

function recordMutation(notification: MutatedFileNotification): void {
  timeline.push({
    seam: "mutated",
    filePath: notification.filePath,
    kind: notification.kind,
    ranges: notification.ranges,
    sourceTool: notification.sourceTool,
  });
}

function recordServed(notification: ServedSpanNotification): void {
  timeline.push({
    seam: "served",
    filePath: notification.filePath,
    spans: notification.spans,
    source: notification.source,
    ...(notification.content !== undefined ? { content: notification.content } : {}),
  });
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
    // WHY: adapter, so clearing first leaves exactly the two probes this file asserts on.
    clearMutatedFileObserversForTests();
    clearServedSpanObserversForTests();
    timeline.length = 0;
    addMutatedFileObserver(recordMutation);
    addServedSpanObserver(recordServed);
    const hooks = createLifecycleHooks();
    try {
      await run(harness, dir, hooks);
    } finally {
      clearMutatedFileObserversForTests();
      clearServedSpanObserversForTests();
    }
  });
}

afterEach(() => {
  timeline.length = 0;
});

describe("lifecycle seam producers", () => {
  it("notifies the mutation before the auto-read serve, carrying the written bytes", async () => {
    await withHarness("pbe-seam-write-", async (harness, dir, hooks) => {
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

      expect(timeline).toEqual([
        { seam: "mutated", filePath: path, kind: "write", ranges: [], sourceTool: "write" },
        {
          seam: "served",
          filePath: path,
          spans: [{ startLine: 1, lineCount: 2 }],
          source: "auto-read",
          content: "one\ntwo\n",
        },
      ]);
    });
  });

  it("notifies the mutation before the diff serve, which carries no bytes", async () => {
    await withHarness("pbe-seam-edit-", async (harness, dir, hooks) => {
      const path = join(dir, "p.txt");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { file: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      const result = (await harness.editTool.execute(
        "e1",
        {
          file: "p.txt",
          edits: [{ anchor_from: ref("beta"), anchor_to: ref("beta"), text: "BETA" }],
        },
        undefined,
        undefined,
        harness.ctx,
      )) as { details: EditDetails };
      timeline.length = 0;

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

      expect(timeline).toEqual([
        {
          seam: "mutated",
          filePath: path,
          kind: "edit",
          ranges: [{ startLine: 2, lineCount: 1 }],
          sourceTool: "edit",
        },
        {
          seam: "served",
          filePath: path,
          spans: [{ startLine: 1, lineCount: 3 }],
          source: "diff",
        },
      ]);
      expect("content" in timeline[1]!).toBe(false);
    });
  });

  it("labels a restored undo as its own source and still leads with the mutation", async () => {
    await withHarness("pbe-seam-undo-", async (harness, dir, hooks) => {
      const path = join(dir, "p.txt");
      await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { file: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      await harness.editTool.execute(
        "e1",
        {
          file: "p.txt",
          edits: [{ anchor_from: ref("beta"), anchor_to: ref("beta"), text: "BETA" }],
        },
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
      timeline.length = 0;

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

      expect(timeline.map((event) => event.seam)).toEqual(["mutated", "served"]);
      expect(timeline[0]).toEqual({
        seam: "mutated",
        filePath: path,
        kind: "edit",
        ranges: [{ startLine: 2, lineCount: 1 }],
        sourceTool: "undo_last_edit",
      });
    });
  });

  it("emits a served notification with no bytes for a reject-and-serve refusal, and no mutation", async () => {
    await withHarness("pbe-seam-reject-", async (harness, dir, _hooks) => {
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
      timeline.length = 0;

      const rejection = await harness.editTool
        .execute(
          "e1",
          {
            file: "p.txt",
            edits: [{ anchor_from: ref("alpha"), anchor_to: ref("delta"), text: "X" }],
          },
          undefined,
          undefined,
          harness.ctx,
        )
        .catch((error: unknown) => error);
      expect((rejection as { code?: unknown }).code).toBe("E_STALE_RANGE");
      expect(((rejection as { servedRows?: ServedRow[] }).servedRows ?? []).length).toBeGreaterThan(
        0,
      );

      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({
        seam: "served",
        filePath: join(dir, "p.txt"),
        source: "reject-and-serve",
      });
      expect("content" in timeline[0]!).toBe(false);
    });
  });

  it("emits nothing for a noop edit", async () => {
    await withHarness("pbe-seam-noop-", async (harness, dir, hooks) => {
      await writeFile(join(dir, "p.txt"), "alpha\nbeta\ngamma\n", "utf-8");
      const read = await harness.readTool.execute(
        "r1",
        { file: "p.txt" },
        undefined,
        undefined,
        harness.ctx,
      );
      const ref = refsOf(getText(read));
      const outcome = (await harness.editTool
        .execute(
          "e1",
          {
            file: "p.txt",
            edits: [{ anchor_from: ref("beta"), anchor_to: ref("beta"), text: "beta" }],
          },
          undefined,
          undefined,
          harness.ctx,
        )
        .catch((error: unknown) => error)) as { details?: EditDetails };
      expect(outcome.details?.metrics?.classification).toBe("noop");
      timeline.length = 0;

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

      expect(timeline).toEqual([]);
    });
  });
});
