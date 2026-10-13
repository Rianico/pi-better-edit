/**
 * `/pi-better-edit settings` (and bare) — headed overlay vs headless status.
 * Mirrors `test/integrations/pi-lens/command.test.ts`: temp HOME/project
 * isolation, notify capture, file-content save proofs, never-rejects handler.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { BASH_VIEW_ENV_VAR } from "../../../src/bash-view-config.js";
import { registerLensCommand } from "../../../src/integrations/pi-lens/command.js";
import { LENS_BRIDGE_ENV_VAR } from "../../../src/integrations/pi-lens/config.js";
import { SettingsOverlay } from "../../../src/integrations/pi-lens/settings-overlay.js";
import { CONFIG_REL } from "../../../src/json-config.js";
import { STORE_JANITOR_ENV_VAR } from "../../../src/store-config.js";

interface CommandOptions {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string }> | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;

const projectConfigPath = (): string => join(projectDir, CONFIG_REL);
const globalConfigPath = (): string => join(homeDir, CONFIG_REL);

function captureCommand(): { name: string; options: CommandOptions } {
  let name: string | undefined;
  let options: CommandOptions | undefined;
  const pi = {
    registerCommand(commandName: string, commandOptions: CommandOptions): void {
      name = commandName;
      options = commandOptions;
    },
  };
  registerLensCommand(pi as unknown as ExtensionAPI);
  if (name === undefined || options === undefined) throw new Error("command was not registered");
  return { name, options };
}

interface FakeUI {
  ctx: ExtensionCommandContext;
  notifications: string[];
  customOptions: unknown[];
  overlays: SettingsOverlay[];
  doneResults: unknown[];
}

function fakeCtx(config: { hasUI: boolean; cwd: string }): FakeUI {
  const notifications: string[] = [];
  const customOptions: unknown[] = [];
  const overlays: SettingsOverlay[] = [];
  const doneResults: unknown[] = [];
  const ctx = {
    hasUI: config.hasUI,
    mode: "tui",
    cwd: config.cwd,
    ui: {
      notify: (message: string): void => {
        notifications.push(message);
      },
      select: async (): Promise<string | undefined> => undefined,
      custom: async (
        factory: (...args: never[]) => SettingsOverlay,
        options?: unknown,
      ): Promise<undefined> => {
        customOptions.push(options);
        const done = (result: undefined): void => {
          doneResults.push(result);
        };
        const overlay = await factory({} as never, {} as never, {} as never, done as never);
        overlays.push(overlay);
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, customOptions, overlays, doneResults };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-settings-command-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  delete process.env[BASH_VIEW_ENV_VAR];
  delete process.env[STORE_JANITOR_ENV_VAR];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  delete process.env[BASH_VIEW_ENV_VAR];
  delete process.env[STORE_JANITOR_ENV_VAR];
  await rm(root, { recursive: true, force: true });
});

describe("settings overlay routing", () => {
  it("opens the overlay on a bare invocation when a UI is present", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("", fake.ctx)).resolves.toBeUndefined();

    expect(fake.customOptions).toEqual([{ overlay: true, overlayOptions: { width: 68 } }]);
    expect(fake.notifications).toEqual([]);
    expect(fake.overlays).toHaveLength(1);
  });

  it("opens the overlay on the settings token when a UI is present", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("settings", fake.ctx)).resolves.toBeUndefined();

    expect(fake.customOptions).toEqual([{ overlay: true, overlayOptions: { width: 68 } }]);
    expect(fake.overlays).toHaveLength(1);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");
    overlay.selectItem("lens");
    expect(overlay.render(68).join("\n")).toContain("Effective:");
    overlay.handleInput("\x1b");
    expect(fake.doneResults).toEqual([undefined]);
  });

  it("falls back to the unchanged combined status text on a headless host", async () => {
    const { options } = captureCommand();
    const bare = fakeCtx({ hasUI: false, cwd: projectDir });
    const named = fakeCtx({ hasUI: false, cwd: projectDir });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(options.handler("", bare.ctx)).resolves.toBeUndefined();
    await expect(options.handler("settings", named.ctx)).resolves.toBeUndefined();

    expect(bare.customOptions).toEqual([]);
    expect(named.customOptions).toEqual([]);
    expect(bare.notifications).toEqual([]);
    expect(named.notifications).toEqual([]);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("pi-better-edit lens bridge");
    expect(text).toContain("effective: auto");
    expect(text).toContain("pi-better-edit bash view");
    expect(text).toContain("pi-better-edit store");
  });

  it("leaves the lens, bash-view and bash routes untouched", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("lens status", fake.ctx)).resolves.toBeUndefined();
    expect(fake.customOptions).toEqual([]);
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]).toContain("lens bridge");

    fake.notifications.length = 0;
    await expect(options.handler("bash-view status", fake.ctx)).resolves.toBeUndefined();
    expect(fake.customOptions).toEqual([]);
    expect(fake.notifications[0]).toContain("bash view");

    fake.notifications.length = 0;
    await expect(options.handler("bash status", fake.ctx)).resolves.toBeUndefined();
    expect(fake.customOptions).toEqual([]);
    expect(fake.notifications[0]).toContain("bash view");
  });

  it("completes the settings token with the same prefix filter", () => {
    const { options } = captureCommand();
    expect(options.getArgumentCompletions?.("settings")).toEqual([
      { label: "settings", value: "settings" },
    ]);
    expect(options.getArgumentCompletions?.("s")).toEqual([
      { label: "settings", value: "settings" },
    ]);
    expect(options.getArgumentCompletions?.("")?.map((item) => item.label)).toContain("settings");
  });

  it("reports an overlay failure instead of rejecting out of the handler", async () => {
    const { options } = captureCommand();
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: projectDir,
      ui: {
        notify: (message: string): void => {
          notifications.push(message);
        },
        custom: async (): Promise<undefined> => {
          throw new Error("overlay unavailable");
        },
      },
    } as unknown as ExtensionCommandContext;

    await expect(options.handler("settings", ctx)).resolves.toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("pi-better-edit:");
  });
});

describe("settings overlay wiring", () => {
  it("saves the lens value to the project scope on change", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });
    await options.handler("settings", fake.ctx);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");

    overlay.selectItem("lens");
    overlay.handleInput(" ");

    expect(readJson(projectConfigPath())).toMatchObject({ lens: { bridge: "on" } });
    expect(existsSync(globalConfigPath())).toBe(false);
  });

  it("saves later changes to the global scope after the Target Scope switch", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });
    await options.handler("settings", fake.ctx);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");

    overlay.selectItem("target-scope");
    overlay.handleInput(" ");
    expect(overlay.currentScope()).toBe("global");

    overlay.selectItem("bash-view");
    overlay.handleInput(" ");

    expect(readJson(globalConfigPath())).toMatchObject({ bash: { view: "off" } });
    expect(existsSync(projectConfigPath())).toBe(false);
  });

  it("saves the store janitor mode object to the active scope on change", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });
    await options.handler("settings", fake.ctx);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");

    overlay.selectItem("store");
    overlay.handleInput(" ");

    expect(readJson(projectConfigPath())).toMatchObject({ store: { janitor: "off" } });
  });

  it("persists nothing when the Target Scope row itself changes", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });
    await options.handler("settings", fake.ctx);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");

    overlay.selectItem("target-scope");
    overlay.handleInput(" ");

    expect(existsSync(projectConfigPath())).toBe(false);
    expect(existsSync(globalConfigPath())).toBe(false);
  });

  it("refreshes the scope row value and description on switch", async () => {
    const { options } = captureCommand();
    const fake = fakeCtx({ hasUI: true, cwd: projectDir });
    await options.handler("settings", fake.ctx);
    const overlay = fake.overlays[0];
    if (overlay === undefined) throw new Error("overlay was not created");

    overlay.selectItem("target-scope");
    overlay.handleInput(" ");

    overlay.selectItem("target-scope");
    const out = overlay.render(68).join("\n").replace(/\s+/g, " ");
    expect(out).toContain("Effective: global (source: switch)");
  });

  it("keeps the env-effective display after a save while the env override wins", async () => {
    const saved = process.env[LENS_BRIDGE_ENV_VAR];
    process.env[LENS_BRIDGE_ENV_VAR] = "off";
    try {
      const { options } = captureCommand();
      const fake = fakeCtx({ hasUI: true, cwd: projectDir });
      await options.handler("settings", fake.ctx);
      const overlay = fake.overlays[0];
      if (overlay === undefined) throw new Error("overlay was not created");

      overlay.selectItem("lens");
      overlay.handleInput(" ");

      expect(readJson(projectConfigPath())).toMatchObject({ lens: { bridge: "auto" } });
      overlay.selectItem("lens");
      const out = overlay.render(68).join("\n").replace(/\s+/g, " ");
      expect(out).toContain("Effective: off (source: env)");
    } finally {
      if (saved === undefined) delete process.env[LENS_BRIDGE_ENV_VAR];
      else process.env[LENS_BRIDGE_ENV_VAR] = saved;
    }
  });
});
