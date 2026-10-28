import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsRoot, stateRoot } from "../../src/config-dir";
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
const savedXdgConfig = process.env.XDG_CONFIG_HOME;

const retiredXdgPath = (): string => join(home, RETIRED_XDG_REL);
const retiredFlatPath = (): string => join(home, RETIRED_FLAT_REL);
const projectRetiredPath = (): string => join(cwd, RETIRED_FLAT_REL);
const newGlobalPath = (): string => join(storeDir, "settings.json");
const newProjectPath = (): string => join(cwd, ".pi/agents/pi-better-edit/settings.json");
const retiredOverridePath = (): string => join(storeDir, "pi-better-edit.json");
const newStateRoot = (): string => join(storeDir, "state");

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
  process.env.XDG_CONFIG_HOME = "";
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
  if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdgConfig;
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

  it("adopts the settings file the override itself used to hold", async () => {
    // WHY: an override user's pre-change file was <override>/pi-better-edit.json — the directory
    // WHY: WAS both roots, so it is the strongest retired source for them, not an absent one.
    await seed(retiredOverridePath(), { bash: { view: "off" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(await readFile(newGlobalPath(), "utf-8")).toContain('"view": "off"');
    expect(existsSync(retiredOverridePath())).toBe(false);
    expect(existsSync(`${retiredOverridePath()}.bak`)).toBe(true);
  });

  it("prefers the override's retired file over the XDG and agents sources", async () => {
    await seed(retiredOverridePath(), { bash: { view: "off" } });
    await seed(retiredXdgPath(), { bash: { view: "on" } });
    await seed(retiredFlatPath(), { bash: { view: "on" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    // Every retired source retires, not only the winner: a loser left live would resurrect stale
    // settings the moment the new file went away.
    for (const source of [retiredOverridePath(), retiredXdgPath(), retiredFlatPath()]) {
      expect(existsSync(source), source).toBe(false);
      expect(existsSync(`${source}.bak`), source).toBe(true);
    }
  });

  it("adopts a file under an XDG_CONFIG_HOME-relocated retired directory", async () => {
    const xdgConfig = join(root, "xdg-config");
    process.env.XDG_CONFIG_HOME = xdgConfig;
    const relocated = join(xdgConfig, "pi-better-edit", "pi-better-edit.json");
    await seed(relocated, { bash: { view: "off" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(existsSync(relocated)).toBe(false);
    expect(existsSync(`${relocated}.bak`)).toBe(true);
  });

  it("never derives a NEW path from XDG_CONFIG_HOME", () => {
    // WHY: adoption is the only reader of the retired XDG base; the new layout is derived from the
    // WHY: override/agent dir and the state home, so a moved XDG base cannot move a written file.
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    const settings = configFilePath("global", cwd);
    const state = stateRoot();

    process.env.XDG_CONFIG_HOME = join(root, "other-xdg-config");

    expect(configFilePath("global", cwd)).toBe(settings);
    expect(stateRoot()).toBe(state);
    expect(settings).toBe(newGlobalPath());
    expect(state).toBe(newStateRoot());

    process.env.PI_BETTER_EDIT_CONFIG_DIR = "";
    expect(settingsRoot()).toBe(join(home, ".pi", "agent", "extensions", "pi-better-edit"));
    expect(stateRoot()).toBe(join(home, ".local", "state", "pi-better-edit"));
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
    "skips the project write entirely, silently, when the tree is not writable",
    async () => {
      await seed(projectRetiredPath(), { store: { janitor: "off" } });
      clearDiagnostics();
      await chmod(join(cwd, ".pi", "agents"), 0o555);
      try {
        // The read side keeps working from the retired file; the write is skipped BEFORE it is
        // attempted, so a read-only checkout pays neither a failed write nor a warning per session.
        expect(configFilePath("project", cwd)).toBe(newProjectPath());
        expect(readScopeConfig("project", cwd)?.store).toEqual({ janitor: "off" });
        expect(existsSync(newProjectPath())).toBe(false);
        expect(existsSync(projectRetiredPath())).toBe(true);
        expect(existsSync(`${projectRetiredPath()}.bak`)).toBe(false);
        // WHY no record at all: a failed adoption writes a warning naming the destination, so its
        // absence is the observable proof that the write was never attempted.
        expect(readDiagnostics().filter((r) => r.message.includes(newProjectPath()))).toEqual([]);
      } finally {
        await chmod(join(cwd, ".pi", "agents"), 0o755);
      }
    },
  );
});
