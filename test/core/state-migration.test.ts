import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateRoot } from "../../src/config-dir";
import { diagnosticsLogPath, reportInfo } from "../../src/diagnostics";
import { DomainError } from "../../src/domain-errors";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { migrateLegacyState, STATE_MIGRATION_MARKER } from "../../src/state-migration";

/**
 * The state pass (#190): what moves, what is abandoned, what is deleted, and that none of it can
 * fail a tool call.
 *
 * WHY the marker is asserted directly: idempotence is the property that keeps this pass safe to
 * run from two different triggers (the first diagnostics write and the first store open), and the
 * marker file is the only record of it that survives a process.
 */
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-state-migration-"));
  home = join(root, "home");
  storeDir = join(root, "config");
  retired = join(home, ".config", "pi-better-edit");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = "";
  process.env.XDG_STATE_HOME = "";
  process.env.XDG_CONFIG_HOME = "";
  process.env.PI_BETTER_EDIT_CONFIG_DIR = storeDir;
  reports.length = 0;
});

afterEach(async () => {
  shutdownHashStore();
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

describe("state artifact adoption", () => {
  it("moves the legacy JSON store and the log pair into the state root", async () => {
    await seed(join(retired, "hash-store.json"), JSON.stringify({ version: 1, snapshots: {} }));
    await seed(join(retired, "diagnostics.log"), '{"message":"old"}\n');
    await seed(join(retired, "diagnostics.log.1"), '{"message":"older"}\n');

    migrateLegacyState(report);

    expect(existsSync(join(stateRoot(), "hash-store.json"))).toBe(true);
    expect(await readFile(join(stateRoot(), "diagnostics.log"), "utf-8")).toContain('"old"');
    expect(await readFile(join(stateRoot(), "diagnostics.log.1"), "utf-8")).toContain('"older"');
    expect(existsSync(join(retired, "diagnostics.log"))).toBe(false);
    expect(existsSync(join(stateRoot(), STATE_MIGRATION_MARKER))).toBe(true);
  });

  it("runs once: the marker stops a later pass from adopting anything new", async () => {
    migrateLegacyState(report);
    await seed(join(retired, "hash-store.json"), "late arrival");

    migrateLegacyState(report);

    expect(existsSync(join(retired, "hash-store.json"))).toBe(true);
    expect(existsSync(join(stateRoot(), "hash-store.json"))).toBe(false);
  });

  it("keeps the destination when both exist", async () => {
    await seed(join(stateRoot(), "diagnostics.log"), '{"message":"new"}\n');
    await seed(join(retired, "diagnostics.log"), '{"message":"old"}\n');

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "diagnostics.log"), "utf-8")).toContain('"new"');
    expect(existsSync(join(retired, "diagnostics.log"))).toBe(true);
  });

  it("names the abandoned store and leaves the whole trio in place", async () => {
    await seed(join(retired, "hash-store.sqlite"), "sqlite bytes");
    await seed(join(retired, "hash-store.sqlite-wal"), "wal bytes");
    await seed(join(retired, "hash-store.sqlite-shm"), "shm bytes");

    migrateLegacyState(report);

    for (const suffix of ["", "-wal", "-shm"] as const) {
      expect(existsSync(join(retired, `hash-store.sqlite${suffix}`))).toBe(true);
    }
    expect(existsSync(join(stateRoot(), "hash-store.sqlite"))).toBe(false);
    expect(reports.some((line) => line.includes(join(retired, "hash-store.sqlite")))).toBe(true);
  });

  it("moves artifacts out of the override's own root into <override>/state", async () => {
    // WHY: an override user's pre-change layout put every artifact directly in <override>; the new
    // WHY: layout puts them in <override>/state, so the override root is the strongest retired
    // WHY: source and its abandoned store is the one worth naming.
    await seed(join(storeDir, "hash-store.json"), JSON.stringify({ version: 1 }));
    await seed(join(storeDir, "diagnostics.log"), '{"message":"old"}\n');
    await seed(join(storeDir, "hash-store.sqlite"), "sqlite bytes");
    await seed(join(storeDir, "hash-store.sqlite-wal"), "wal bytes");

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toContain('"version"');
    expect(await readFile(join(stateRoot(), "diagnostics.log"), "utf-8")).toContain('"old"');
    expect(existsSync(join(storeDir, "hash-store.json"))).toBe(false);
    // The trio stays where the old session owns it, and the report names THAT path.
    expect(existsSync(join(storeDir, "hash-store.sqlite"))).toBe(true);
    expect(existsSync(join(stateRoot(), "hash-store.sqlite"))).toBe(false);
    expect(reports.some((line) => line.includes(join(storeDir, "hash-store.sqlite")))).toBe(true);
  });

  it("moves the first retired root that has the artifact, not a later one", async () => {
    await seed(join(storeDir, "hash-store.json"), "override copy");
    await seed(join(retired, "hash-store.json"), "home copy");

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toBe("override copy");
    expect(existsSync(join(retired, "hash-store.json"))).toBe(true);
  });

  it("adopts artifacts from an XDG_CONFIG_HOME-relocated retired directory", async () => {
    const xdgConfig = join(root, "xdg-config");
    const xdgRetired = join(xdgConfig, "pi-better-edit");
    process.env.XDG_CONFIG_HOME = xdgConfig;
    await seed(join(xdgRetired, "hash-store.json"), "xdg copy");

    migrateLegacyState(report);

    expect(await readFile(join(stateRoot(), "hash-store.json"), "utf-8")).toBe("xdg copy");
    expect(existsSync(join(xdgRetired, "hash-store.json"))).toBe(false);
  });

  it("deletes forensic dumps from every retired root", async () => {
    const xdgRetired = join(root, "xdg-config", "pi-better-edit");
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    const dumps = [
      join(storeDir, "hash-store.sqlite.corrupt-1"),
      join(xdgRetired, "hash-store.json.corrupt-2"),
      join(retired, "hash-store.sqlite.corrupt-3"),
    ];
    for (const dump of dumps) await seed(dump, "dump");

    migrateLegacyState(report);

    for (const dump of dumps) expect(existsSync(dump), dump).toBe(false);
  });

  it("deletes the forensic dumps of the abandoned store and nothing else", async () => {
    await seed(join(retired, "hash-store.sqlite.corrupt-1700000000000"), "dump");
    await seed(join(retired, "hash-store.json.corrupt-1700000000001"), "dump");
    await seed(join(retired, "keep-me.txt"), "not ours");

    migrateLegacyState(report);

    expect(existsSync(join(retired, "hash-store.sqlite.corrupt-1700000000000"))).toBe(false);
    expect(existsSync(join(retired, "hash-store.json.corrupt-1700000000001"))).toBe(false);
    expect(existsSync(join(retired, "keep-me.txt"))).toBe(true);
  });

  it("never throws when the state root cannot be created", async () => {
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "file", "utf-8");
    process.env.PI_BETTER_EDIT_CONFIG_DIR = join(blocker, "nested");

    expect(() => migrateLegacyState(report)).not.toThrow();
    expect(existsSync(join(stateRoot(), STATE_MIGRATION_MARKER))).toBe(false);
  });
});

describe("the pass under the diagnostics sink", () => {
  it("adopts the retired log before the first record is written", async () => {
    await seed(join(retired, "diagnostics.log"), '{"message":"from the old install"}\n');

    reportInfo("test", "first record after the upgrade");

    const content = await readFile(diagnosticsLogPath(), "utf-8");
    expect(content).toContain("from the old install");
    expect(content).toContain("first record after the upgrade");
    expect(existsSync(join(retired, "diagnostics.log"))).toBe(false);
  });
});

describe("the store's fail-fast on an unusable state root", () => {
  it("refuses a store-dependent call with [E_ACCESS] naming the state root", async () => {
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "file", "utf-8");
    process.env.PI_BETTER_EDIT_CONFIG_DIR = join(blocker, "nested");
    const blockedRoot = stateRoot();

    const failure = await loadHashStore().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).code).toBe("E_ACCESS");
    expect((failure as DomainError).message).toContain("[E_ACCESS]");
    expect((failure as DomainError).message).toContain(blockedRoot);
    // No fallback directory is created anywhere: the refusal is the whole response.
    expect(existsSync(blockedRoot)).toBe(false);
    expect(existsSync(join(blocker, "nested"))).toBe(false);
  });
});
