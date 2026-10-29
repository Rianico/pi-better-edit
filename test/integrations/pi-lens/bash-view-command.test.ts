/**
 * `/pi-better-edit bash-view` (alias `bash`) — the command surface for the bash view
 * interception switch. Mirrors `test/integrations/pi-lens/command.test.ts`: token parsing
 * (max 3 tokens, scope validation, status/interactive/mode branches), the `select`
 * picker (Esc is silence), headless combined status, and a handler that never rejects.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { registerLensCommand } from "../../../src/integrations/pi-lens/command.js";
import { BASH_VIEW_ENV_VAR, resolveBashViewMode } from "../../../src/bash-view-config.js";
import { CONFIG_REL, CONFIG_FILE_NAME } from "../../../src/json-config.js";
import { settingsRoot } from "../../../src/config-dir.js";

const SETTLED_BASH_VIEW_CHOICES = [
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

const projectConfigPath = (): string => join(projectDir, CONFIG_REL);
const globalConfigPath = (): string => join(settingsRoot(), CONFIG_FILE_NAME);

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-bash-view-command-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[BASH_VIEW_ENV_VAR];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[BASH_VIEW_ENV_VAR];
  await rm(globalConfigPath(), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe("bash-view command", () => {
  it("routes bash-view and the bash alias to the same handler", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("bash-view status", ctx)).resolves.toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("bash view");

    notifications.length = 0;
    await expect(options.handler("bash status", ctx)).resolves.toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("bash view");
  });

  it("completes bash-view forms and the bash alias with the same prefix filter", () => {
    const { options } = captureCommand();

    expect(options.getArgumentCompletions?.("bash-view ")).toEqual([
      { label: "bash-view", value: "bash-view" },
      { label: "bash-view on", value: "bash-view on" },
      { label: "bash-view off", value: "bash-view off" },
      { label: "bash-view status", value: "bash-view status" },
      // WHY: (ADR-0049 M6) the multi-file cap surface is part of the same prefix filter.
      { label: "bash-view multi-file", value: "bash-view multi-file" },
      { label: "bash-view multi-file status", value: "bash-view multi-file status" },
      { label: "bash-view multi-file max-files", value: "bash-view multi-file max-files" },
      { label: "bash-view multi-file max-rows", value: "bash-view multi-file max-rows" },
    ]);
    expect(options.getArgumentCompletions?.("bash o")).toEqual([
      { label: "bash on", value: "bash on" },
      { label: "bash off", value: "bash off" },
    ]);
    expect(options.getArgumentCompletions?.("bash-view z")).toEqual([]);
    expect(options.getArgumentCompletions?.("")?.map((item) => item.label)).toContain("bash-view");
    expect(options.getArgumentCompletions?.("")?.map((item) => item.label)).toContain("bash");
    expect(options.getArgumentCompletions?.("")?.map((item) => item.label)).toContain("lens");
  });

  it("answers status with effective mode, rung, both scopes and env, never prompting", async () => {
    const { options } = captureCommand();
    const { ctx, notifications, selectCalls } = fakeCtx({ hasUI: true, cwd: projectDir });

    await expect(options.handler("bash-view status", ctx)).resolves.toBeUndefined();

    expect(selectCalls).toEqual([]);
    expect(notifications).toHaveLength(1);
    const text = notifications[0] ?? "";
    expect(text).toContain("pi-better-edit bash view");
    expect(text).toContain("effective: on");
    expect(text).toContain("effective source: default");
    expect(text).toContain(`project (${CONFIG_REL}): unset`);
    expect(text).toContain(`global (${globalConfigPath()}): unset`);
    expect(text).toContain(`env ${BASH_VIEW_ENV_VAR}: unset`);
    expect(text).toContain("precedence: env > project > global > on");
  });

  it("labels the rung that won and the file values that lost", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });
    await mkdir(settingsRoot(), { recursive: true });
    await writeFile(globalConfigPath(), JSON.stringify({ bash: { view: "off" } }), "utf-8");
    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await writeFile(projectConfigPath(), JSON.stringify({ bash: { view: "on" } }), "utf-8");
    process.env[BASH_VIEW_ENV_VAR] = "off";

    await options.handler("bash-view status", ctx);

    const text = notifications[0] ?? "";
    expect(text).toContain("effective: off");
    expect(text).toContain("effective source: env");
    expect(text).toContain(`project (${CONFIG_REL}): on`);
    expect(text).toContain(`global (${globalConfigPath()}): off`);
    expect(text).toContain(`env ${BASH_VIEW_ENV_VAR}: off`);
  });

  it("writes a mode non-interactively without ever prompting", async () => {
    const { options } = captureCommand();
    const { ctx, notifications, selectCalls } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view off global", ctx);

    expect(selectCalls).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("set to off (global)");
    expect(notifications[0]).toContain(globalConfigPath());
    expect(readJson(globalConfigPath())).toEqual({
      $schema: expect.any(String),
      bash: { view: "off" },
    });
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(resolveBashViewMode(projectDir)).toBe("off");
  });

  it("writes the picked mode and scope through the single-step dialog", async () => {
    const { options } = captureCommand();
    const picked = fakeCtx({ hasUI: true, cwd: projectDir, select: "Off (Project)" });

    await expect(options.handler("bash-view", picked.ctx)).resolves.toBeUndefined();

    expect(picked.selectCalls).toEqual([
      { title: "pi-better-edit bash view", options: SETTLED_BASH_VIEW_CHOICES },
    ]);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: expect.any(String),
      bash: { view: "off" },
    });
    expect(picked.notifications).toHaveLength(1);
    expect(picked.notifications[0]).toContain("set to off (project)");
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("shows status from the dialog's Status choice without writing", async () => {
    const { options } = captureCommand();
    const status = fakeCtx({ hasUI: true, cwd: projectDir, select: "Status" });

    await options.handler("bash", status.ctx);

    expect(status.notifications[0]).toContain("effective: on");
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("treats Esc as a cancel: no write and no confirmation", async () => {
    const { options } = captureCommand();
    const cancelled = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view", cancelled.ctx);

    expect(cancelled.selectCalls).toHaveLength(1);
    expect(cancelled.notifications).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("falls back to combined status on a headless host without calling select", async () => {
    const { options } = captureCommand();
    const headless = fakeCtx({ hasUI: false, cwd: projectDir, mode: "print" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await options.handler("bash-view", headless.ctx);

    expect(headless.selectCalls).toEqual([]);
    expect(headless.notifications).toEqual([]);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("pi-better-edit bash view");
    expect(text).toContain("effective: on");
  });

  it("answers malformed input with usage and writes nothing", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view bogus", ctx);
    expect(notifications[0]).toContain('Unknown option "bogus"');

    await options.handler("bash-view on mars", ctx);
    expect(notifications[1]).toContain('Unknown scope "mars"');

    await options.handler("bash-view off project extra", ctx);
    expect(notifications[2]).toContain("Too many arguments");

    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("reports a write failure instead of rejecting out of the handler", async () => {
    const { options } = captureCommand();
    const blocked = join(root, "blocked");
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, ".pi"), "not a directory", "utf-8");
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: blocked });

    await expect(options.handler("bash-view off", ctx)).resolves.toBeUndefined();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("pi-better-edit:");
  });
});

// WHY (ADR-0049 M6): the caps are operator policy with a closed range, so the surface must show the
// effective value WITH its rung, accept a LOWERED value into either scope, and refuse anything outside
// the range without writing a byte — a silently dropped cap would read back as the default.
describe("bash-view multi-file command (ADR-0049 M6)", () => {
  it("prints both effective caps with their rungs and both file values, creating nothing", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view multi-file status", ctx);

    expect(notifications).toHaveLength(1);
    const text = notifications[0]!;
    expect(text).toContain("pi-better-edit bash multi-file");
    expect(text).toContain("bash.multiFile.maxFiles: 10 (default)");
    expect(text).toContain("bash.multiFile.maxRows: 2000 (default)");
    expect(text).toContain("allowed: maxFiles 2-10, maxRows 1-2000");
    expect(text).toContain("precedence: project > global > default");
    // WHY nothing on disk: a status read never creates the config directory or the file.
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("writes a lowered cap to the chosen scope and keeps the sibling cap and view", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view multi-file max-files 8 project", ctx);
    expect(notifications[0]).toContain("bash multi-file maxFiles set to 8 (project)");
    expect(notifications[0]).toContain(projectConfigPath());
    expect(readJson(projectConfigPath())).toMatchObject({ bash: { multiFile: { maxFiles: 8 } } });

    // WHY the scope defaults to project: the surface mirrors `bash-view` [project|global] ordering.
    await options.handler("bash-view multi-file max-rows 1500", ctx);
    await options.handler("bash-view off", ctx);
    expect(readJson(projectConfigPath())).toMatchObject({
      bash: { view: "off", multiFile: { maxFiles: 8, maxRows: 1500 } },
    });

    await options.handler("bash-view multi-file max-rows 1200 global", ctx);
    expect(readJson(globalConfigPath())).toMatchObject({ bash: { multiFile: { maxRows: 1200 } } });

    notifications.length = 0;
    await options.handler("bash-view multi-file status", ctx);
    // WHY project still wins for maxFiles and the row cap comes from the project too: the ladder is
    // WHY: resolved per key and the project file sets both.
    expect(notifications[0]).toContain("bash.multiFile.maxFiles: 8 (project)");
    expect(notifications[0]).toContain("bash.multiFile.maxRows: 1500 (project)");
  });

  it("refuses every out-of-range value, unknown scope and unknown option without writing", async () => {
    const { options } = captureCommand();
    const { ctx, notifications } = fakeCtx({ hasUI: true, cwd: projectDir });

    await options.handler("bash-view multi-file max-files 11", ctx);
    expect(notifications[0]).toContain("bash.multiFile.maxFiles must be an integer in 2-10");

    await options.handler("bash-view multi-file max-files 1", ctx);
    expect(notifications[1]).toContain("must be an integer in 2-10");

    await options.handler("bash-view multi-file max-rows 2001", ctx);
    expect(notifications[2]).toContain("bash.multiFile.maxRows must be an integer in 1-2000");

    await options.handler("bash-view multi-file max-rows", ctx);
    expect(notifications[3]).toContain("must be an integer in 1-2000");

    await options.handler("bash-view multi-file max-files 8 mars", ctx);
    expect(notifications[4]).toContain('Unknown scope "mars"');

    await options.handler("bash-view multi-file bogus", ctx);
    expect(notifications[5]).toContain('Unknown multi-file option "bogus"');

    await options.handler("bash-view multi-file status extra", ctx);
    expect(notifications[6]).toContain("Too many arguments");

    // WHY nothing written: a rejected value must never read back as the default.
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(globalConfigPath())).toBe(false);
  });
});
