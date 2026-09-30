import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LENS_BRIDGE_ENV_VAR, LENS_CONFIG_REL } from "../../../src/integrations/pi-lens/config.js";
import {
  attachMutationBridgeAdapter,
  getMutationDropCountForTests,
  resetMutationDropCountForTests,
} from "../../../src/integrations/pi-lens/mutation-bridge-adapter.js";
import {
  addMutatedFileObserver,
  clearMutatedFileObserversForTests,
  notifyMutatedFile,
  type MutatedFileNotification,
} from "../../../src/mutated-files.js";

const BRIDGE_KEY = Symbol.for("pi-lens:mutation-bridge");
const FILE = "/tmp/pbe-mutation/file.ts";
const CONSUMER = "pi-better-edit";

let root = "";
let projectDir = "";
let homeDir = "";
let otherDir = "";
const savedHome = process.env.HOME;
const entries: Array<Record<string, unknown>> = [];
let previousBridge: unknown;

function installBridge(value: unknown): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = value;
}

function installRecordingBridge(options: { version?: unknown; accepted?: boolean } = {}): void {
  installBridge({
    version: options.version ?? 1,
    recordMutation: (entry: unknown): boolean => {
      entries.push(entry as Record<string, unknown>);
      return options.accepted ?? true;
    },
  });
}

