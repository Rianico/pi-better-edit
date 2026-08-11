import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config";
import {
  loadHashStore,
  upsertServed,
  getServed,
  upsertSnapshot,
  getSnapshot,
} from "../../src/hash-store";
import { contentChecksum } from "../../src/hashline/hasher";
import { withTempDir } from "../support/fixtures";

function makeLifecyclePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const notify = vi.fn();
  let activeTools: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown }) {
      commands.set(name, def);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as any;
  return { pi, handlers, commands, notify, getActiveTools: () => activeTools };
}

async function registerExtension(pi: any) {
  const { default: register } = await import("../../index");
  register(pi);
}

describe("session_start lifecycle", () => {
  it("removes the built-in edit tool from active tools", async () => {
    await withTempDir("lifecycle-tools-", async (dir) => {
      const { pi, handlers } = makeLifecyclePi();
      pi.setActiveTools(["read", "replace", "edit", "bash"]);
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart!({}, { cwd: dir, ui: { notify: vi.fn() } });
      expect(pi.getActiveTools()).toEqual(["read", "replace", "bash"]);
    });
  });

  it("notifies when PI_HASHLINE_DEBUG is enabled", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "1");
    try {
      await withTempDir("lifecycle-debug-", async (dir) => {
        const { pi, handlers, notify } = makeLifecyclePi();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
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
        const { pi, handlers, notify } = makeLifecyclePi();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify } });
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads auto-read preference from config", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-config-", async (dir) => {
        const { mkdir, writeFile } = await import("fs/promises");
        const { join } = await import("path");
        await mkdir(join(dir, ".config", "pi-hashline-edit-pro"), { recursive: true });
        await writeFile(
          join(dir, ".config", "pi-hashline-edit-pro", "config.json"),
          JSON.stringify({ autoRead: false }),
          "utf-8",
        );
        const { pi, handlers } = makeLifecyclePi();
        await registerExtension(pi);
        const sessionStart = handlers.get("session_start")!;
        await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });
        expect((await readConfig()).autoRead).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("wipes served state at session start", async () => {
    await withTempDir("lifecycle-served-", async (dir) => {
      const { writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const keep = join(dir, "keep.ts");
      await writeFile(keep, "keep\n", "utf-8");

      const store = await loadHashStore();
      upsertServed(store, keep, [{ position: 0, hash: "abc" }]);
      upsertSnapshot(store, keep, contentChecksum("keep\n"), 1, ["abc"]);

      const { pi, handlers } = makeLifecyclePi();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify: vi.fn() } });

      expect(getServed(store, keep)).toEqual([]);
      expect(getSnapshot(store, keep, "keep\n")).toEqual(["abc"]);
    });
  });
});

describe("toggle-auto-read command", () => {
  it("toggles the persisted config and notifies", async () => {
    await withTempDir("lifecycle-toggle-", async (dir) => {
      const { pi, handlers, commands, notify } = makeLifecyclePi();
      await registerExtension(pi);
      const sessionStart = handlers.get("session_start")!;
      await sessionStart({}, { cwd: dir, ui: { notify } });

      const command = commands.get("toggle-auto-read");
      expect(command).toBeDefined();
      await command!.handler([], { cwd: dir, ui: { notify } });
      expect((await readConfig()).autoRead).toBe(false);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
        "info",
      );

      await command!.handler([], { cwd: dir, ui: { notify } });
      expect((await readConfig()).autoRead).toBe(true);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("enabled"),
        "info",
      );
    });
  });
});
