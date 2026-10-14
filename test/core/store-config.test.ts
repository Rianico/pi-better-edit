/**
 * Store janitor settings — the `store.*` ladder of `.pi/agents/pi-better-edit.json` (ticket #90,
 * acceptance item 6). The matrix pins one rung per key: env beats project beats global beats the
 * default, and a malformed file degrades to the same answers WITH a warning instead of throwing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain-errors.js";
import { configDir, hashStorePath } from "../../src/hash-store.js";
import { CONFIG_REL, CONFIG_SCHEMA_ID } from "../../src/json-config.js";
import {
  readStoreJanitorConfig,
  resolveStoreJanitorSettings,
  resolveStoreJanitorSettingsWithSources,
  saveStoreJanitorConfig,
  STORE_JANITOR_BATCH_DEFAULT,
  STORE_JANITOR_BATCH_ENV_VAR,
  STORE_JANITOR_DEFAULTS,
  STORE_JANITOR_ENV_VAR,
  STORE_JANITOR_INTERVAL_DEFAULT_MS,
  STORE_JANITOR_INTERVAL_ENV_VAR,
  type StoreJanitorMode,
  type StoreJanitorScopeSettings,
  type StoreJanitorSettings,
} from "../../src/store-config.js";

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;
const warnings: string[] = [];
const warn = (reason: string): void => {
  warnings.push(reason);
};

const ALL_ENV_VARS = [
  STORE_JANITOR_ENV_VAR,
  STORE_JANITOR_INTERVAL_ENV_VAR,
  STORE_JANITOR_BATCH_ENV_VAR,
] as const;

const projectConfigPath = (): string => join(projectDir, CONFIG_REL);
const globalConfigPath = (): string => join(homeDir, CONFIG_REL);

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
  root = await mkdtemp(join(tmpdir(), "pbe-store-config-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  for (const name of ALL_ENV_VARS) delete process.env[name];
  warnings.length = 0;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const name of ALL_ENV_VARS) delete process.env[name];
  await rm(root, { recursive: true, force: true });
});

describe("resolveStoreJanitorSettings — precedence ladder", () => {
  it("defaults without creating any config file or directory and without a warning", () => {
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "on",
      intervalMs: STORE_JANITOR_INTERVAL_DEFAULT_MS,
      batchSize: STORE_JANITOR_BATCH_DEFAULT,
    });
    expect(readStoreJanitorConfig(projectDir, warn)).toEqual({});
    expect(warnings).toEqual([]);
    expect(readdirSync(projectDir)).toEqual([]);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi"))).toBe(false);
  });

  it("resolves global, then project, then env, per key", async () => {
    await seedGlobalConfig({
      store: { janitor: "off", janitorIntervalMs: 3_600_000, janitorBatchSize: 8 },
    });
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "off",
      intervalMs: 3_600_000,
      batchSize: 8,
    });

    await seedProjectConfig({ store: { janitor: "on" } });
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "on",
      intervalMs: 3_600_000,
      batchSize: 8,
    });

    await seedProjectConfig({
      store: { janitor: "on", janitorIntervalMs: 86_400_000, janitorBatchSize: 64 },
    });
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "on",
      intervalMs: 86_400_000,
      batchSize: 64,
    });

    process.env[STORE_JANITOR_ENV_VAR] = "  OFF  ";
    process.env[STORE_JANITOR_INTERVAL_ENV_VAR] = "  60000  ";
    process.env[STORE_JANITOR_BATCH_ENV_VAR] = "16";
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "off",
      intervalMs: 60_000,
      batchSize: 16,
    });
    expect(warnings).toEqual([]);
  });

  it("resolves each key from its own rung, so one rung's key never masks another's", async () => {
    await seedGlobalConfig({ store: { janitorIntervalMs: 5_000 } });
    await seedProjectConfig({ store: { janitorBatchSize: 7 } });
    process.env[STORE_JANITOR_ENV_VAR] = "off";

    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "off",
      intervalMs: 5_000,
      batchSize: 7,
    });
    expect(readStoreJanitorConfig(projectDir, warn)).toEqual({
      project: { batchSize: 7 },
      global: { intervalMs: 5_000 },
    });
  });

  it("ignores an env value outside its accepted shape and keeps the file's answer", async () => {
    await seedProjectConfig({
      store: { janitor: "off", janitorIntervalMs: 1_000, janitorBatchSize: 3 },
    });
    const fileAnswer: StoreJanitorSettings = { mode: "off", intervalMs: 1_000, batchSize: 3 };

    for (const bogus of ["maybe", "on off", "1", "", "   "]) {
      process.env[STORE_JANITOR_ENV_VAR] = bogus;
      expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(fileAnswer);
    }
    delete process.env[STORE_JANITOR_ENV_VAR];

    for (const bogus of ["0", "-5", "1.5", "3600000ms", "abc", ""]) {
      process.env[STORE_JANITOR_INTERVAL_ENV_VAR] = bogus;
      process.env[STORE_JANITOR_BATCH_ENV_VAR] = bogus;
      expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(fileAnswer);
    }

    process.env[STORE_JANITOR_ENV_VAR] = "ON";
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({ ...fileAnswer, mode: "on" });
  });

  it("ignores a file value outside its accepted shape and keeps the other rung's answer", async () => {
    await seedGlobalConfig({ store: { janitor: "off" } });
    await seedProjectConfig({
      store: { janitor: "maybe", janitorIntervalMs: -1, janitorBatchSize: 0 },
    });

    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "off",
      intervalMs: STORE_JANITOR_INTERVAL_DEFAULT_MS,
      batchSize: STORE_JANITOR_BATCH_DEFAULT,
    });
    expect(warnings).toEqual([]);
  });
});

describe("resolveStoreJanitorSettings — a broken file degrades with a warning", () => {
  it("reads a malformed file as defaults, warns exactly once and throws nothing", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");

    let resolved: StoreJanitorSettings | undefined;
    expect(() => {
      resolved = resolveStoreJanitorSettings(projectDir, warn);
    }).not.toThrow();
    expect(resolved).toEqual(STORE_JANITOR_DEFAULTS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });

  it("warns once per scope that exists but cannot be used, and names each file", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await mkdir(join(homeDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "]]]", "utf-8");
    await writeFile(globalConfigPath(), '{"store": ', "utf-8");

    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(STORE_JANITOR_DEFAULTS);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((line) => line.includes(projectConfigPath()))).toBe(true);
    expect(warnings.some((line) => line.includes(globalConfigPath()))).toBe(true);
  });

  it("warns for a root that is not a JSON object", async () => {
    await seedProjectConfig([{ store: { janitor: "off" } }]);
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(STORE_JANITOR_DEFAULTS);
    expect(warnings).toHaveLength(1);
  });

  it("reads an unreadable config path (a directory) as defaults with one warning", () => {
    mkdirSync(projectConfigPath(), { recursive: true });
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(STORE_JANITOR_DEFAULTS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(projectConfigPath());
  });

  it("warns nobody about a missing file and stays silent when no warning channel is passed", async () => {
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual(STORE_JANITOR_DEFAULTS);
    expect(warnings).toEqual([]);

    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");
    expect(() => resolveStoreJanitorSettings(projectDir)).not.toThrow();
    expect(warnings).toEqual([]);
  });
});

describe("the store directory is not configurable from the file", () => {
  it("ignores store.dir and leaves the store path on PI_BETTER_EDIT_CONFIG_DIR alone", async () => {
    const dirBefore = configDir();
    const storeBefore = hashStorePath();
    await seedProjectConfig({
      store: { dir: join(root, "elsewhere"), janitor: "off", janitorBatchSize: 2 },
    });

    const settings = resolveStoreJanitorSettings(projectDir, warn);
    expect(settings).toEqual({
      mode: "off",
      intervalMs: STORE_JANITOR_INTERVAL_DEFAULT_MS,
      batchSize: 2,
    });
    expect(configDir()).toBe(dirBefore);
    expect(hashStorePath()).toBe(storeBefore);
    expect(Object.keys(settings)).not.toContain("dir");
    expect(readStoreJanitorConfig(projectDir, warn).project).not.toHaveProperty("dir");
    expect(existsSync(join(root, "elsewhere"))).toBe(false);
  });

  it("names no dir property in the published schema and keeps the defaults in step", () => {
    const schema = readJson(join(process.cwd(), "schemas", "pi-better-edit.json")) as {
      additionalProperties?: unknown;
      properties?: {
        store?: { additionalProperties?: unknown; properties?: Record<string, unknown> };
      };
    };
    expect(schema.additionalProperties).toBe(true);
    const store = schema.properties?.store;
    expect(store?.additionalProperties).toBe(true);
    expect(Object.keys(store?.properties ?? {})).toEqual([
      "janitor",
      "janitorIntervalMs",
      "janitorBatchSize",
    ]);
    expect(store?.properties).toEqual({
      janitor: { type: "string", enum: ["on", "off"], default: "on" },
      janitorIntervalMs: {
        type: "integer",
        minimum: 1,
        default: STORE_JANITOR_INTERVAL_DEFAULT_MS,
      },
      janitorBatchSize: { type: "integer", minimum: 1, default: STORE_JANITOR_BATCH_DEFAULT },
    });
  });
});

describe("resolveStoreJanitorSettingsWithSources — the rung each key came from", () => {
  it("names the rung per key, so one rung's key never masks another's", async () => {
    expect(resolveStoreJanitorSettingsWithSources(projectDir, warn)).toEqual({
      mode: { value: "on", source: "default" },
      intervalMs: { value: STORE_JANITOR_INTERVAL_DEFAULT_MS, source: "default" },
      batchSize: { value: STORE_JANITOR_BATCH_DEFAULT, source: "default" },
    });

    await seedGlobalConfig({ store: { janitorIntervalMs: 5_000 } });
    await seedProjectConfig({ store: { janitorBatchSize: 7 } });
    process.env[STORE_JANITOR_ENV_VAR] = "off";

    expect(resolveStoreJanitorSettingsWithSources(projectDir, warn)).toEqual({
      mode: { value: "off", source: "env" },
      intervalMs: { value: 5_000, source: "global" },
      batchSize: { value: 7, source: "project" },
    });

    // The value-only view is the same ladder, so the two views must agree key for key.
    const resolved = resolveStoreJanitorSettingsWithSources(projectDir, warn);
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: resolved.mode.value,
      intervalMs: resolved.intervalMs.value,
      batchSize: resolved.batchSize.value,
    });
  });

  it("names the default rung for a key no rung answered, next to the keys that did", async () => {
    await seedProjectConfig({ store: { janitor: "off" } });

    expect(resolveStoreJanitorSettingsWithSources(projectDir, warn)).toEqual({
      mode: { value: "off", source: "project" },
      intervalMs: { value: STORE_JANITOR_INTERVAL_DEFAULT_MS, source: "default" },
      batchSize: { value: STORE_JANITOR_BATCH_DEFAULT, source: "default" },
    });
  });

  it("resolves an unusable file to the default rungs and still warns once", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "{ not json", "utf-8");

    expect(resolveStoreJanitorSettingsWithSources(projectDir, warn)).toEqual({
      mode: { value: "on", source: "default" },
      intervalMs: { value: STORE_JANITOR_INTERVAL_DEFAULT_MS, source: "default" },
      batchSize: { value: STORE_JANITOR_BATCH_DEFAULT, source: "default" },
    });
    expect(warnings).toHaveLength(1);
  });
});

describe("saveStoreJanitorConfig", () => {
  it("creates the directory and writes the canonical shape with a trailing newline", () => {
    const { path } = saveStoreJanitorConfig({ mode: "off" }, "project", projectDir);
    expect(path).toBe(projectConfigPath());
    expect(readFileSync(path, "utf-8")).toBe(
      `${JSON.stringify({ $schema: CONFIG_SCHEMA_ID, store: { janitor: "off" } }, null, 2)}\n`,
    );
    expect(readdirSync(join(projectDir, ".pi", "agents"))).toEqual(["pi-better-edit.json"]);
    expect(resolveStoreJanitorSettings(projectDir, warn)).toEqual({
      mode: "off",
      intervalMs: STORE_JANITOR_INTERVAL_DEFAULT_MS,
      batchSize: STORE_JANITOR_BATCH_DEFAULT,
    });
  });

  it("preserves unknown keys, sibling store keys, the lens block and a custom $schema", async () => {
    await seedProjectConfig({
      $schema: "http://localhost/local-schema.json",
      lens: { bridge: "on", other: true },
      store: { janitor: "on", extra: { keep: 1 } },
      extra: { keep: 1 },
    });

    saveStoreJanitorConfig({ intervalMs: 900, batchSize: 2 }, "project", projectDir);

    expect(readJson(projectConfigPath())).toEqual({
      $schema: "http://localhost/local-schema.json",
      lens: { bridge: "on", other: true },
      store: { janitor: "on", extra: { keep: 1 }, janitorIntervalMs: 900, janitorBatchSize: 2 },
      extra: { keep: 1 },
    });
  });

  it("rewrites a canonical file when the existing one is unparseable or not an object", async () => {
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeFile(projectConfigPath(), "]]]", "utf-8");
    saveStoreJanitorConfig({ mode: "on" }, "project", projectDir);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: CONFIG_SCHEMA_ID,
      store: { janitor: "on" },
    });

    await writeFile(projectConfigPath(), JSON.stringify({ store: "on", keep: 1 }), "utf-8");
    saveStoreJanitorConfig({ intervalMs: 5 }, "project", projectDir);
    expect(readJson(projectConfigPath())).toEqual({
      $schema: CONFIG_SCHEMA_ID,
      store: { janitorIntervalMs: 5 },
      keep: 1,
    });
  });

  it("writes the global scope under HOME and leaves the project scope alone", () => {
    const { path } = saveStoreJanitorConfig({ mode: "off", batchSize: 4 }, "global", projectDir);
    expect(path).toBe(globalConfigPath());
    expect(readJson(globalConfigPath())).toEqual({
      $schema: CONFIG_SCHEMA_ID,
      store: { janitor: "off", janitorBatchSize: 4 },
    });
    expect(readStoreJanitorConfig(projectDir, warn)).toEqual({
      global: { mode: "off", batchSize: 4 },
    });
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("rejects a value or scope outside its accepted shape with E_INTERNAL_INVARIANT and writes nothing", () => {
    const bad: StoreJanitorScopeSettings[] = [
      { mode: "maybe" as StoreJanitorMode },
      { intervalMs: 0 },
      { intervalMs: 1.5 },
      { batchSize: -1 },
      { batchSize: 2.5 },
    ];
    for (const settings of bad) {
      expect(() => saveStoreJanitorConfig(settings, "project", projectDir)).toThrowError(
        /E_INTERNAL_INVARIANT/,
      );
    }
    expect(() =>
      saveStoreJanitorConfig(
        { mode: "on" },
        "mars" as Parameters<typeof saveStoreJanitorConfig>[1],
        projectDir,
      ),
    ).toThrowError(/E_INTERNAL_INVARIANT/);

    let caught: unknown;
    try {
      saveStoreJanitorConfig({ intervalMs: 0 }, "project", projectDir);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(readdirSync(projectDir)).toEqual([]);
    expect(existsSync(projectConfigPath())).toBe(false);
  });
});
