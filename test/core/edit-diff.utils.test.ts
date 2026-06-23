import { describe, expect, it } from "vitest";
import { detectEnding, toLF, restoreEndings, stripBOM } from "../../src/replace-diff";

describe("detectEnding", () => {
  it("detects CRLF when \\r\\n appears first", () => {
    expect(detectEnding("hello\r\nworld")).toBe("\r\n");
  });

  it("defaults to LF when only \\n is present", () => {
    expect(detectEnding("hello\nworld")).toBe("\n");
  });

  it("detects CRLF when both exist but CRLF comes first", () => {
    expect(detectEnding("line1\r\nline2\nline3")).toBe("\r\n");
  });

  it("defaults to LF when no line endings exist", () => {
    expect(detectEnding("hello world")).toBe("\n");
  });

  it("defaults to LF for empty string", () => {
    expect(detectEnding("")).toBe("\n");
  });
});

describe("toLF", () => {
  it("converts \\r\\n to \\n", () => {
    expect(toLF("hello\r\nworld")).toBe("hello\nworld");
  });

  it("converts bare \\r to \\n", () => {
    expect(toLF("hello\rworld")).toBe("hello\nworld");
  });

  it("leaves already-LF text unchanged", () => {
    expect(toLF("hello\nworld")).toBe("hello\nworld");
  });

  it("handles mixed line endings", () => {
    expect(toLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("returns empty string for empty input", () => {
    expect(toLF("")).toBe("");
  });
});

describe("stripBOM", () => {
  it("strips \\uFEFF prefix", () => {
    const result = stripBOM("\uFEFFhello");
    expect(result).toEqual({ bom: "\uFEFF", text: "hello" });
  });

  it("returns empty bom when no BOM present", () => {
    const result = stripBOM("hello");
    expect(result).toEqual({ bom: "", text: "hello" });
  });

  it("handles empty string with BOM only", () => {
    const result = stripBOM("\uFEFF");
    expect(result).toEqual({ bom: "\uFEFF", text: "" });
  });

  it("handles plain empty string", () => {
    const result = stripBOM("");
    expect(result).toEqual({ bom: "", text: "" });
  });
});

describe("restoreEndings", () => {
  it("converts LF back to CRLF when original used CRLF", () => {
    expect(restoreEndings("hello\nworld", "\r\n")).toBe("hello\r\nworld");
  });

  it("leaves LF unchanged when original used LF", () => {
    expect(restoreEndings("hello\nworld", "\n")).toBe("hello\nworld");
  });

  it("handles empty string with CRLF target", () => {
    expect(restoreEndings("", "\r\n")).toBe("");
  });

  it("handles empty string with LF target", () => {
    expect(restoreEndings("", "\n")).toBe("");
  });

  it("handles multiple lines with CRLF target", () => {
    expect(restoreEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("preserves content without newlines", () => {
    expect(restoreEndings("hello", "\r\n")).toBe("hello");
    expect(restoreEndings("hello", "\n")).toBe("hello");
  });
});
