import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../../src/prompts";

const replacePrompt = readFileSync(
  new URL("../../prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("declares the tool purpose", () => {
    expect(replacePrompt).toMatch(/Replace lines in a text file using HASH anchors/);
  });
});

const readPrompt = readFileSync(
  new URL("../../prompts/read.md", import.meta.url),
  "utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
  it("declares the HASH|content output format", () => {
    expect(readPrompt).toMatch(/HASH│content/);
    expect(readPrompt).toMatch(/3-char/);
  });

  it("specifies the URL-safe base64 hash length", () => {
    expect(readPrompt).toMatch(/3-char/);
  });

  it("documents pagination support", () => {
    expect(readPrompt).toContain("offset/limit");
  });

  it("documents file-kind handling", () => {
    expect(readPrompt).toMatch(/Images/);
    expect(readPrompt).toMatch(/Binary/);
    expect(readPrompt).toMatch(/directory/);
  });
});

describe("prompt guidelines", () => {
  it("replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("hash_range_inclusive");
    expect(content).not.toContain("{{");
  });

  it("loadGuide returns an array of guidelines", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md");
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);
  });

  it("read-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/read-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("{{");
  });

  it("undo-last-replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/undo-last-replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("{{");
  });
});
