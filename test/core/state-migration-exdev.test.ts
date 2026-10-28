/**
 * The cross-device fallback and the marker's honesty (#190).
 *
 * WHY this is a separate file: reproducing `EXDEV` means intercepting `renameSync`, and the mock
 * below replaces `node:fs` for everything this file's module graph imports. Keeping it in its own
 * file keeps that blast radius off the ordinary migration suite, which asserts real filesystem
 * behaviour.
 *
 * What these pin:
 *  1. `rename` across filesystems is not a lost move — the bytes are copied and the source removed;
 *  2. a FAILED move does not write `.migration-v1`, so the next session retries instead of recording
 *     a partial pass as done;
 *  3. the abandoned SQLite trio is never copied, so the fallback can never fork a live store.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateRoot } from "../../src/config-dir";
import { migrateLegacyState, STATE_MIGRATION_MARKER } from "../../src/state-migration";

/**
 * `vi.hoisted` because the factory below runs before the module body; the test bodies then steer
 * the fake by mutating this object between calls.
 */
const control = vi.hoisted(() => ({
  renameFailure: null as string | null,
  copyFailure: null as string | null,
  renameCalls: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      control.renameCalls.push(from);
      if (control.renameFailure !== null) throw errno(control.renameFailure, from);
      actual.renameSync(from, to);
    },
    copyFileSync: (from: string, to: string) => {
      if (control.copyFailure !== null) throw errno(control.copyFailure, from);
      actual.copyFileSync(from, to);
    },
  };
});

function errno(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated failure, ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let root = "";
let home = "";
let storeDir = "";
let retired = "";
const reports: string[] = [];
const savedHome = process.env.HOME;
const savedStoreDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedXdgState = process.env.XDG_STATE_HOME;
const savedXdgConfig = process.env.XDG_CONFIG_HOME;

const report = (message: string): void => {
  reports.push(message);
};

async function seed(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

const markerPath = (): string => join(stateRoot(), STATE_MIGRATION_MARKER);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-state-exdev-"));
  home = join(root, "home");
  storeDir = join(root, "config");
  retired = join(home, ".config", "pi-better-edit");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = "";
  process.env.XDG_STATE_HOME = "";
  process.env.XDG_CONFIG_HOME = "";
  process.env.PI_BETTER_EDIT_CONFIG_DIR = storeDir;
  control.renameFailure = null;
  control.copyFailure = null;
  control.renameCalls.length = 0;
  reports.length = 0;
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

describe("a rename across filesystems", () => {
  it("copies the bytes and removes the source instead of losing the move", async () => {
    await seed(join(retired, "hash-store.json"), '{"version":1}');
    await seed(join(retired, "diagnostics.log"), '{"message":"old"}\n');
    control.renameFailure = "EXDEV";

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toContain('"version"');
    expect(existsSync(join(retired, "hash-store.json"))).toBe(false);
    expect(await readFile(join(stateRoot(), "diagnostics.log"), "utf-8")).toContain('"old"');
    expect(existsSync(join(retired, "diagnostics.log"))).toBe(false);
    // The copy is a completed move, so the pass may record itself as done.
    expect(existsSync(markerPath())).toBe(true);
  });
});

describe("a move that fails outright", () => {
  it("writes no marker, and the next pass retries and succeeds", async () => {
    await seed(join(retired, "hash-store.json"), '{"version":1}');
    control.renameFailure = "EXDEV";
    control.copyFailure = "ENOSPC";

    migrateLegacyState(report);

    expect(existsSync(join(stateRoot(), "hash-store.json"))).toBe(false);
    expect(existsSync(join(retired, "hash-store.json"))).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
    expect(reports.some((line) => /could not (?:move|copy)/.test(line))).toBe(true);

    // A fresh process (same directories, no marker) must try again rather than trust the half pass.
    control.renameFailure = null;
    control.copyFailure = null;
    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toContain('"version"');
    expect(existsSync(join(retired, "hash-store.json"))).toBe(false);
    expect(existsSync(markerPath())).toBe(true);
  });
});

describe("the abandoned SQLite trio", () => {
  it("is never moved, so the fallback cannot fork a live store", async () => {
    for (const suffix of ["", "-wal", "-shm"] as const) {
      await seed(join(retired, `hash-store.sqlite${suffix}`), "sqlite bytes");
    }
    control.renameFailure = "EXDEV";

    migrateLegacyState(report);

    for (const suffix of ["", "-wal", "-shm"] as const) {
      expect(existsSync(join(retired, `hash-store.sqlite${suffix}`))).toBe(true);
      expect(existsSync(join(stateRoot(), `hash-store.sqlite${suffix}`))).toBe(false);
      expect(control.renameCalls.filter((from) => from.includes("hash-store.sqlite"))).toEqual([]);
    }
  });
});
