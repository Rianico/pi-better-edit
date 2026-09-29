import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../../src/domain-errors.js";
import {
  LENS_BRIDGE_ENV_VAR,
  LENS_CONFIG_REL,
  LENS_SCHEMA_ID,
  readLensBridgeConfig,
  resolveEffectiveLensMode,
  saveLensBridgeConfig,
  type LensBridgeMode,
  type LensBridgeScope,
} from "../../../src/integrations/pi-lens/config.js";

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;

const projectConfigPath = (): string => join(projectDir, LENS_CONFIG_REL);
const globalConfigPath = (): string => join(homeDir, LENS_CONFIG_REL);

async function seedProjectConfig(value: unknown): Promise<void> {
  await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
  await writeFile(projectConfigPath(), JSON.stringify(value), "utf-8");
}

async function seedGlobalConfig(value: unknown): Promise<void> {
  await mkdir(join(homeDir, ".pi", "agents"), { recursive: true });
  await writeFile(globalConfigPath(), JSON.stringify(value), "utf-8");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-lens-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  await rm(root, { recursive: true, force: true });
});

describe("readLensBridgeConfig / resolveEffectiveLensMode", () => {
  it("defaults to auto without creating any config file or directory", () => {
    expect(readLensBridgeConfig(projectDir)).toEqual({});
    expect(resolveEffectiveLensMode(projectDir)).toBe("auto");
    expect(readdirSync(projectDir)).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("resolves env over project over global over the auto default", async () => {
    expect(resolveEffectiveLensMode(projectDir)).toBe("auto");

    await seedGlobalConfig({ lens: { bridge: "off" } });
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "off" });
    expect(resolveEffectiveLensMode(projectDir)).toBe("off");

    await seedProjectConfig({ lens: { bridge: "on" } });
    expect(readLensBridgeConfig(projectDir)).toEqual({ project: "on", global: "off" });
    expect(resolveEffectiveLensMode(projectDir)).toBe("on");

    process.env[LENS_BRIDGE_ENV_VAR] = "  OFF  ";
    expect(resolveEffectiveLensMode(projectDir)).toBe("off");

    process.env[LENS_BRIDGE_ENV_VAR] = "bogus";
    expect(resolveEffectiveLensMode(projectDir)).toBe("on");

    process.env[LENS_BRIDGE_ENV_VAR] = "   ";
    expect(resolveEffectiveLensMode(projectDir)).toBe("on");
  });

  it("ignores a malformed or out-of-enum scope instead of throwing", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");
    await seedGlobalConfig({ lens: { bridge: "on" } });
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "on" });
    expect(resolveEffectiveLensMode(projectDir)).toBe("on");

    await writeFile(projectConfigPath(), JSON.stringify({ lens: "on" }), "utf-8");
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "on" });

    await writeFile(projectConfigPath(), JSON.stringify({ lens: { bridge: "maybe" } }), "utf-8");
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "on" });

    await writeFile(projectConfigPath(), JSON.stringify([{ lens: { bridge: "off" } }]), "utf-8");
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "on" });

    await writeFile(
      projectConfigPath(),
      JSON.stringify({ lens: { bridge: "off" }, other: 1 }),
      "utf-8",
    );
    expect(readLensBridgeConfig(projectDir)).toEqual({ project: "off", global: "on" });
  });

  it("treats an unreadable config path (a directory) as unset", async () => {
    await mkdir(projectConfigPath(), { recursive: true });
    expect(readLensBridgeConfig(projectDir)).toEqual({});
    expect(resolveEffectiveLensMode(projectDir)).toBe("auto");
  });
});

describe("saveLensBridgeConfig", () => {
  it("creates the directory and writes the canonical fresh shape with a trailing newline", () => {
    const { path } = saveLensBridgeConfig("auto", "project", projectDir);
    expect(path).toBe(projectConfigPath());
    expect(readFileSync(path, "utf-8")).toBe(
      `${JSON.stringify({ $schema: LENS_SCHEMA_ID, lens: { bridge: "auto" } }, null, 2)}\n`,
    );
    expect(readdirSync(join(projectDir, ".pi", "agents"))).toEqual(["pi-better-edit.json"]);
    expect(readLensBridgeConfig(projectDir)).toEqual({ project: "auto" });
  });

  it("preserves unknown top-level keys, sibling lens keys and a custom $schema", async () => {
    await seedProjectConfig({
      $schema: "http://localhost/local-schema.json",
      lens: { bridge: "off", other: true },
      extra: { keep: 1 },
    });

    saveLensBridgeConfig("on", "project", projectDir);

    expect(readJson(projectConfigPath())).toEqual({
      $schema: "http://localhost/local-schema.json",
      lens: { bridge: "on", other: true },
      extra: { keep: 1 },
    });
  });

  it("rewrites a canonical file when the existing one is unparseable or not an object", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "]]]", "utf-8");
    saveLensBridgeConfig("off", "project", projectDir);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "off" },
    });

    await writeFile(projectConfigPath(), JSON.stringify({ lens: "on", keep: 1 }), "utf-8");
    saveLensBridgeConfig("auto", "project", projectDir);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "auto" },
      keep: 1,
    });

    await writeFile(projectConfigPath(), JSON.stringify({ $schema: 42 }), "utf-8");
    saveLensBridgeConfig("on", "project", projectDir);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "on" },
    });
  });

  it("writes the global scope under HOME and leaves the project scope alone", () => {
    const { path } = saveLensBridgeConfig("on", "global", projectDir);
    expect(path).toBe(globalConfigPath());
    expect(readJson(globalConfigPath())).toEqual({
      $schema: LENS_SCHEMA_ID,
      lens: { bridge: "on" },
    });
    expect(readLensBridgeConfig(projectDir)).toEqual({ global: "on" });
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("rejects a mode or scope outside the enum with E_BAD_PAYLOAD and writes nothing", () => {
    let modeError: unknown;
    try {
      saveLensBridgeConfig("nope" as LensBridgeMode, "project", projectDir);
    } catch (caught: unknown) {
      modeError = caught;
    }
    expect(modeError).toBeInstanceOf(DomainError);
    expect((modeError as { code: string }).code).toBe("E_BAD_PAYLOAD");
    expect((modeError as Error).message).toContain("nope");

    expect(() => saveLensBridgeConfig("auto", "mars" as LensBridgeScope, projectDir)).toThrowError(
      /E_BAD_PAYLOAD/,
    );
    expect(readdirSync(projectDir)).toEqual([]);
  });
});