function captureBridge(): unknown {
  return (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
}

function restoreBridge(previous: unknown): void {
  if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  else (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = previous;
}

function notify(overrides: Partial<MutatedFileNotification> = {}): void {
  notifyMutatedFile({
    filePath: FILE,
    kind: "edit",
    ranges: [{ startLine: 3, lineCount: 2 }],
    sourceTool: "edit",
    ...overrides,
  });
}

async function seedProjectMode(mode: string): Promise<void> {
  await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(projectDir, LENS_CONFIG_REL),
    JSON.stringify({ lens: { bridge: mode } }),
    "utf-8",
  );
}

async function seedGlobalMode(mode: string): Promise<void> {
  await mkdir(join(homeDir, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(homeDir, LENS_CONFIG_REL),
    JSON.stringify({ lens: { bridge: mode } }),
    "utf-8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-mutation-adapter-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  otherDir = join(root, "other");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  entries.length = 0;
  clearMutatedFileObserversForTests();
  resetMutationDropCountForTests();
  previousBridge = captureBridge();
});

afterEach(() => {
  restoreBridge(previousBridge);
  clearMutatedFileObserversForTests();
  resetMutationDropCountForTests();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  return rm(root, { recursive: true, force: true });
});

describe("attachMutationBridgeAdapter", () => {
  it("mirrors an edit as one recordMutation with the settled field names", async () => {
    installRecordingBridge();
    await seedProjectMode("on");
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });

    notify({
      ranges: [
        { startLine: 3, lineCount: 2 },
        { startLine: 9, lineCount: 1 },
      ],
    });

    expect(entries).toEqual([
      {
        filePath: FILE,
        kind: "edit",
        touchedLines: [3, 9],
        editRanges: [
          [3, 4],
          [9, 9],
        ],
        consumer: CONSUMER,
      },
    ]);
    expect(getMutationDropCountForTests()).toBe(0);
    detach();
  });

  it("omits both range fields for every whole-file shape, never sending an empty range list", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });

    notify({ kind: "write", ranges: [], sourceTool: "write" });
    notify({ kind: "edit", ranges: [], sourceTool: "undo_last_edit" });

    expect(entries).toEqual([
      { filePath: FILE, kind: "write", consumer: CONSUMER },
      { filePath: FILE, kind: "edit", consumer: CONSUMER },
    ]);
    for (const entry of entries) {
      // WHY: the bridge refuses an empty `editRanges` array outright, so the key must be absent.
      expect("editRanges" in entry).toBe(false);
      expect("touchedLines" in entry).toBe(false);
      expect("deferAutofix" in entry).toBe(false);
    }
    expect(getMutationDropCountForTests()).toBe(0);
    detach();
  });

  it("mirrors under the auto default and under on, and stays silent under off", async () => {
    installRecordingBridge();
    const autoAdapter = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    notify();
    expect(entries).toHaveLength(1);
    autoAdapter();

    await seedProjectMode("off");
    const projectOff = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    notify();
    expect(entries).toHaveLength(1);
    // WHY: an explicit `off` is a configuration choice, not a failed mirror, so it is not a drop.
    expect(getMutationDropCountForTests()).toBe(0);
    projectOff();

    await seedProjectMode("on");
    process.env[LENS_BRIDGE_ENV_VAR] = "off";
    const envOff = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    notify();
    expect(entries).toHaveLength(1);
    envOff();
    delete process.env[LENS_BRIDGE_ENV_VAR];
    const projectOn = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    notify();
    expect(entries).toHaveLength(2);
    projectOn();
  });

  it("refuses a malformed or absent bridge silently, counting one drop each", () => {
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";

    for (const bridge of [
      { version: 2, recordMutation: (): boolean => true },
      { version: 1, recordMutation: "nope" },
      { version: 1, recordMutation: null },
      { version: "1", recordMutation: (): boolean => true },
      null,
      "bridge",
      42,
    ]) {
      installBridge(bridge);
      expect(() => notify()).not.toThrow();
    }
    delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
    expect(() => notify()).not.toThrow();

    expect(entries).toEqual([]);
    expect(getMutationDropCountForTests()).toBe(8);
    detach();
  });

  it("swallows a throwing and a refusing bridge, and still notifies later observers", () => {
    installBridge({
      version: 1,
      recordMutation: (): boolean => {
        throw new Error("bridge exploded");
      },
    });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    const mirrored: MutatedFileNotification[] = [];
    const detachObserver = addMutatedFileObserver((notification) => mirrored.push(notification));

    expect(() => notify()).not.toThrow();
    expect(entries).toEqual([]);
    expect(getMutationDropCountForTests()).toBe(1);

    installRecordingBridge({ accepted: false });
    notify();

    expect(entries).toEqual([
      {
        filePath: FILE,
        kind: "edit",
        touchedLines: [3, 4],
        editRanges: [[3, 4]],
        consumer: CONSUMER,
      },
    ]);
    expect(getMutationDropCountForTests()).toBe(2);
    expect(mirrored).toEqual([
      {
        filePath: FILE,
        kind: "edit",
        ranges: [{ startLine: 3, lineCount: 2 }],
        sourceTool: "edit",
      },
      {
        filePath: FILE,
        kind: "edit",
        ranges: [{ startLine: 3, lineCount: 2 }],
        sourceTool: "edit",
      },
    ]);

    detachObserver();
    detach();
  });

  it("drops a payload that cannot be expressed as a valid range", () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });

    notify({ filePath: "src/relative.ts" });
    notify({ ranges: [{ startLine: 0, lineCount: 1 }] });
    notify({ ranges: [{ startLine: 5, lineCount: 0 }] });
    notify({ ranges: [{ startLine: 2.5, lineCount: 1 }] });

    expect(entries).toEqual([]);
    expect(getMutationDropCountForTests()).toBe(4);
    detach();
  });

  it("uses the injected cwd to pick which project config applies", async () => {
    installRecordingBridge();
    await seedGlobalMode("on");
    await seedProjectMode("off");

    const projectScoped = attachMutationBridgeAdapter({ getCwd: () => projectDir });
    const elsewhere = attachMutationBridgeAdapter({ getCwd: () => otherDir });

    notify();

    expect(entries).toHaveLength(1);
    projectScoped();
    elsewhere();
    expect(entries).toHaveLength(1);
  });

  it("stops delivery after detach and survives a repeated detach", () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachMutationBridgeAdapter({ getCwd: () => projectDir });

    notify();
    detach();
    detach();
    notify();

    expect(entries).toHaveLength(1);
  });
});
