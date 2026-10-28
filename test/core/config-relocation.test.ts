import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsRoot } from "../../src/config-dir";
import { clearDiagnostics, readDiagnostics } from "../support/fixtures";
import { configFileDisplayPath, configFilePath, readScopeConfig } from "../../src/json-config";
import { readBashViewConfig } from "../../src/bash-view-config";

/**
 * The settings ladder after the relocation (#190).
 *
 * What these pin, in the order a user experiences it:
 *  1. an existing settings file at EITHER retired location is ADOPTED, not ignored — its keys
 *     still apply on the first run;
 *  2. the move is visible and reversible: new file written, every retired source renamed `.bak`,
 *     one record;
 *  3. the new file wins once it exists (the retired ones are then just history);
 *  4. a failed move still serves the settings it could read (the read side must not depend on the
 *     write side), and says so in the diagnostics log instead of the terminal;
 *  5. the project scope follows the same rule, and refuses to write at all in a tree that will not
 *     take the write.
 */
const RETIRED_XDG_REL = ".config/pi-better-edit/pi-better-edit.json";
const RETIRED_FLAT_REL = ".pi/agents/pi-better-edit.json";

let root = "";
let cwd = "";
let home = "";
let storeDir = "";
const savedHome = process.env.HOME;
const savedStoreDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedXdgState = process.env.XDG_STATE_HOME;

const retiredXdgPath = (): string => join(home, RETIRED_XDG_REL);
const retiredFlatPath = (): string => join(home, RETIRED_FLAT_REL);
const projectRetiredPath = (): string => join(cwd, RETIRED_FLAT_REL);
const newGlobalPath = (): string => join(storeDir, "settings.json");
const newProjectPath = (): string => join(cwd, ".pi/agents/pi-better-edit/settings.json");

async function seed(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-config-move-"));
  cwd = join(root, "project");
  home = join(root, "home");
  storeDir = join(root, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_STATE_HOME;
  process.env.PI_BETTER_EDIT_CONFIG_DIR = storeDir;
  clearDiagnostics();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStoreDir === undefined) delete process.env.PI_BETTER_EDIT_CONFIG_DIR;
  else process.env.PI_BETTER_EDIT_CONFIG_DIR = savedStoreDir;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdgState;
  await rm(root, { recursive: true, force: true });
});

describe("global settings relocation", () => {
  it("adopts a file left in the retired XDG config directory", async () => {
    await seed(retiredXdgPath(), { bash: { view: "off" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(await readFile(newGlobalPath(), "utf-8")).toContain('"view": "off"');
    expect(existsSync(retiredXdgPath())).toBe(false);
    expect(existsSync(`${retiredXdgPath()}.bak`)).toBe(true);
    expect(readDiagnostics().some((record) => record.message.includes("adopted settings"))).toBe(
      true,
    );
    // The second read takes the new file, so adoption happens once.
    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
  });

  it("falls through to the retired flat home file, and retires both sources", async () => {
    await seed(retiredXdgPath(), { bash: { view: "on" } });
    await seed(retiredFlatPath(), { bash: { view: "off" } });
    // The XDG file is the stronger retired rung, so its keys are the ones adopted.
    expect(readBashViewConfig(cwd)).toEqual({ global: "on" });
    expect(existsSync(`${retiredXdgPath()}.bak`)).toBe(true);
    expect(existsSync(`${retiredFlatPath()}.bak`)).toBe(true);
  });

  it("reads the retired flat file when the XDG one is absent", async () => {
    await seed(retiredFlatPath(), { bash: { view: "off" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(existsSync(`${retiredFlatPath()}.bak`)).toBe(true);
  });

  it("leaves the retired files alone once the new one exists", async () => {
    await seed(retiredXdgPath(), { bash: { view: "off" } });
    await seed(retiredFlatPath(), { bash: { view: "off" } });
    await mkdir(storeDir, { recursive: true });
    await writeFile(newGlobalPath(), JSON.stringify({ bash: { view: "on" } }), "utf-8");

    expect(readBashViewConfig(cwd)).toEqual({ global: "on" });
    expect(existsSync(retiredXdgPath())).toBe(true);
    expect(existsSync(retiredFlatPath())).toBe(true);
    expect(existsSync(`${retiredXdgPath()}.bak`)).toBe(false);
  });

  it("still serves the retired settings when the move cannot be written", async () => {
    await seed(retiredXdgPath(), { bash: { view: "off" } });
    // WHY: a DIRECTORY where the config file should be makes the adoption's write fail for real,
    // WHY: while the diagnostics log stays writable — so the warning it reports is observable.
    await mkdir(storeDir, { recursive: true });
    await mkdir(newGlobalPath());

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(existsSync(retiredXdgPath())).toBe(true);
    expect(existsSync(`${retiredXdgPath()}.bak`)).toBe(false);
    expect(
      readDiagnostics().some((record) => record.message.includes("could not adopt settings")),
    ).toBe(true);
  });

  it("reports the new locations, shortened to ~ only when they are under home", async () => {
    expect(configFilePath("global", cwd)).toBe(newGlobalPath());
    expect(configFileDisplayPath("global", cwd)).toBe(newGlobalPath());

    process.env.PI_BETTER_EDIT_CONFIG_DIR = "";
    expect(settingsRoot()).toBe(join(home, ".pi", "agent", "extensions", "pi-better-edit"));
    expect(configFileDisplayPath("global", cwd)).toBe(
      "~/.pi/agent/extensions/pi-better-edit/settings.json",
    );
  });

  it("resolves the project scope to the new settings file", () => {
    expect(configFilePath("project", cwd)).toBe(newProjectPath());
  });
});

describe("project settings relocation", () => {
  it("adopts the retired flat project file beside the new directory", async () => {
    await seed(projectRetiredPath(), { store: { janitor: "off" } });

    // The read is what adopts: the keys are served from the retired file on first use.
    expect(readScopeConfig("project", cwd)?.store).toEqual({ janitor: "off" });
    expect(await readFile(newProjectPath(), "utf-8")).toContain('"janitor": "off"');
    expect(existsSync(projectRetiredPath())).toBe(false);
    expect(existsSync(`${projectRetiredPath()}.bak`)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "serves the retired project file and retires nothing when the tree is not writable",
    async () => {
      await seed(projectRetiredPath(), { store: { janitor: "off" } });
      await chmod(join(cwd, ".pi", "agents"), 0o555);
      try {
        // The read side keeps working from the retired file; the write is the only part that fails.
        expect(configFilePath("project", cwd)).toBe(newProjectPath());
        await expect(readFile(newProjectPath(), "utf-8")).rejects.toThrow();
        expect(existsSync(projectRetiredPath())).toBe(true);
        expect(existsSync(`${projectRetiredPath()}.bak`)).toBe(false);
      } finally {
        await chmod(join(cwd, ".pi", "agents"), 0o755);
      }
    },
  );
});
