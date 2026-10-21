import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir } from "../../src/config-dir";
import { readDiagnostics } from "../support/fixtures";
import { CONFIG_FILE_NAME, configFileDisplayPath, configFilePath } from "../../src/json-config";
import { readBashViewConfig } from "../../src/bash-view-config";

/**
 * The global config moved out of `$HOME/.pi/agents/` into `configDir()`.
 *
 * What these pin, in the order a user experiences it:
 *  1. an existing global file is ADOPTED, not ignored — its keys still apply on the first run;
 *  2. the move is visible and reversible: new file written, old one renamed `.bak`, one record;
 *  3. the new file wins once both exist (the old one is then just history);
 *  4. a failed move still serves the settings it could read (the read side must not depend on the
 *     write side), and says so in the diagnostics log instead of the terminal.
 */
const LEGACY_REL = ".pi/agents/pi-better-edit.json";

let root = "";
let cwd = "";
let home = "";
let storeDir = "";
const savedHome = process.env.HOME;
const savedStoreDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;

const legacyPath = (): string => join(home, LEGACY_REL);
const newPath = (): string => join(storeDir, CONFIG_FILE_NAME);

async function seedLegacy(value: unknown): Promise<void> {
  await mkdir(join(home, ".pi", "agents"), { recursive: true });
  await writeFile(legacyPath(), JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-config-move-"));
  cwd = join(root, "project");
  home = join(root, "home");
  storeDir = join(root, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.PI_BETTER_EDIT_CONFIG_DIR = storeDir;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStoreDir === undefined) delete process.env.PI_BETTER_EDIT_CONFIG_DIR;
  else process.env.PI_BETTER_EDIT_CONFIG_DIR = savedStoreDir;
  await rm(root, { recursive: true, force: true });
});

describe("global config relocation", () => {
  it("adopts a file left at the retired global location", async () => {
    await seedLegacy({ bash: { view: "off" } });

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(await readFile(newPath(), "utf-8")).toContain('"view": "off"');
    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(`${legacyPath()}.bak`)).toBe(true);
    expect(
      readDiagnostics().some((record) => record.message.includes("adopted global config")),
    ).toBe(true);
    // The second read takes the new file, so adoption happens once.
    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
  });

  it("leaves the retired file alone once the new one exists", async () => {
    await seedLegacy({ bash: { view: "off" } });
    await mkdir(storeDir, { recursive: true });
    await writeFile(newPath(), JSON.stringify({ bash: { view: "on" } }), "utf-8");

    expect(readBashViewConfig(cwd)).toEqual({ global: "on" });
    expect(existsSync(legacyPath())).toBe(true);
    expect(existsSync(`${legacyPath()}.bak`)).toBe(false);
  });

  it("still serves the legacy settings when the move cannot be written", async () => {
    await seedLegacy({ bash: { view: "off" } });
    // WHY: a DIRECTORY where the config file should be makes the adoption's rename fail for real,
    // WHY: while the diagnostics log stays writable — so the warning it reports is observable.
    await mkdir(storeDir, { recursive: true });
    await mkdir(newPath());

    expect(readBashViewConfig(cwd)).toEqual({ global: "off" });
    expect(
      readDiagnostics().some((record) => record.message.includes("could not adopt global config")),
    ).toBe(true);
  });

  it("reports the new location, shortened to ~ only when it is under home", async () => {
    expect(configFilePath("global", cwd)).toBe(newPath());
    expect(configFileDisplayPath("global", cwd)).toBe(newPath());
    process.env.PI_BETTER_EDIT_CONFIG_DIR = join(home, ".config", "pi-better-edit");
    expect(configDir()).toBe(join(home, ".config", "pi-better-edit"));
    expect(configFileDisplayPath("global", cwd)).toBe(
      `~/.config/pi-better-edit/${CONFIG_FILE_NAME}`,
    );
    // The project scope never moved.
    expect(configFilePath("project", cwd)).toBe(join(cwd, LEGACY_REL));
  });
});
