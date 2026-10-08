import { afterEach, describe, expect, it } from "vitest";

import {
  getIOBridge,
  IO_BRIDGE_VERSION,
  sliceSpanContent,
} from "../../../src/integrations/pi-lens/io-bridge.js";

const BRIDGE_KEY = Symbol.for("pi-lens:io-bridge");

let previousBridge: unknown;

function installBridge(value: unknown): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = value;
}

function captureBridge(): unknown {
  return (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
}

function restoreBridge(previous: unknown): void {
  if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  else (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = previous;
}

afterEach(() => {
  restoreBridge(previousBridge);
  previousBridge = undefined;
});

describe("getIOBridge", () => {
  it("returns the mounted bridge when the key holds a v2 bridge with a record method", () => {
    const bridge = {
      version: 2,
      record: (): { read: { accepted: true } } => ({ read: { accepted: true } }),
    };
    previousBridge = captureBridge();
    installBridge(bridge);

    expect(getIOBridge()).toBe(bridge);
    expect(IO_BRIDGE_VERSION).toBe(2);
  });

  it("returns undefined for an absent, non-object or shape-mismatched mount", () => {
    previousBridge = captureBridge();

    for (const value of [
      undefined,
      null,
      "bridge",
      42,
      { version: 1, record: (): { read: { accepted: true } } => ({ read: { accepted: true } }) },
      { version: "2", record: (): { read: { accepted: true } } => ({ read: { accepted: true } }) },
      { version: 2, record: null },
      { version: 2, record: "nope" },
      { version: 2 },
    ]) {
      installBridge(value);
      expect(getIOBridge(), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe("sliceSpanContent", () => {
  it("slices a single middle line", () => {
    expect(sliceSpanContent("alpha\nbeta\ngamma\n", 2, 1)).toBe("beta");
  });

  it("slices a multi-line run and joins it with LF", () => {
    expect(sliceSpanContent("alpha\nbeta\ngamma\ndelta\n", 2, 2)).toBe("beta\ngamma");
    expect(sliceSpanContent("alpha\nbeta\ngamma\ndelta", 1, 3)).toBe("alpha\nbeta\ngamma");
  });

  it("uses the bridge's CRLF line semantics", () => {
    expect(sliceSpanContent("a\r\nb\r\nc\r\n", 2, 1)).toBe("b");
    expect(sliceSpanContent("a\r\nb\r\nc", 1, 2)).toBe("a\nb");
  });

  it("keeps a blank line as an empty slice", () => {
    expect(sliceSpanContent("a\n\nb\n", 2, 1)).toBe("");
  });

  it("does not count the terminal newline as an extra line", () => {
    expect(sliceSpanContent("a\nb\n", 2, 1)).toBe("b");
    expect(sliceSpanContent("a\nb\n", 2, 2)).toBeUndefined();
  });

  it("fails rather than truncates when the text is shorter than the span claims", () => {
    expect(sliceSpanContent("a\nb\n", 3, 1)).toBeUndefined();
    expect(sliceSpanContent("a\nb\n", 2, 5)).toBeUndefined();
    expect(sliceSpanContent("", 1, 1)).toBe("");
    expect(sliceSpanContent("", 2, 1)).toBeUndefined();
  });

  it("rejects a non-integer, zero or negative line argument", () => {
    expect(sliceSpanContent("a\nb\n", 1.5, 1)).toBeUndefined();
    expect(sliceSpanContent("a\nb\n", 0, 1)).toBeUndefined();
    expect(sliceSpanContent("a\nb\n", -1, 1)).toBeUndefined();
    expect(sliceSpanContent("a\nb\n", 1, 0)).toBeUndefined();
    expect(sliceSpanContent("a\nb\n", 1, 2.5)).toBeUndefined();
  });
});
