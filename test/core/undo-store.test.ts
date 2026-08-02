import { describe, expect, it } from "vitest";
import { saveUndo, getUndo, clearUndo } from "../../src/replace-undo";

describe("undo-store", () => {
  it("round-trips a single entry", () => {
    saveUndo("/a.ts", {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      hashes: ["abc", "def"],
      resultContent: "hello\nworld!",
    });
    const entry = getUndo("/a.ts");
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello\nworld");
    expect(entry!.bom).toBe("");
    expect(entry!.originalEnding).toBe("\n");
    expect(entry!.hashes).toEqual(["abc", "def"]);
    expect(entry!.resultContent).toBe("hello\nworld!");
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
      resultContent: "first!",
    });
    saveUndo("/overwrite.ts", {
      content: "second",
      bom: "\uFEFF",
      originalEnding: "\r\n",
      hashes: ["b"],
      resultContent: "second!",
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
      resultContent: "data!",
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
      resultContent: "aaa!",
    });
    saveUndo("/b.ts", {
      content: "bbb",
      bom: "",
      originalEnding: "\n",
      hashes: ["h2"],
      resultContent: "bbb!",
    });
    expect(getUndo("/a.ts")!.content).toBe("aaa");
    expect(getUndo("/b.ts")!.content).toBe("bbb");
    clearUndo("/a.ts");
    expect(getUndo("/a.ts")).toBeUndefined();
    expect(getUndo("/b.ts")!.content).toBe("bbb");
  });
});
