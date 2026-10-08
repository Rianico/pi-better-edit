import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LENS_BRIDGE_ENV_VAR, LENS_CONFIG_REL } from "../../../src/integrations/pi-lens/config.js";
import {
  attachIOBridgeAdapter,
  getIODropCountForTests,
  resetIODropCountForTests,
} from "../../../src/integrations/pi-lens/io-bridge-adapter.js";
import {
  addMutatedFileObserver,
  clearMutatedFileObserversForTests,
  notifyMutatedFile,
  type MutatedFileNotification,
} from "../../../src/mutated-files.js";
import {
  clearServedSpanObserversForTests,
  notifyServedSpans,
  type ServedSpan,
  type ServedSpanNotification,
} from "../../../src/served-spans.js";

const BRIDGE_KEY = Symbol.for("pi-lens:io-bridge");
const FILE = "/tmp/pbe-io-bridge/file.ts";
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
    version: options.version ?? 2,
    record: (entry: unknown): unknown => {
      entries.push(entry as Record<string, unknown>);
      if (options.accepted === false) {
        return {
          read: { accepted: false, reason: "ignored" },
          mutate: { accepted: false, reason: "ignored" },
        };
      }
      return { read: { accepted: true }, mutate: { accepted: true } };
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

function notifyMutation(overrides: Partial<MutatedFileNotification> = {}): void {
  notifyMutatedFile({
    filePath: FILE,
    kind: "edit",
    ranges: [{ startLine: 3, lineCount: 2 }],
    sourceTool: "edit",
    ...overrides,
  });
}

function notifyServed(
  spans: ServedSpan[],
  source: ServedSpanNotification["source"] = "read",
  content?: string,
): void {
  notifyServedSpans({
    filePath: FILE,
    spans,
    source,
    ...(content !== undefined ? { content } : {}),
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
  root = await mkdtemp(join(tmpdir(), "pbe-io-bridge-"));
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
  clearServedSpanObserversForTests();
  resetIODropCountForTests();
  previousBridge = captureBridge();
});

afterEach(() => {
  restoreBridge(previousBridge);
  clearMutatedFileObserversForTests();
  clearServedSpanObserversForTests();
  resetIODropCountForTests();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  return rm(root, { recursive: true, force: true });
});

describe("attachIOBridgeAdapter mutations", () => {
  it("records an edit as one single-facet mutate call with v2 edit ranges", async () => {
    installRecordingBridge();
    await seedProjectMode("on");
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyMutation({
      ranges: [
        { startLine: 3, lineCount: 2 },
        { startLine: 9, lineCount: 1 },
      ],
    });

    expect(entries).toEqual([
      {
        filePath: FILE,
        consumer: CONSUMER,
        mutate: {
          kind: "edit",
          ranges: [
            [3, 4],
            [9, 9],
          ],
        },
      },
    ]);
    const entry = entries[0] ?? {};
    expect("touchedLines" in entry).toBe(false);
    expect("writtenContent" in entry).toBe(false);
    expect(getIODropCountForTests()).toBe(0);
    detach();
  });

  it("maps every whole-file shape to a bare write facet, never an empty edit list", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyMutation({ kind: "write", ranges: [], sourceTool: "write" });
    notifyMutation({ kind: "edit", ranges: [], sourceTool: "undo_last_edit" });

    expect(entries).toEqual([
      { filePath: FILE, consumer: CONSUMER, mutate: { kind: "write" } },
      { filePath: FILE, consumer: CONSUMER, mutate: { kind: "write" } },
    ]);
    for (const entry of entries) {
      const mutate = entry.mutate as Record<string, unknown>;
      expect("ranges" in mutate).toBe(false);
      expect("writtenContent" in mutate).toBe(false);
    }
    expect(getIODropCountForTests()).toBe(0);
    detach();
  });

  it("drops a mutation that cannot be expressed as a valid range", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyMutation({ filePath: "src/relative.ts" });
    notifyMutation({ ranges: [{ startLine: 0, lineCount: 1 }] });
    notifyMutation({ ranges: [{ startLine: 5, lineCount: 0 }] });
    notifyMutation({ ranges: [{ startLine: 2.5, lineCount: 1 }] });

    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(4);
    detach();
  });
});

