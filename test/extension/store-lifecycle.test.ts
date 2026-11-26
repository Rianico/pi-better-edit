/**
 * #357 — the store's session lifecycle, driven end to end through the REAL entry point.
 *
 * Each case is an ACCEPTANCE test: it registers the extension as the host does (`register(pi)` from
 * `index.ts`), emits the lifecycle events the host emits, and asserts on the cache's own truth
 * (`__isStoreOpen`) and on the files the store leaves behind. Unit bookkeeping lives in
 * `test/core/store-lifecycle.test.ts`; what matters here is that the composition root claims the
 * store BEFORE the handler that opens it, and that `session_shutdown` runs the janitor pass and
 * then detaches. The `pi` double accumulates handlers per event and re-raises what they threw,
 * because the host pushes onto a list: a last-write-wins map would let one handler shadow another.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import register from "../../index";
import {
  hashStorePath,
  shutdownHashStore,
  storeLifecycleSlot,
  __isStoreOpen,
} from "../../src/hash-store";
import { releaseHashStore } from "../../src/store-lifecycle";
import type { RRState } from "../../src/edit-render";
import { PREVIEW_DEBOUNCE_MS } from "../../src/preview-controller";
import { anchorRows, extractHash, getText, getWritableTempRoot } from "../support/fixtures";
interface TestCtx {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
}

interface ServedResult {
  readonly content: Array<{ type: string; text?: string }>;
  readonly isError?: boolean;
  readonly details?: unknown;
}

interface ToolHandle {
  readonly name: string;
  execute(
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: TestCtx,
  ): Promise<ServedResult>;
  /** The tool's own call-preview renderer, when it registers one. */
  renderCall?(args: unknown, theme: unknown, context: unknown): unknown;
}

/** One registered lifecycle handler, as the host stores it. */
type LifecycleHandler = (...args: unknown[]) => unknown;

interface LifecyclePi {
  readonly pi: Parameters<typeof register>[0];
  readonly tools: Map<string, ToolHandle>;
  /** Every handler per event, in registration order — the order the claim is asserted against. */
  readonly handlers: Map<string, LifecycleHandler[]>;
  emit(event: string, ...args: unknown[]): Promise<void>;
}

/**
 * The `session_start` handlers the entry point registers, in order: read prefetch, edit capture, the
 * session's store CLAIM, the lifecycle hooks that then OPEN the store, and the janitor pass. The
 * count pins the composition; the index pins the claim BEFORE the opener, which is the property.
 */
const SESSION_START_HANDLERS = 5;
const CLAIM_INDEX = 2;

function makeLifecyclePi(): LifecyclePi {
  const handlers = new Map<string, LifecycleHandler[]>();
  const tools = new Map<string, ToolHandle>();
  let activeTools: string[] = [];
  const pi = {
    registerTool(tool: ToolHandle) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: LifecycleHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) {
      activeTools = names;
    },
  };
  const emit = async (event: string, ...args: unknown[]): Promise<void> => {
    const registered = handlers.get(event) ?? [];
    if (registered.length === 0) throw new Error(`no handler registered for "${event}"`);
    const failures: unknown[] = [];
    for (const handler of registered) {
      try {
        await handler(...args);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `handlers for "${event}" threw`);
  };
  return { pi: pi as unknown as Parameters<typeof register>[0], tools, handlers, emit };
}

/** A tool the entry point registered. A missing one is a wiring failure, named. */
function toolFor(running: LifecyclePi, name: string): ToolHandle {
  const tool = running.tools.get(name);
  if (tool === undefined) throw new Error(`the entry point did not register "${name}"`);
  return tool;
}

/**
 * One temp root per case, published as the store's config dir AND used as the session cwd, so the
 * store's file, its `-wal`, and the files a tool touches are all before the reader. The teardown
 * covers the host paths that skip `session_shutdown`: force the release, then shut down.
 */
