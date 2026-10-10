import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { registerLensCommand } from "../../../src/integrations/pi-lens/command.js";
import {
  LENS_BRIDGE_ENV_VAR,
  LENS_CONFIG_REL,
  LENS_SCHEMA_ID,
} from "../../../src/integrations/pi-lens/config.js";

const BRIDGE_KEY = Symbol.for("pi-lens:io-bridge");
const SETTLED_CHOICES = [
  "Auto (Project)",
  "Auto (Global)",
  "On (Project)",
  "On (Global)",
  "Off (Project)",
  "Off (Global)",
  "Status",
];

type FakeMode = "tui" | "rpc" | "json" | "print";

interface CommandOptions {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string }> | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;
let previousBridge: unknown;

const projectConfigPath = (): string => join(projectDir, LENS_CONFIG_REL);
const globalConfigPath = (): string => join(homeDir, LENS_CONFIG_REL);

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

function fakeCtx(config: { hasUI: boolean; cwd: string; select?: string; mode?: FakeMode }): {
  ctx: ExtensionCommandContext;
  notifications: string[];
  selectCalls: Array<{ title: string; options: string[] }>;
} {
  const notifications: string[] = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const ctx = {
    hasUI: config.hasUI,
    mode: config.mode ?? "tui",
    cwd: config.cwd,
    ui: {
      notify: (message: string): void => {
        notifications.push(message);
      },
      select: async (title: string, options: string[]): Promise<string | undefined> => {
        selectCalls.push({ title, options });
        return config.select;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, selectCalls };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function installBridge(): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = {
    version: 2,
    record: (): void => undefined,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-lens-command-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  previousBridge = (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousBridge === undefined) delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  else (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = previousBridge;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  await rm(root, { recursive: true, force: true });
});

describe("registerLensCommand", () => {
  it("registers the settled command name, description and prefix-filtered completions", () => {
    const { name, options } = captureCommand();
    expect(name).toBe("pi-better-edit");
    expect(options.description).toBe(
      "Configure pi-better-edit. Usage: /pi-better-edit lens [auto|on|off|status] [project|global]",
    );
    expect(options.getArgumentCompletions?.("lens a")).toEqual([
      { label: "lens auto", value: "lens auto" },
    ]);
    expect(options.getArgumentCompletions?.("")?.map((item) => item.label)).toEqual([
      "lens",
      "lens auto",
      "lens on",
      "lens off",
      "lens status",
    ]);
    expect(options.getArgumentCompletions?.("lens z")).toEqual([]);
  });

  it("answers status with effective mode, bridge detection and both scopes, never prompting", async () => {
    const { options } = captureCommand();
    const { ctx, notifications, selectCalls } = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("lens status", ctx)).resolves.toBeUndefined();

    expect(selectCalls).toEqual([]);
    expect(notifications).toHaveLength(1);
    const text = notifications[0] ?? "";
    expect(text).toContain("effective: auto");
    expect(text).toContain("io bridge detected: no");
    expect(text).toContain(`project (${LENS_CONFIG_REL}): unset`);
    expect(text).toContain(`global (~/${LENS_CONFIG_REL}): unset`);
    expect(text).toContain(`env ${LENS_BRIDGE_ENV_VAR}: unset`);
    expect(text).toContain("precedence: env > project > global > auto");

    installBridge();
    await mkdir(join(homeDir, ".pi", "agents"), { recursive: true });
    await writeFile(globalConfigPath(), JSON.stringify({ lens: { bridge: "off" } }), "utf-8");
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    notifications.length = 0;

    await options.handler("lens status", ctx);

    expect(selectCalls).toEqual([]);
    const next = notifications[0] ?? "";
    expect(next).toContain("effective: on");
    expect(next).toContain("io bridge detected: yes");
    expect(next).toContain(`global (~/${LENS_CONFIG_REL}): off`);
    expect(next).toContain(`env ${LENS_BRIDGE_ENV_VAR}: on`);
  });

  it("writes a mode non-interactively without ever prompting", async () => {
    const { options } = captureCommand();
    const { ctx, notifications, selectCalls } = fakeCtx({ hasUI: true, cwd: projectDir });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await options.handler("lens on global", ctx);

    expect(selectCalls).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("set to on (global)");
    expect(notifications[0]).toContain(globalConfigPath());
    expect(readJson(globalConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "on" },
    });
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("writes the picked mode and scope through the single-step dialog", async () => {
    const { options } = captureCommand();
    const picked = fakeCtx({ hasUI: true, cwd: projectDir, select: "Off (Project)" });

    await expect(options.handler("lens", picked.ctx)).resolves.toBeUndefined();

    expect(picked.selectCalls).toEqual([
      { title: "pi-better-edit lens bridge", options: SETTLED_CHOICES },
    ]);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "off" },
    });
    expect(picked.notifications).toHaveLength(1);
    expect(picked.notifications[0]).toContain("set to off (project)");
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("shows status from the dialog's Status choice without writing", async () => {
    const { options } = captureCommand();
    const status = fakeCtx({ hasUI: true, cwd: projectDir, select: "Status" });

    await options.handler("lens", status.ctx);

    expect(status.notifications[0]).toContain("effective: auto");
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("treats Esc as a cancel: no write and no confirmation", async () => {
    const { options } = captureCommand();
    const cancelled = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("lens", cancelled.ctx);

    expect(cancelled.selectCalls).toHaveLength(1);
    expect(cancelled.notifications).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("falls back to status text on a headless host without calling select", async () => {
    const { options } = captureCommand();
    const headless = fakeCtx({ hasUI: false, cwd: projectDir, mode: "print" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await options.handler("lens", headless.ctx);

    expect(headless.selectCalls).toEqual([]);
    expect(headless.notifications).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toContain("effective: auto");
  });

  it("answers malformed input with usage and writes nothing", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("nope", ctx);
    expect(notifications[0]).toContain(
      "Usage: /pi-better-edit lens [auto|on|off|status] [project|global]",
    );

    await options.handler("lens bogus", ctx);
    expect(notifications[1]).toContain('Unknown option "bogus"');

    await options.handler("lens auto mars", ctx);
    expect(notifications[2]).toContain('Unknown scope "mars"');

    await options.handler("lens auto project extra", ctx);
    expect(notifications[3]).toContain("Too many arguments");

    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("reports a write failure instead of rejecting out of the handler", async () => {
    const { options } = captureCommand();
    const blocked = join(root, "blocked");
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, ".pi"), "not a directory", "utf-8");
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: blocked });

    await expect(options.handler("lens on", ctx)).resolves.toBeUndefined();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("pi-better-edit:");
  });
});
