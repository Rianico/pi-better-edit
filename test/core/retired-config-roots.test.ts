/**
 * The retired per-user roots are a SET, not a list (#190).
 *
 * `retiredConfigRoots()` answers "where might the pre-relocation files be", and two of its rungs can
 * name the SAME directory: with `$XDG_CONFIG_HOME` unset it resolves to `<home>/.config`, which is
 * also the last rung. The pass over those roots is not read-only — it DELETES `.corrupt-*` dumps and
 * reports the abandoned store — so a duplicated rung would visit one artifact twice: the second
 * delete fails on a file that is already gone and the operator is told the same thing twice. The
 * array length alone cannot show that, so the assertions below count the actual renames and the
 * actual lines the pass reports.
 *
 * WHY the rename count is taken through a pass-through spy on `node:fs`: the move is the only
 * action whose repetition is silent at the filesystem level (the destination already exists after
 * the first one), so counting calls is the only way to observe "visited once" rather than "ended up
 * right". The spy wraps the real implementation, so every rename below still happens for real.
 *
 * WHY a RELATIVE `$XDG_CONFIG_HOME` is pinned here: the retired side has to ignore it for the same
 * reason the new side never reads it — a relative base resolves against whatever cwd the host
 * process happens to have, so honouring it would make adoption read a directory that depends on
 * where the editor was started.
 */
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retiredConfigRoots, stateRoot } from "../../src/config-dir";
import { migrateLegacyState } from "../../src/state-migration";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

let root = "";
let home = "";
let storeDir = "";
let retired = "";
let project = "";
const savedCwd = process.cwd();
const reports: string[] = [];
const savedHome = process.env.HOME;
const savedStoreDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedXdgState = process.env.XDG_STATE_HOME;
const savedXdgConfig = process.env.XDG_CONFIG_HOME;

const report = (message: string): void => {
  reports.push(message);
};

const renames = () => vi.mocked(fs.renameSync);

/** How many times the pass READ a retired root — the only observable of a duplicate rung, because
 * every action inside the pass is tolerant of being asked to repeat itself. */
const visits = (dir: string): number =>
  vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => path === dir).length;
const linesMatching = (fragment: string): string[] =>
  reports.filter((line) => line.includes(fragment));

async function seed(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-retired-roots-"));
  home = join(root, "home");
  storeDir = join(root, "config");
  retired = join(home, ".config", "pi-better-edit");
  project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = "";
  process.env.XDG_STATE_HOME = "";
  process.env.XDG_CONFIG_HOME = "";
  process.env.PI_BETTER_EDIT_CONFIG_DIR = storeDir;
  reports.length = 0;
  renames().mockClear();
  vi.mocked(fs.readdirSync).mockClear();
});

afterEach(async () => {
  process.chdir(savedCwd);
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

describe("an unset XDG_CONFIG_HOME collapses to one retired root (#190)", () => {
  it("names <home>/.config/pi-better-edit exactly once", () => {
    const roots = retiredConfigRoots();

    expect(roots).toEqual([storeDir, join(home, ".config", "pi-better-edit")]);
    expect(roots.filter((base) => base === join(home, ".config", "pi-better-edit"))).toHaveLength(
      1,
    );
  });

  it("collapses to the single rung when the override is unset too", () => {
    process.env.PI_BETTER_EDIT_CONFIG_DIR = "";

    expect(retiredConfigRoots()).toEqual([join(home, ".config", "pi-better-edit")]);
  });

  it("moves and deletes each artifact of the collapsed root exactly once", async () => {
    await seed(join(retired, "hash-store.json"), "legacy json");
    await seed(join(retired, "hash-store.sqlite"), "sqlite bytes");
    await seed(join(retired, "hash-store.json.corrupt-1"), "dump");

    migrateLegacyState(report);

    expect(renames().mock.calls).toEqual([
      [join(retired, "hash-store.json"), join(stateRoot(), "hash-store.json")],
    ]);
    expect(visits(retired)).toBe(1);
    expect(linesMatching("moved ")).toHaveLength(1);
    expect(linesMatching("deleted abandoned store dump")).toHaveLength(1);
    expect(linesMatching("left the old store in place")).toHaveLength(1);
    expect(linesMatching("could not delete")).toEqual([]);
    expect(linesMatching("could not move")).toEqual([]);
    expect(existsSync(join(retired, "hash-store.json.corrupt-1"))).toBe(false);
    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toBe("legacy json");
  });
});

describe("a relative XDG_CONFIG_HOME is ignored on the retired side (#190)", () => {
  it("reads the home directory and never the cwd-relative one", async () => {
    const relativeBase = join("relative", "config");
    const relativeRetired = join(project, relativeBase, "pi-better-edit");
    await seed(join(relativeRetired, "hash-store.json"), "from the relative base");
    await seed(join(retired, "hash-store.json"), "from home");
    process.env.XDG_CONFIG_HOME = relativeBase;
    process.chdir(project);

    expect(retiredConfigRoots()).toContain(join(home, ".config", "pi-better-edit"));
    expect(retiredConfigRoots()).not.toContain(resolve(relativeBase, "pi-better-edit"));

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toBe("from home");
    expect(existsSync(join(relativeRetired, "hash-store.json"))).toBe(true);
    expect(reports.some((line) => line.includes(relativeRetired))).toBe(false);
  });
});
