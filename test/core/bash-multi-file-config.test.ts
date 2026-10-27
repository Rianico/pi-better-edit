/**
 * Multi-file view caps — the `bash.multiFile` ladder of `.pi/agents/pi-better-edit.json`
 * (ADR-0049 M6). Mirrors `test/core/bash-view-config.test.ts`: project beats global beats the
 * declared default, PER KEY; a value outside the allowed range is dropped WITH a warning naming the
 * file, the key, the value and the range; and the saver preserves every sibling key in both
 * directions (`view` survives a caps write, a cap survives a `view` write).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir } from "../../src/config-dir.js";
import { DomainError } from "../../src/domain-errors.js";
import { CONFIG_FILE_NAME, CONFIG_REL, CONFIG_SCHEMA_ID } from "../../src/json-config.js";
import { saveBashViewConfig } from "../../src/bash-view-config.js";
import {
  BASH_MULTI_FILE_DEFAULTS,
  BASH_MULTI_FILE_LIMITS,
  isBashMultiFileMaxFiles,
  isBashMultiFileMaxRows,
  isBashMultiFileScope,
  readBashMultiFileConfig,
  resolveBashMultiFileSettings,
  resolveBashMultiFileSettingsWithSources,
  saveBashMultiFileConfig,
} from "../../src/bash-multifile-config.js";

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;
const warnings: string[] = [];
const warn = (reason: string): void => {
  warnings.push(reason);
};

const projectConfigPath = (): string => join(projectDir, CONFIG_REL);
const globalConfigPath = (): string => join(configDir(), CONFIG_FILE_NAME);

async function seedProjectConfig(value: unknown): Promise<void> {
  await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
  await writeFile(projectConfigPath(), JSON.stringify(value, null, 2), "utf-8");
}

async function seedGlobalConfig(value: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(globalConfigPath(), JSON.stringify(value, null, 2), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-multifile-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  warnings.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(globalConfigPath(), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe("resolveBashMultiFileSettings — precedence ladder", () => {
  it("defaults to 10 files and 2000 rows without warning or creating a config file", () => {
    expect(resolveBashMultiFileSettings(projectDir, warn)).toEqual({ maxFiles: 10, maxRows: 2000 });
    expect(BASH_MULTI_FILE_DEFAULTS).toEqual({ maxFiles: 10, maxRows: 2000 });
    expect(warnings).toEqual([]);
  });

  it("resolves PER KEY: one from the project file, its sibling from the global file", async () => {
    // WHY per key: a scope that sets one cap says nothing about the other, so the other keeps
    // falling through the ladder — the property the rung report exists to expose.
    await seedProjectConfig({ bash: { multiFile: { maxFiles: 4 } } });
    await seedGlobalConfig({ bash: { multiFile: { maxRows: 100 } } });
    const resolved = resolveBashMultiFileSettingsWithSources(projectDir, warn);
    expect(resolved.maxFiles).toEqual({ value: 4, source: "project" });
    expect(resolved.maxRows).toEqual({ value: 100, source: "global" });
    expect(warnings).toEqual([]);
  });

  it("prefers the project file over the global file for the same key", async () => {
    await seedProjectConfig({ bash: { multiFile: { maxFiles: 3 } } });
    await seedGlobalConfig({ bash: { multiFile: { maxFiles: 6 } } });
    expect(resolveBashMultiFileSettings(projectDir, warn)).toEqual({ maxFiles: 3, maxRows: 2000 });
    expect(readBashMultiFileConfig(projectDir, warn)).toEqual({
      project: { maxFiles: 3 },
      global: { maxFiles: 6 },
    });
  });

  it("drops an out-of-range value WITH a warning naming file, key, value and range, then falls through", async () => {
    await seedProjectConfig({ bash: { multiFile: { maxFiles: 42 } } });
    await seedGlobalConfig({ bash: { multiFile: { maxFiles: 5 } } });
    const resolved = resolveBashMultiFileSettingsWithSources(projectDir, warn);
    // WHY: the dropped project value is NOT clamped to 10 — the cap only ever falls through, so an
    // WHY: operator never gets a cap they did not configure.
    expect(resolved.maxFiles).toEqual({ value: 5, source: "global" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
    expect(warnings[0]).toContain("bash.multiFile.maxFiles");
    expect(warnings[0]).toContain("42");
    expect(warnings[0]).toContain("2-10");
  });

  it("warns for a non-numeric, a fractional and a zero cap, and for a non-object subtree", async () => {
    await seedProjectConfig({
      bash: { multiFile: { maxFiles: "8", maxRows: 1.5 } },
    });
    const resolved = resolveBashMultiFileSettings(projectDir, warn);
    expect(resolved).toEqual({ maxFiles: 10, maxRows: 2000 });
    expect(warnings).toHaveLength(2);

    warnings.length = 0;
    await seedProjectConfig({ bash: { multiFile: "big" } });
    expect(resolveBashMultiFileSettings(projectDir, warn)).toEqual({
      maxFiles: 10,
      maxRows: 2000,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
    expect(warnings[0]).toContain("not an object");
  });

  it("accepts both range ends and the whole allowed span", async () => {
    await seedProjectConfig({ bash: { multiFile: { maxFiles: 2, maxRows: 1 } } });
    expect(resolveBashMultiFileSettings(projectDir, warn)).toEqual({ maxFiles: 2, maxRows: 1 });
    await seedProjectConfig({ bash: { multiFile: { maxFiles: 10, maxRows: 2000 } } });
    expect(resolveBashMultiFileSettings(projectDir, warn)).toEqual({ maxFiles: 10, maxRows: 2000 });
    expect(warnings).toEqual([]);
  });
});

describe("bash multi-file range guards", () => {
  it("pins the allowed ranges", () => {
    expect(BASH_MULTI_FILE_LIMITS.maxFiles).toEqual({ min: 2, max: 10 });
    expect(BASH_MULTI_FILE_LIMITS.maxRows).toEqual({ min: 1, max: 2000 });
  });

  it("rejects non-integers and every out-of-range value", () => {
    for (const value of [1, 0, -3, 11, 10.5, "10", null, undefined, Number.NaN]) {
      expect(isBashMultiFileMaxFiles(value)).toBe(false);
    }
    for (const value of [2, 10]) expect(isBashMultiFileMaxFiles(value)).toBe(true);
    for (const value of [0, -1, 2001, 2.5, "8", null, undefined]) {
      expect(isBashMultiFileMaxRows(value)).toBe(false);
    }
    for (const value of [1, 2000]) expect(isBashMultiFileMaxRows(value)).toBe(true);
    expect(isBashMultiFileScope("project")).toBe(true);
    expect(isBashMultiFileScope("global")).toBe(true);
    expect(isBashMultiFileScope("mars")).toBe(false);
  });
});

describe("saveBashMultiFileConfig", () => {
  it("writes one cap into the project file and reports the path", async () => {
    const { path } = saveBashMultiFileConfig({ maxFiles: 8 }, "project", projectDir);
    expect(path).toBe(projectConfigPath());
    // WHY `$schema` is expected: the shared writer stamps it on every file it creates, so a saved
    // WHY: file is self-describing for editors.
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({
      $schema: CONFIG_SCHEMA_ID,
      bash: { multiFile: { maxFiles: 8 } },
    });
  });

  it("preserves bash.view and the sibling cap in both directions", async () => {
    // WHY both directions: two owners write inside the same `bash` object, so each must spread what it
    // WHY: did not own — a caps write dropping `view`, or a `view` write dropping the caps, would
    // WHY: silently revert the other setting.
    saveBashViewConfig("off", "project", projectDir);
    saveBashMultiFileConfig({ maxFiles: 6 }, "project", projectDir);
    saveBashMultiFileConfig({ maxRows: 150 }, "project", projectDir);
    saveBashViewConfig("on", "project", projectDir);
    expect(JSON.parse(await readFile(projectConfigPath(), "utf-8"))).toEqual({
      $schema: CONFIG_SCHEMA_ID,
      bash: { view: "on", multiFile: { maxFiles: 6, maxRows: 150 } },
    });
  });

  it("keeps $schema and unknown keys", async () => {
    await seedProjectConfig({
      $schema: "https://example.test/schema.json",
      theme: "dark",
      bash: { view: "off", extra: true, multiFile: { note: "keep me" } },
    });
    saveBashMultiFileConfig({ maxRows: 10 }, "project", projectDir);
    expect(JSON.parse(await readFile(projectConfigPath(), "utf-8"))).toEqual({
      $schema: "https://example.test/schema.json",
      theme: "dark",
      bash: {
        view: "off",
        extra: true,
        multiFile: { note: "keep me", maxRows: 10 },
      },
    });
  });

  it("fails as an internal invariant, writing nothing, for an out-of-range cap or unknown scope", async () => {
    const cases: Array<() => unknown> = [
      () => saveBashMultiFileConfig({ maxFiles: 11 }, "project", projectDir),
      () => saveBashMultiFileConfig({ maxRows: 0 }, "project", projectDir),
      () => saveBashMultiFileConfig({}, "project", projectDir),
      () => saveBashMultiFileConfig({ maxFiles: 6 }, "mars" as never, projectDir),
    ];
    for (const run of cases) {
      let caught: unknown;
      try {
        run();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe("E_INTERNAL_INVARIANT");
    }
    // WHY: nothing was written, so a rejected value never reads back as the default.
    await expect(readFile(projectConfigPath(), "utf-8")).rejects.toThrow();
  });
});
