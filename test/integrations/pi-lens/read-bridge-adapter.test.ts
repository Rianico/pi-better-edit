import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LENS_BRIDGE_ENV_VAR, LENS_CONFIG_REL } from "../../../src/integrations/pi-lens/config.js";
import { attachReadBridgeAdapter } from "../../../src/integrations/pi-lens/read-bridge-adapter.js";
import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  notifyServedSpans,
  type ServedSpan,
  type ServedSpanNotification,
} from "../../../src/served-spans.js";

const BRIDGE_KEY = Symbol.for("pi-lens:read-bridge");
const FILE = "/tmp/pbe-adapter/file.ts";
const CONSUMER = "pi-better-edit";

let root = "";
let projectDir = "";
let homeDir = "";
let otherDir = "";
const savedHome = process.env.HOME;
const calls: Array<Record<string, unknown>> = [];

let previousBridge: unknown;

function installBridge(value: unknown): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = value;
}

function installRecordingBridge(version: unknown = 1): void {
  installBridge({
    version,
    recordRead: (entry: unknown): void => {
      calls.push(entry as Record<string, unknown>);
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

function notify(
  spans: ServedSpan[],
  filePath: string = FILE,
  source: ServedSpanNotification["source"] = "read",
): void {
  notifyServedSpans({ filePath, spans, source });
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
  root = await mkdtemp(join(tmpdir(), "pbe-lens-adapter-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  otherDir = join(root, "other");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  calls.length = 0;
  clearServedSpanObserversForTests();
  previousBridge = captureBridge();
});

afterEach(() => {
  restoreBridge(previousBridge);
  clearServedSpanObserversForTests();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  return rm(root, { recursive: true, force: true });
});

describe("attachReadBridgeAdapter", () => {
  it("mirrors every span as one recordRead with the settled field names", async () => {
    installRecordingBridge();
    await seedProjectMode("on");
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });

    notify(
      [
        { startLine: 3, lineCount: 2 },
        { startLine: 9, lineCount: 1 },
      ],
      FILE,
      "diff",
    );

    expect(calls).toEqual([
      { filePath: FILE, requestedOffset: 3, requestedLimit: 2, consumer: CONSUMER },
      { filePath: FILE, requestedOffset: 9, requestedLimit: 1, consumer: CONSUMER },
    ]);

    detach();
    notify([{ startLine: 1, lineCount: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it("mirrors under the auto default whenever a bridge is detected", () => {
    installRecordingBridge();
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });

    notify([{ startLine: 1, lineCount: 3 }]);

    expect(calls).toEqual([
      { filePath: FILE, requestedOffset: 1, requestedLimit: 3, consumer: CONSUMER },
    ]);
    detach();
  });

  it("stays silent when the project config or the env override turns the bridge off", async () => {
    installRecordingBridge();
    await seedProjectMode("off");
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });

    notify([{ startLine: 1, lineCount: 4 }]);
    expect(calls).toEqual([]);

    await seedProjectMode("on");
    process.env[LENS_BRIDGE_ENV_VAR] = "off";
    notify([{ startLine: 1, lineCount: 4 }]);
    expect(calls).toEqual([]);

    delete process.env[LENS_BRIDGE_ENV_VAR];
    notify([{ startLine: 1, lineCount: 4 }]);
    expect(calls).toHaveLength(1);
    detach();
  });

  it("refuses a malformed bridge silently and without throwing", () => {
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });
    process.env[LENS_BRIDGE_ENV_VAR] = "on";

    for (const bridge of [
      { version: 2, recordRead: (): void => undefined },
      { version: 1, recordRead: "nope" },
      { version: 1, recordRead: null },
      { version: "1", recordRead: (): void => undefined },
      null,
      "bridge",
      42,
    ]) {
      installBridge(bridge);
      expect(() => notify([{ startLine: 1, lineCount: 1 }])).not.toThrow();
    }

    expect(calls).toEqual([]);
    detach();
  });

  it("skips an empty span list and a relative file path", () => {
    installRecordingBridge();
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });

    notify([], FILE);
    notify([{ startLine: 1, lineCount: 1 }], "src/relative.ts");

    expect(calls).toEqual([]);
    detach();
  });

  it("swallows a throwing bridge and a throwing getCwd, leaving later observers notified", () => {
    installBridge({
      version: 1,
      recordRead: (): void => {
        throw new Error("bridge exploded");
      },
    });
    const detach = attachReadBridgeAdapter({ getCwd: () => projectDir });
    const mirrored: ServedSpanNotification[] = [];
    const detachObserver = addServedSpanObserver((notification) => mirrored.push(notification));

    expect(() => notify([{ startLine: 2, lineCount: 1 }])).not.toThrow();
    expect(calls).toEqual([]);
    expect(mirrored).toEqual([
      { filePath: FILE, spans: [{ startLine: 2, lineCount: 1 }], source: "read" },
    ]);
    detachObserver();
    detach();

    installRecordingBridge();
    const brokenCwd = attachReadBridgeAdapter({
      getCwd: () => {
        throw new Error("cwd unavailable");
      },
    });
    expect(() => notify([{ startLine: 1, lineCount: 1 }])).not.toThrow();
    expect(calls).toEqual([]);
    brokenCwd();
  });

  it("uses the injected cwd to pick which project config applies", async () => {
    installRecordingBridge();
    await seedGlobalMode("on");
    await seedProjectMode("off");

    const projectScoped = attachReadBridgeAdapter({ getCwd: () => projectDir });
    const elsewhere = attachReadBridgeAdapter({ getCwd: () => otherDir });

    notify([{ startLine: 1, lineCount: 1 }]);

    expect(calls).toEqual([
      { filePath: FILE, requestedOffset: 1, requestedLimit: 1, consumer: CONSUMER },
    ]);
    projectScoped();
    elsewhere();
    expect(calls).toHaveLength(1);
  });
});
