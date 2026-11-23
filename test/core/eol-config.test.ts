/**
 * Effective EOL setting — the top-level `eol` ladder of `.pi/agents/pi-better-edit/settings.json`
 * plus the terminator counts that decide an `AUTO` file.
 * Mirrors `test/core/bash-view-config.test.ts`: env beats project beats global beats `AUTO`,
 * a malformed file degrades with a warning, and the read side never throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsRoot } from "../../src/config-dir.js";
import { countLineEndings } from "../../src/edit-diff.js";
import {
  EOL_DEFAULT,
  EOL_ENV_VAR,
  dominantEnding,
  type EolSource,
  isEolSetting,
  readEolConfig,
  resolveEffectiveEol,
  resolveEolSettingWithSource,
} from "../../src/eol-config.js";
import { CONFIG_FILE_NAME, CONFIG_REL } from "../../src/json-config.js";

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

/** The only rungs `resolveEffectiveEol` may report. `EolSource` excludes `"default"`, so adding it here is a type error: AUTO always names a terminator. */
const SOURCES: readonly EolSource[] = ["env", "project", "global", "file", "system"];

async function seedProjectConfig(value: unknown): Promise<void> {
  await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
  await writeFile(projectConfigPath(), JSON.stringify(value), "utf-8");
}

