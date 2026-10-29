/**
 * Bash view setting — the `bash.view` ladder of `.pi/agents/pi-better-edit.json`.
 * Mirrors `test/core/store-config.test.ts`: env beats project beats global beats the
 * default (`on`), and a malformed file degrades to the default WITH a warning.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsRoot } from "../../src/config-dir.js";
import { CONFIG_REL, CONFIG_SCHEMA_ID, CONFIG_FILE_NAME } from "../../src/json-config.js";
import { DomainError } from "../../src/domain-errors.js";
import {
  BASH_VIEW_DEFAULT,
  BASH_VIEW_ENV_VAR,
  readBashViewConfig,
  resolveBashViewMode,
  resolveBashViewModeWithSource,
  saveBashViewConfig,
  isBashViewMode,
  isBashViewScope,
  type BashViewMode,
} from "../../src/bash-view-config.js";

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;
const warnings: string[] = [];
const warn = (reason: string): void => {
  warnings.push(reason);
};

const projectConfigPath = (): string => join(projectDir, CONFIG_REL);
const globalConfigPath = (): string => join(settingsRoot(), CONFIG_FILE_NAME);

async function seedProjectConfig(value: unknown): Promise<void> {
  await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
  await writeFile(projectConfigPath(), JSON.stringify(value), "utf-8");
}

async function seedGlobalConfig(value: unknown): Promise<void> {
  await mkdir(settingsRoot(), { recursive: true });
  await writeFile(globalConfigPath(), JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-bash-view-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[BASH_VIEW_ENV_VAR];
  warnings.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[BASH_VIEW_ENV_VAR];
  await rm(globalConfigPath(), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe("resolveBashViewMode — precedence ladder", () => {
  it("defaults to on without creating any config file or directory and without a warning", () => {
    expect(BASH_VIEW_DEFAULT).toBe("on");
    expect(resolveBashViewMode(projectDir, warn)).toBe("on");
    expect(readBashViewConfig(projectDir, warn)).toEqual({});
    expect(warnings).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("resolves global, then project, then env", async () => {
    await seedGlobalConfig({ bash: { view: "off" } });
    expect(resolveBashViewMode(projectDir, warn)).toBe("off");

    await seedProjectConfig({ bash: { view: "on" } });
    expect(resolveBashViewMode(projectDir, warn)).toBe("on");

    process.env[BASH_VIEW_ENV_VAR] = "off";
    expect(resolveBashViewMode(projectDir, warn)).toBe("off");
  });

  it("ignores an env value outside its accepted shape and keeps the file's answer", async () => {
    await seedProjectConfig({ bash: { view: "off" } });
    process.env[BASH_VIEW_ENV_VAR] = "sometimes";
    expect(resolveBashViewMode(projectDir, warn)).toBe("off");
    expect(warnings).toEqual([]);
  });

  it("ignores a file value outside its accepted shape and keeps the other rung's answer", async () => {
    await seedProjectConfig({ bash: { view: "sometimes" } });
    await seedGlobalConfig({ bash: { view: "off" } });
    expect(resolveBashViewMode(projectDir, warn)).toBe("off");
  });
});

describe("resolveBashViewMode — a broken file degrades with a warning", () => {
  it("reads a malformed file as the default, warns exactly once and throws nothing", async () => {
    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");

    let resolved: string | undefined;
    expect(() => {
      resolved = resolveBashViewMode(projectDir, warn);
    }).not.toThrow();
    expect(resolved).toBe("on");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });

  it("warns once per scope that exists but cannot be used, and names each file", async () => {
    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await mkdir(settingsRoot(), { recursive: true });
    await writeFile(projectConfigPath(), "]]]", "utf-8");
    await writeFile(globalConfigPath(), '{"bash": ', "utf-8");

    expect(resolveBashViewMode(projectDir, warn)).toBe("on");
    expect(warnings).toHaveLength(2);
    expect(warnings.some((line) => line.includes(projectConfigPath()))).toBe(true);
    expect(warnings.some((line) => line.includes(globalConfigPath()))).toBe(true);
  });

  it("warns nobody about a missing file and stays silent when no warning channel is passed", async () => {
    expect(resolveBashViewMode(projectDir, warn)).toBe("on");
    expect(warnings).toEqual([]);

    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");
    expect(() => resolveBashViewMode(projectDir)).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("reads an unreadable config path (a directory) as the default with one warning", () => {
    mkdirSync(projectConfigPath(), { recursive: true });
    expect(resolveBashViewMode(projectDir, warn)).toBe("on");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });
});

describe("resolveBashViewModeWithSource — the rung the mode came from", () => {
  it("names the default rung when no rung answered", () => {
    expect(resolveBashViewModeWithSource(projectDir, warn)).toEqual({
      value: "on",
      source: "default",
    });
    expect(warnings).toEqual([]);
  });

  it("names env over project over global", async () => {
    await seedGlobalConfig({ bash: { view: "off" } });
    await seedProjectConfig({ bash: { view: "on" } });
    expect(resolveBashViewModeWithSource(projectDir, warn)).toEqual({
      value: "on",
      source: "project",
    });

    process.env[BASH_VIEW_ENV_VAR] = "off";
    expect(resolveBashViewModeWithSource(projectDir, warn)).toEqual({
      value: "off",
      source: "env",
    });
  });
});

describe("bash view validation guards", () => {
  it("accepts only on and off as a mode and only project and global as a scope", () => {
    expect(isBashViewMode("on")).toBe(true);
    expect(isBashViewMode("off")).toBe(true);
    expect(isBashViewMode("sometimes")).toBe(false);
    expect(isBashViewScope("project")).toBe(true);
    expect(isBashViewScope("global")).toBe(true);
    expect(isBashViewScope("mars")).toBe(false);
  });
});
describe("saveBashViewConfig", () => {
  it("creates the directory and writes the canonical shape with a trailing newline", () => {
    const { path } = saveBashViewConfig("off", "project", projectDir);
    expect(path).toBe(projectConfigPath());
    expect(readFileSync(path, "utf-8")).toBe(
      `${JSON.stringify({ $schema: CONFIG_SCHEMA_ID, bash: { view: "off" } }, null, 2)}\n`,
    );
    expect(readdirSync(join(projectDir, ".pi", "agents", "pi-better-edit"))).toEqual([
      "settings.json",
    ]);
    expect(resolveBashViewMode(projectDir, warn)).toBe("off");
  });

  it("preserves unknown keys, sibling bash keys, the lens block and a custom $schema", async () => {
    await seedProjectConfig({
      $schema: "https://example.test/custom.json",
      lens: { bridge: "off" },
      bash: { view: "on", other: true },
      extra: 1,
    });
    saveBashViewConfig("off", "project", projectDir);
    expect(JSON.parse(readFileSync(projectConfigPath(), "utf-8"))).toEqual({
      $schema: "https://example.test/custom.json",
      lens: { bridge: "off" },
      bash: { view: "off", other: true },
      extra: 1,
    });
  });

  it("writes the global scope under HOME and leaves the project scope alone", async () => {
    const { path } = saveBashViewConfig("off", "global", projectDir);
    expect(path).toBe(globalConfigPath());
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("rejects a value or scope outside its accepted shape with E_INTERNAL_INVARIANT and writes nothing", () => {
    expect(() =>
      saveBashViewConfig("sometimes" as BashViewMode, "project", projectDir),
    ).toThrowError(/E_INTERNAL_INVARIANT/);
    expect(() =>
      saveBashViewConfig("off", "mars" as Parameters<typeof saveBashViewConfig>[1], projectDir),
    ).toThrowError(/E_INTERNAL_INVARIANT/);

    let caught: unknown;
    try {
      saveBashViewConfig("sometimes" as BashViewMode, "project", projectDir);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(existsSync(projectConfigPath())).toBe(false);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });
});
