import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { upsertServed, getServed } from "../../src/served-session/index.js";
import { upsertSnapshot, getSnapshot, snapshotHashFor } from "../../src/snapshot-store";
import { withTempDir } from "../support/fixtures";

/**
 * The per-event LIST is load-bearing: the extension API ACCUMULATES registrations. `loader.js`
 * implements `on(event, handler)` as push-onto-list and `runner.js` dispatches by looping it, so
 * a second `pi.on("session_start", …)` ADDS rather than replaces. The entry point registers
 * THREE `session_start` handlers — #165's capture, the lifecycle hook, and (since #90) the store
 * janitor — so a last-write-wins `Map` let the janitor shadow the handler under test and the
 * notify assertion read zero calls against a host that calls every handler.
 *
 * The `emit` double is STRICTER than the host for an unsubscribed event (the host returns) and
 * for a handler throw (collected, re-raised after the loop); it is LAXER for `result.cancel` on
 * BEFORE-events and for cross-extension ordering, safe only while no case asserts either.
 */
function makeLifecyclePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const notify = vi.fn();
  let activeTools: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown }) {
      commands.set(name, def);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as any;
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
  return { pi, handlers, commands, notify, getActiveTools: () => activeTools, emit };
}

/**
 * The POSITIVE CONTROL for the cases below whose subject is an ABSENCE. `notify` never called,
 * the active tool set unchanged and served state intact are all satisfied by a hook that never
 * runs, so each of those cases first PROVES the session-start work executed. Measured: with the
 * lifecycle hook's `session_start` registration removed from the entry point, the file reported
 * `1 failed | 3 passed` — only the debug case, whose assertion is positive, noticed.
 *
 * The observable is `deps.pruneMissingAll`, the one effect `onSessionStart` has besides the debug
 * notify: no other `session_start` subscriber drops a missing-file snapshot, so the seeded
 * snapshot's disappearance is caused by the hook under test. The seed is asserted PRESENT first,
 * because a disappearance only evidences work if there was something to disappear.
 */
interface SessionStartControl {
  readonly store: HashStore;
  readonly path: string;
  readonly content: string;
}

async function armSessionStartControl(dir: string): Promise<SessionStartControl> {
  const store = await loadHashStore();
  const path = join(dir, "stale-never-written.ts");
  const content = "stale\n";
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: 1,
    hashes: ["abcc"],
    content,
  });
  expect(getSnapshot(store, path, content)).toEqual(["abcc"]);
  return { store, path, content };
}

/** The control itself: the hook under test ran iff it pruned the armed snapshot. */
function expectSessionStartWorkRan(control: SessionStartControl): void {
  expect(getSnapshot(control.store, control.path, control.content)).toBeUndefined();
}

async function registerExtension(pi: any) {
  const { default: register } = await import("../../index");
  register(pi);
}

describe("session_start lifecycle", () => {
  it("leaves the active tool set untouched (the extension owns the edit name)", async () => {
    await withTempDir("lifecycle-tools-", async (dir) => {
      const { pi, emit } = makeLifecyclePi();
      pi.setActiveTools(["read", "edit", "write", "bash"]);
      await registerExtension(pi);
      const control = await armSessionStartControl(dir);
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });
      expectSessionStartWorkRan(control);
      expect(pi.getActiveTools()).toEqual(["read", "edit", "write", "bash"]);
    });
  });

  it("notifies when PI_HASHLINE_DEBUG is enabled", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "1");
    try {
      await withTempDir("lifecycle-debug-", async (dir) => {
        const { pi, notify, emit } = makeLifecyclePi();
        await registerExtension(pi);
        await emit("session_start", {}, { cwd: dir, ui: { notify } });
        expect(notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stays silent without PI_HASHLINE_DEBUG", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-quiet-", async (dir) => {
        const { pi, notify, emit } = makeLifecyclePi();
        await registerExtension(pi);
        const control = await armSessionStartControl(dir);
        await emit("session_start", {}, { cwd: dir, ui: { notify } });
        expectSessionStartWorkRan(control);
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("registers the lens command through the host seam", async () => {
    const { pi, commands } = makeLifecyclePi();
    await registerExtension(pi);
    const registration = commands.get("pi-better-edit");
    expect(registration).toBeDefined();
    expect(typeof registration?.handler).toBe("function");
  });

  it("keeps served state at session start", async () => {
    await withTempDir("lifecycle-served-", async (dir) => {
      const { writeFile } = await import("fs/promises");
      const keep = join(dir, "keep.ts");
      await writeFile(keep, "keep\n", "utf-8");

      const store = await loadHashStore();
      upsertServed(store, "sessionA", keep, [{ position: 0, hash: "abcc" }]);
      upsertSnapshot(store, {
        path: keep,
        snapshotHash: snapshotHashFor("keep\n"),
        lineCount: 1,
        hashes: ["abcc"],
        content: "keep\n",
      });

      const { pi, emit } = makeLifecyclePi();
      await registerExtension(pi);
      const control = await armSessionStartControl(dir);
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });

      expectSessionStartWorkRan(control);
      expect(getServed(store, "sessionA", keep)).toEqual(["abcc"]);
      expect(getSnapshot(store, keep, "keep\n")).toEqual(["abcc"]);
    });
  });
});