async function seedGlobalConfig(value: unknown): Promise<void> {
  await mkdir(settingsRoot(), { recursive: true });
  await writeFile(globalConfigPath(), JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-eol-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[EOL_ENV_VAR];
  warnings.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[EOL_ENV_VAR];
  await rm(globalConfigPath(), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe("eol schema and default", () => {
  it("publishes the top-level eol property and keeps the default in step", () => {
    // SAFETY: the repository's own schema file is a trusted local asset.
    const schema = JSON.parse(readFileSync(join("schemas", "pi-better-edit.json"), "utf-8")) as {
      additionalProperties?: unknown;
      properties: { eol?: unknown };
    };
    expect(schema.properties.eol).toEqual({
      type: "string",
      enum: ["AUTO", "LF", "CRLF", "CR"],
      default: "AUTO",
    });
    expect(schema.additionalProperties).toBe(true);
    expect(EOL_DEFAULT).toBe("AUTO");
  });
});

describe("resolveEolSettingWithSource — precedence ladder", () => {
  it("defaults to AUTO without creating any config file or directory and without a warning", () => {
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "AUTO",
      source: "default",
    });
    expect(readEolConfig(projectDir, warn)).toEqual({});
    expect(warnings).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("resolves global, then project, then env", async () => {
    await seedGlobalConfig({ eol: "CRLF" });
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "CRLF",
      source: "global",
    });

    await seedProjectConfig({ eol: "LF" });
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "LF",
      source: "project",
    });

    process.env[EOL_ENV_VAR] = "CR";
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "CR",
      source: "env",
    });
    expect(warnings).toEqual([]);
  });

  it("trims and upper-cases the env value", async () => {
    process.env[EOL_ENV_VAR] = "  crlf  ";
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "CRLF",
      source: "env",
    });

    process.env[EOL_ENV_VAR] = "Cr";
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({ value: "CR", source: "env" });
  });

  it("ignores an env value outside the enum and keeps the file's answer", async () => {
    await seedProjectConfig({ eol: "LF" });
    process.env[EOL_ENV_VAR] = "sometimes";
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "LF",
      source: "project",
    });
    expect(warnings).toEqual([]);
  });

  it("reads file values verbatim, so a lowercase or non-string value is ignored", async () => {
    await seedGlobalConfig({ eol: "CRLF" });
    await seedProjectConfig({ eol: "lf" });
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "CRLF",
      source: "global",
    });

    await seedProjectConfig({ eol: 1 });
    expect(resolveEolSettingWithSource(projectDir, warn)).toEqual({
      value: "CRLF",
      source: "global",
    });
  });

  it("reads a malformed project file as the default, warns once and throws nothing", async () => {
    await mkdir(join(projectDir, ".pi", "agents", "pi-better-edit"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");

    let resolved: { value: string; source: string } | undefined;
    expect(() => {
      resolved = resolveEolSettingWithSource(projectDir, warn);
    }).not.toThrow();
    expect(resolved).toEqual({ value: "AUTO", source: "default" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });
});

describe("resolveEffectiveEol — forced settings win over the file's own terminators", () => {
  const mixed = "a\r\nb\nc\r";

  it("names env when the env override forces LF", () => {
    process.env[EOL_ENV_VAR] = "LF";
    const resolved = resolveEffectiveEol(mixed, projectDir, warn);
    expect(resolved).toEqual({ value: "\n", source: "env" });
    expect(SOURCES).toContain(resolved.source);
  });

  it("names project when the project file forces CRLF", async () => {
    await seedProjectConfig({ eol: "CRLF" });
    const resolved = resolveEffectiveEol(mixed, projectDir, warn);
    expect(resolved).toEqual({ value: "\r\n", source: "project" });
    expect(SOURCES).toContain(resolved.source);
  });

  it("names global when only the global file forces CR", async () => {
    await seedGlobalConfig({ eol: "CR" });
    const resolved = resolveEffectiveEol(mixed, projectDir, warn);
    expect(resolved).toEqual({ value: "\r", source: "global" });
    expect(SOURCES).toContain(resolved.source);
  });
});

describe("resolveEffectiveEol — AUTO follows the dominant terminator", () => {
  it("picks CRLF when CRLF pairs outnumber LF, counting a pair once", () => {
    const resolved = resolveEffectiveEol("a\r\nb\r\nc\n", projectDir, warn);
    expect(resolved).toEqual({ value: "\r\n", source: "file" });
    expect(SOURCES).toContain(resolved.source);
  });

  it("picks LF when LF outnumbers CRLF", () => {
    expect(resolveEffectiveEol("a\r\nb\nc\n", projectDir, warn)).toEqual({
      value: "\n",
      source: "file",
    });
  });

  it("picks CR when lone CR outnumbers both", () => {
    expect(resolveEffectiveEol("a\rb\rc\r\n", projectDir, warn)).toEqual({
      value: "\r",
      source: "file",
    });
  });

  it("breaks ties toward LF, then CRLF", () => {
    expect(resolveEffectiveEol("a\r\nb\n", projectDir, warn).value).toBe("\n");
    expect(resolveEffectiveEol("a\rb\r\n", projectDir, warn).value).toBe("\r\n");
    expect(resolveEffectiveEol("a\rb\nc\r\n", projectDir, warn).value).toBe("\n");
  });

  it("keeps a uniform file's own terminator", () => {
    expect(resolveEffectiveEol("a\nb\n", projectDir, warn)).toEqual({
      value: "\n",
      source: "file",
    });
    expect(resolveEffectiveEol("a\r\nb\r\n", projectDir, warn)).toEqual({
      value: "\r\n",
      source: "file",
    });
    expect(resolveEffectiveEol("a\rb\r", projectDir, warn)).toEqual({
      value: "\r",
      source: "file",
    });
  });

  it("falls back to the system terminator when the content carries none", () => {
    const expected = process.platform === "win32" ? "\r\n" : "\n";
    const resolved = resolveEffectiveEol("no terminator", projectDir, warn);
    expect(resolved).toEqual({ value: expected, source: "system" });
    expect(SOURCES).toContain(resolved.source);
    expect(dominantEnding("no terminator")).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "names the Windows system terminator when the platform is win32",
    () => {
      const saved = Object.getOwnPropertyDescriptor(process, "platform");
      expect(saved).toBeDefined();
      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        expect(resolveEffectiveEol("", projectDir, warn)).toEqual({
          value: "\r\n",
          source: "system",
        });
      } finally {
        if (saved !== undefined) Object.defineProperty(process, "platform", saved);
      }
    },
  );
});

describe("countLineEndings — one pass, one count per terminator", () => {
  it("counts each kind at its own byte", () => {
    expect(countLineEndings("")).toEqual({ crlf: 0, lf: 0, cr: 0 });
    expect(countLineEndings("a\r\nb\r\nc\n")).toEqual({ crlf: 2, lf: 1, cr: 0 });
    expect(countLineEndings("a\rb")).toEqual({ crlf: 0, lf: 0, cr: 1 });
    expect(countLineEndings("a\r\n\r")).toEqual({ crlf: 1, lf: 0, cr: 1 });
  });
});

describe("eol setting validation guard", () => {
  it("accepts only the four enum members", () => {
    expect(isEolSetting("AUTO")).toBe(true);
    expect(isEolSetting("LF")).toBe(true);
    expect(isEolSetting("CRLF")).toBe(true);
    expect(isEolSetting("CR")).toBe(true);
    expect(isEolSetting("auto")).toBe(false);
    expect(isEolSetting("lf")).toBe(false);
    expect(isEolSetting("sometimes")).toBe(false);
    expect(isEolSetting(1)).toBe(false);
    expect(isEolSetting(undefined)).toBe(false);
  });
});
