import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../../src/prompts";
import { regRead } from "../../src/read";
import { makeFakePiRegistry } from "../support/fixtures";

const replacePrompt = readFileSync(
  new URL("../../prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("declares the tool purpose", () => {
    expect(replacePrompt).toMatch(/Replace a range of lines in a text file.*HASH anchors/);
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

  it("specifies the alphanumeric hash alphabet", () => {
    expect(readPrompt).toMatch(/3-char/);
    expect(readPrompt).toContain("alphanumeric");
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

  it("read-guidelines.md keeps the auto-read note as a template variable", () => {
    const content = readFileSync(
      new URL("../../prompts/read-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("{{AUTO_READ_NOTE}}");
  });
  it("undo-last-replace-guidelines.md loads without template variables", () => {
    const content = readFileSync(
      new URL("../../prompts/undo-last-replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).not.toContain("{{");
  });
});

describe("read tool guidelines follow auto-read", () => {
  it("drops the re-read note when auto-read is enabled (default)", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi);
    const tool = getTool("read");
    const guidelines = tool.promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("call `read` again after any edit"))).toBe(false);
    expect(guidelines.some((g) => g.includes("call before `replace`"))).toBe(true);
  });

  it("includes the re-read note when auto-read is disabled", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regRead(pi, { autoRead: false });
    const tool = getTool("read");
    const guidelines = tool.promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("call again after any edit"))).toBe(true);
  });
});