describe("attachIOBridgeAdapter reads", () => {
  it("slices caller content into one single-range call per span", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyServed(
      [
        { startLine: 3, lineCount: 2 },
        { startLine: 9, lineCount: 1 },
      ],
      "read",
      "a\nb\nc\nd\ne\nf\ng\nh\ni\n",
    );

    expect(entries).toEqual([
      {
        filePath: FILE,
        consumer: CONSUMER,
        read: { ranges: [[3, 4]], content: "c\nd" },
      },
      {
        filePath: FILE,
        consumer: CONSUMER,
        read: { ranges: [[9, 9]], content: "i" },
      },
    ]);
    for (const entry of entries) {
      expect("evidence" in (entry.read as Record<string, unknown>)).toBe(false);
    }
    expect(getIODropCountForTests()).toBe(0);
    detach();
  });

  it("drops a span whose caller slice fails instead of falling back to disk", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyServed(
      [
        { startLine: 1, lineCount: 1 },
        { startLine: 3, lineCount: 1 },
      ],
      "read",
      "a\nb\n",
    );

    expect(entries).toEqual([
      { filePath: FILE, consumer: CONSUMER, read: { ranges: [[1, 1]], content: "a" } },
    ]);
    expect(getIODropCountForTests()).toBe(1);
    detach();
  });

  it("batches every range of a text-less notification into ONE disk-evidence call", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyServed(
      [
        { startLine: 3, lineCount: 2 },
        { startLine: 9, lineCount: 1 },
      ],
      "diff",
    );

    expect(entries).toEqual([
      {
        filePath: FILE,
        consumer: CONSUMER,
        read: {
          ranges: [
            [3, 4],
            [9, 9],
          ],
          evidence: "disk",
        },
      },
    ]);
    expect(getIODropCountForTests()).toBe(0);
    detach();
  });

  it("drops the whole disk batch when any range is malformed", async () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyServed(
      [
        { startLine: 3, lineCount: 2 },
        { startLine: 0, lineCount: 1 },
      ],
      "diff",
    );

    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(1);
    detach();
  });

  it("skips an empty span list and a relative file path without counting a drop", () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyServed([], "read", "a\n");
    notifyServedSpans({
      filePath: "src/relative.ts",
      spans: [{ startLine: 1, lineCount: 1 }],
      source: "read",
    });

    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(0);
    detach();
  });

  it("counts a drop for an absent bridge on the read path too", () => {
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";

    notifyServed([{ startLine: 1, lineCount: 1 }], "read", "a\n");

    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(1);
    detach();
  });
});

describe("attachIOBridgeAdapter bridge failures", () => {
  it("counts one drop for an absent, shape-mismatched, refusing or throwing bridge", () => {
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";

    const bridges: unknown[] = [
      { version: 1, record: (): unknown => ({}) },
      { version: "2", record: (): unknown => ({}) },
      { version: 2, record: null },
      { version: 2, record: "nope" },
      { version: 2 },
      null,
      "bridge",
      42,
      {
        version: 2,
        record: (): unknown => {
          throw new Error("bridge exploded");
        },
      },
    ];
    for (const bridge of bridges) {
      installBridge(bridge);
      expect(() => notifyMutation()).not.toThrow();
    }
    delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
    expect(() => notifyMutation()).not.toThrow();

    installRecordingBridge({ accepted: false });
    expect(() => notifyMutation()).not.toThrow();

    expect(entries).toHaveLength(1);
    expect(getIODropCountForTests()).toBe(bridges.length + 2);
    detach();
  });

  it("swallows a throwing bridge and a throwing getCwd, leaving later observers notified", () => {
    installBridge({
      version: 2,
      record: (): unknown => {
        throw new Error("bridge exploded");
      },
    });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });
    const mirrored: MutatedFileNotification[] = [];
    const detachObserver = addMutatedFileObserver((notification) => mirrored.push(notification));

    expect(() => notifyMutation()).not.toThrow();
    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(1);
    expect(mirrored).toHaveLength(1);
    detachObserver();
    detach();

    installRecordingBridge();
    const brokenCwd = attachIOBridgeAdapter({
      getCwd: () => {
        throw new Error("cwd unavailable");
      },
    });
    expect(() => notifyMutation()).not.toThrow();
    expect(entries).toEqual([]);
    expect(getIODropCountForTests()).toBe(1);
    brokenCwd();
  });
});

describe("attachIOBridgeAdapter modes and lifecycle", () => {
  it("mirrors under the auto default and under on, and stays silent under off without a drop", async () => {
    installRecordingBridge();
    const autoAdapter = attachIOBridgeAdapter({ getCwd: () => projectDir });
    notifyMutation();
    expect(entries).toHaveLength(1);
    autoAdapter();

    await seedProjectMode("off");
    const projectOff = attachIOBridgeAdapter({ getCwd: () => projectDir });
    notifyMutation();
    expect(entries).toHaveLength(1);
    expect(getIODropCountForTests()).toBe(0);
    projectOff();

    await seedProjectMode("on");
    process.env[LENS_BRIDGE_ENV_VAR] = "off";
    const envOff = attachIOBridgeAdapter({ getCwd: () => projectDir });
    notifyMutation();
    expect(entries).toHaveLength(1);
    envOff();
    delete process.env[LENS_BRIDGE_ENV_VAR];
    const projectOn = attachIOBridgeAdapter({ getCwd: () => projectDir });
    notifyMutation();
    expect(entries).toHaveLength(2);
    projectOn();
  });

  it("uses the injected cwd to pick which project config applies", async () => {
    installRecordingBridge();
    await seedGlobalMode("on");
    await seedProjectMode("off");

    const projectScoped = attachIOBridgeAdapter({ getCwd: () => projectDir });
    const elsewhere = attachIOBridgeAdapter({ getCwd: () => otherDir });

    notifyMutation();

    expect(entries).toHaveLength(1);
    projectScoped();
    elsewhere();
    expect(entries).toHaveLength(1);
  });

  it("stops delivery on both seams after detach and survives a repeated detach", () => {
    installRecordingBridge();
    process.env[LENS_BRIDGE_ENV_VAR] = "on";
    const detach = attachIOBridgeAdapter({ getCwd: () => projectDir });

    notifyMutation();
    notifyServed([{ startLine: 1, lineCount: 1 }], "read", "a\n");
    detach();
    detach();
    notifyMutation();
    notifyServed([{ startLine: 1, lineCount: 1 }], "read", "a\n");

    expect(entries).toHaveLength(2);
  });
});
