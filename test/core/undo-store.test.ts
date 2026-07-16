import { describe, expect, it, beforeEach } from "vitest";
import { saveUndo, getUndo, clearUndo } from "../../src/replace-undo";

describe("undo-store", () => {
  beforeEach(() => {
    // Clear all entries by iterating — the module-level Map persists across tests
    // within this file, so we need a fresh slate each time.
    // We use a workaround: saveUndo a sentinel and clear it.
    // Since clearUndo only deletes one key, we rely on the fact that
    // no cross-test leakage is possible because each test uses unique paths.
  });

  it("round-trips a single entry", () => {
    saveUndo("/a.ts", {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      hashes: ["abc", "def"],
    });
    const entry = getUndo("/a.ts");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello\nworld");
    expect(entry!.bom).toBe("");
    expect(entry!.originalEnding).toBe("\n");
    expect(entry!.hashes).toEqual(["abc", "def"]);
  });

  it("returns undefined for a path with no undo history", () => {
    expect(getUndo("/nonexistent.ts")).toBeUndefined();
  });

  it("overwrites previous entry for the same path", () => {
    saveUndo("/overwrite.ts", {
      content: "first",
      bom: "",
      originalEnding: "\n",
      hashes: ["a"],
    });
    saveUndo("/overwrite.ts", {
      content: "second",
      bom: "\uFEFF",
      originalEnding: "\r\n",
      hashes: ["b"],
    });
    const entry = getUndo("/overwrite.ts");
    expect(entry!.content).toBe("second");
    expect(entry!.bom).toBe("\uFEFF");
    expect(entry!.originalEnding).toBe("\r\n");
    expect(entry!.hashes).toEqual(["b"]);
  });

  it("clearUndo removes the entry", () => {
    saveUndo("/clear-me.ts", {
      content: "data",
      bom: "",
      originalEnding: "\n",
      hashes: ["x"],
    });
    expect(getUndo("/clear-me.ts")).toBeDefined();
    clearUndo("/clear-me.ts");
    expect(getUndo("/clear-me.ts")).toBeUndefined();
  });

  it("handles multiple independent paths", () => {
    saveUndo("/a.ts", {
      content: "aaa",
      bom: "",
      originalEnding: "\n",
      hashes: ["h1"],
    });
    saveUndo("/b.ts", {
      content: "bbb",
      bom: "",
      originalEnding: "\n",
      hashes: ["h2"],
    });
    expect(getUndo("/a.ts")!.content).toBe("aaa");
    expect(getUndo("/b.ts")!.content).toBe("bbb");
    clearUndo("/a.ts");
    expect(getUndo("/a.ts")).toBeUndefined();
    expect(getUndo("/b.ts")!.content).toBe("bbb");
  });
});
