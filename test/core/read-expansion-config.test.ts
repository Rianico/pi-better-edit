/**
 * Read expansion setting — the `read.expansion` ladder, mirroring `bash.view`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsRoot } from "../../src/config-dir.js";
import { CONFIG_FILE_NAME, CONFIG_REL, CONFIG_SCHEMA_ID } from "../../src/json-config.js";
import {
  READ_EXPANSION_DEFAULT,
  READ_EXPANSION_ENV_VAR,
  isReadExpansionMode,
  isReadExpansionScope,
  readReadExpansionConfig,
  resolveReadExpansionMode,
  resolveReadExpansionModeWithSource,
  saveReadExpansionConfig,
  type ReadExpansionMode,
} from "../../src/read-expansion-config.js";

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
  root = await mkdtemp(join(tmpdir(), "pbe-read-expansion-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[READ_EXPANSION_ENV_VAR];
  warnings.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[READ_EXPANSION_ENV_VAR];
  await rm(globalConfigPath(), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe("resolveReadExpansionMode — precedence ladder", () => {
  it("defaults to on without creating config and without a warning", () => {
    expect(READ_EXPANSION_DEFAULT).toBe("on");
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("on");
    expect(readReadExpansionConfig(projectDir, warn)).toEqual({});
    expect(warnings).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("resolves global, then project, then env", async () => {
    await seedGlobalConfig({ read: { expansion: "off" } });
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("off");

    await seedProjectConfig({ read: { expansion: "on" } });
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("on");

    process.env[READ_EXPANSION_ENV_VAR] = "off";
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("off");
  });

  it("ignores invalid env/file values and keeps the next rung", async () => {
    await seedProjectConfig({ read: { expansion: "sometimes" } });
    await seedGlobalConfig({ read: { expansion: "off" } });
    process.env[READ_EXPANSION_ENV_VAR] = "sometimes";
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("off");
  });

  it("warns once for a malformed or unreadable file and never throws", async () => {
    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");
    let resolved: ReadExpansionMode | undefined;
    expect(() => {
      resolved = resolveReadExpansionMode(projectDir, warn);
    }).not.toThrow();
    expect(resolved).toBe("on");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());

    await rm(projectConfigPath(), { recursive: true, force: true });
    mkdirSync(projectConfigPath(), { recursive: true });
    warnings.length = 0;
    expect(resolveReadExpansionMode(projectDir, warn)).toBe("on");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });
});

describe("resolveReadExpansionModeWithSource", () => {
  it("names the default, project, and env rungs", async () => {
    expect(resolveReadExpansionModeWithSource(projectDir, warn)).toEqual({
      value: "on",
      source: "default",
    });
    await seedProjectConfig({ read: { expansion: "off" } });
    expect(resolveReadExpansionModeWithSource(projectDir, warn)).toEqual({
      value: "off",
      source: "project",
    });
    process.env[READ_EXPANSION_ENV_VAR] = "on";
    expect(resolveReadExpansionModeWithSource(projectDir, warn)).toEqual({
      value: "on",
      source: "env",
    });
  });

  it("names the global rung", async () => {
    await seedGlobalConfig({ read: { expansion: "off" } });
    expect(resolveReadExpansionModeWithSource(projectDir, warn)).toEqual({
      value: "off",
      source: "global",
    });
  });
});

describe("read expansion validation and writes", () => {
  it("accepts only on/off and project/global", () => {
    expect(isReadExpansionMode("on")).toBe(true);
    expect(isReadExpansionMode("off")).toBe(true);
    expect(isReadExpansionMode("sometimes")).toBe(false);
    expect(isReadExpansionScope("project")).toBe(true);
    expect(isReadExpansionScope("global")).toBe(true);
    expect(isReadExpansionScope("mars")).toBe(false);
  });

  it("writes the canonical shape and preserves unknown, read and other owner keys", async () => {
    await seedProjectConfig({
      $schema: "https://example.test/custom.json",
      lens: { bridge: "off" },
      read: { expansion: "on", other: true },
      extra: 1,
    });
    const { path } = saveReadExpansionConfig("off", "project", projectDir);
    expect(path).toBe(projectConfigPath());
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      $schema: "https://example.test/custom.json",
      lens: { bridge: "off" },
      read: { expansion: "off", other: true },
      extra: 1,
    });
  });

  it("creates the canonical shape and rejects invalid values without writing", () => {
    const { path } = saveReadExpansionConfig("off", "project", projectDir);
    expect(readFileSync(path, "utf-8")).toBe(
      `${JSON.stringify({ $schema: CONFIG_SCHEMA_ID, read: { expansion: "off" } }, null, 2)}\n`,
    );
    expect(() =>
      saveReadExpansionConfig("sometimes" as ReadExpansionMode, "project", projectDir),
    ).toThrowError(/E_INTERNAL_INVARIANT/);
    expect(() =>
      saveReadExpansionConfig(
        "on",
        "mars" as Parameters<typeof saveReadExpansionConfig>[1],
        projectDir,
      ),
    ).toThrowError(/E_INTERNAL_INVARIANT/);
    expect(JSON.parse(readFileSync(path, "utf-8")).read.expansion).toBe("off");
  });
});