async function withSessionDir(
  prefix: string,
  run: (dir: string, ctx: TestCtx) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(dir, { cwd: dir, sessionManager: { getSessionId: () => "s1" } });
  } finally {
    await releaseHashStore({ force: true });
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("store lifecycle through the entry point", () => {
  it("closes the store on session_shutdown and leaves no WAL behind", async () => {
    await withSessionDir("pi-session-close-", async (dir, ctx) => {
      await writeFile(join(dir, "sample.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      const running = makeLifecyclePi();
      register(running.pi);

      await running.emit("session_start", { reason: "startup" }, ctx);
      const served = await toolFor(running, "read").execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(anchorRows(getText(served))).toHaveLength(3);
      expect(__isStoreOpen()).toBe(true);

      await running.emit("session_shutdown", { reason: "quit" }, ctx);

      expect(__isStoreOpen()).toBe(false);
      const walPath = `${hashStorePath()}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      expect(walBytes).toBe(0);
    });
  });

  it("claims the store before the handler that opens it, and the claim alone opens nothing", async () => {
    await withSessionDir("pi-session-claim-", async (_dir, ctx) => {
      const running = makeLifecyclePi();
      register(running.pi);

      const startHandlers = running.handlers.get("session_start") ?? [];
      expect(startHandlers).toHaveLength(SESSION_START_HANDLERS);

      const claim = startHandlers[CLAIM_INDEX];
      if (claim === undefined) throw new Error("the entry point did not register the store claim");
      await claim({ reason: "startup" }, ctx);
      expect(storeLifecycleSlot.ownerCount).toBe(1);
      expect(__isStoreOpen()).toBe(false);

      for (const [index, handler] of startHandlers.entries()) {
        if (index !== CLAIM_INDEX) await handler({ reason: "startup" }, ctx);
      }
      expect(__isStoreOpen()).toBe(true);
      expect(storeLifecycleSlot.ownerCount).toBe(1);

      await running.emit("session_shutdown", { reason: "quit" }, ctx);
      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("keeps the handle open until the last of two activations leaves", async () => {
    await withSessionDir("pi-session-two-", async (dir, ctx) => {
      await writeFile(join(dir, "first.ts"), "first\n", "utf-8");
      await writeFile(join(dir, "second.ts"), "second\n", "utf-8");
      const first = makeLifecyclePi();
      const second = makeLifecyclePi();
      register(first.pi);
      register(second.pi);

      await first.emit("session_start", { reason: "startup" }, ctx);
      await second.emit("session_start", { reason: "startup" }, ctx);
      await toolFor(first, "read").execute("r1", { file: "first.ts" }, undefined, undefined, ctx);
      await toolFor(second, "read").execute("r1", { file: "second.ts" }, undefined, undefined, ctx);
      expect(storeLifecycleSlot.ownerCount).toBe(2);

      await first.emit("session_shutdown", { reason: "quit" }, ctx);
      expect(storeLifecycleSlot.ownerCount).toBe(1);
      expect(__isStoreOpen()).toBe(true);

      await second.emit("session_shutdown", { reason: "quit" }, ctx);
      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("drains an in-flight read instead of closing the handle under it", async () => {
    await withSessionDir("pi-session-drain-", async (dir, ctx) => {
      await writeFile(join(dir, "inflight.ts"), "delta\nepsilon\n", "utf-8");
      const running = makeLifecyclePi();
      register(running.pi);
      await running.emit("session_start", { reason: "startup" }, ctx);

      const reading = toolFor(running, "read").execute(
        "r1",
        { file: "inflight.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(storeLifecycleSlot.inFlightCount).toBeGreaterThanOrEqual(1);

      const shutdown = running.emit("session_shutdown", { reason: "quit" }, ctx);

      const served = await reading;
      expect(getText(served)).toContain("│delta");
      expect(getText(served)).not.toContain("database is not open");
      await shutdown;

      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("keeps served leases and the undo entry across a reload", async () => {
    await withSessionDir("pi-session-reload-", async (dir, ctx) => {
      const file = join(dir, "reload.ts");
      const original = "one\ntwo\nthree\n";
      await writeFile(file, original, "utf-8");
      const running = makeLifecyclePi();
      register(running.pi);

      await running.emit("session_start", { reason: "startup" }, ctx);
      const served = await toolFor(running, "read").execute(
        "r1",
        { file: "reload.ts" },
        undefined,
        undefined,
        ctx,
      );
      const secondLine = extractHash(anchorRows(getText(served))[1]!);

      await running.emit("session_shutdown", { reason: "reload" }, ctx);
      expect(__isStoreOpen()).toBe(false);
      await running.emit("session_start", { reason: "reload" }, ctx);

      const edited = await toolFor(running, "edit").execute(
        "e1",
        {
          file: "reload.ts",
          edits: [{ anchor_from: secondLine, anchor_to: secondLine, text: "two edited" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(edited.isError).toBeUndefined();
      expect(await readFile(file, "utf-8")).toBe("one\ntwo edited\nthree\n");

      await running.emit("session_shutdown", { reason: "reload" }, ctx);
      await running.emit("session_start", { reason: "reload" }, ctx);

      const undone = await toolFor(running, "undo_last_edit").execute(
        "u1",
        { path: "reload.ts" },
        undefined,
        undefined,
        ctx,
      );
      expect(undone.isError).toBeUndefined();
      expect(await readFile(file, "utf-8")).toBe(original);
    });
  });

  it("never creates the store for a session that never used it", async () => {
    await withSessionDir("pi-session-cold-", async (_dir, ctx) => {
      const running = makeLifecyclePi();
      register(running.pi);
      expect(existsSync(hashStorePath())).toBe(false);

      await running.emit("session_shutdown", { reason: "quit" }, ctx);

      expect(__isStoreOpen()).toBe(false);
      expect(existsSync(hashStorePath())).toBe(false);
    });
  });

  it("cancels an armed preview on session_shutdown so nothing reopens the store", async () => {
    await withSessionDir("pi-session-preview-", async (dir, ctx) => {
      await writeFile(join(dir, "sample.ts"), "alpha\nbeta\ngamma\n", "utf-8");
      const running = makeLifecyclePi();
      register(running.pi);
      await running.emit("session_start", { reason: "startup" }, ctx);
      const served = await toolFor(running, "read").execute(
        "r1",
        { file: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const anchor = extractHash(anchorRows(getText(served))[0]!);
      const editTool = toolFor(running, "edit");
      const renderCall = editTool.renderCall;
      if (renderCall === undefined) throw new Error('the entry point exposed no "edit" renderCall');

      const state: RRState = {};
      renderCall(
        {
          file: "sample.ts",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "alpha edited" }],
        },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {
          cwd: dir,
          executionStarted: false,
          argsComplete: true,
          state,
          expanded: false,
          lastComponent: undefined,
          invalidate: () => {},
        },
      );
      expect(state.previewTimer).toBeDefined();
      expect(__isStoreOpen()).toBe(true);

      await running.emit("session_shutdown", { reason: "quit" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_DEBOUNCE_MS + 100));

      expect(__isStoreOpen()).toBe(false);
      expect(storeLifecycleSlot.ownerCount).toBe(0);
    });
  });
});
