import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { loadGuide } from "../../src/prompts";

const replacePrompt = readFileSync(
  new URL("../../prompts/replace.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
  it("shows the end-to-end workflow with read", () => {
    expect(replacePrompt).toMatch(/Replace lines in a text file using HASH anchors/);
    expect(replacePrompt).toMatch(/hash_range_inclusive/);
    expect(replacePrompt).toMatch(/content_lines/);
  });

  it("includes template placeholders for mode-specific content", () => {
    expect(replacePrompt).toContain("{{MODE_DESCRIPTION}}");
    expect(replacePrompt).toContain("{{AUTO_READ_GUIDANCE}}");
  });

  it("requires hash_range_inclusive pair", () => {
    expect(replacePrompt).toMatch(/hash_range_inclusive/i);
  });

  it("tells the model the anchor-only format for hash_range_inclusive", () => {
    expect(replacePrompt).toMatch(/hash_range_inclusive/);
    expect(replacePrompt).toMatch(/content_lines/);
  });

  it("documents line change summary after successful edit", () => {
    expect(replacePrompt).toContain("change summary");
  });

  it("documents change summary on success", () => {
    expect(replacePrompt).toContain("change summary");
  });

  it("contains MODE_DESCRIPTION template variable", () => {
    expect(replacePrompt).toContain("{{MODE_DESCRIPTION}}");
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

describe("prompt template variables (AUTO_READ_GUIDANCE)", () => {
  it("replace-guidelines.md contains the template variable", () => {
    const content = readFileSync(
      new URL("../../prompts/replace-guidelines.md", import.meta.url),
      "utf-8",
    );
    expect(content).toContain("{{AUTO_READ_GUIDANCE}}");
  });

  it("replace.md main description contains the template variable", () => {
    expect(replacePrompt).toContain("{{AUTO_READ_GUIDANCE}}");
  });

  it("loadGuide replaces AUTO_READ_GUIDANCE with read guidance when auto-read is off", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md", {
      AUTO_READ_GUIDANCE: "Call `read` to get fresh anchors for follow-up edits.",
      MODE_PREFIX: "- Use `replace` with HASH anchors for all file changes; batch every change to one file into a single `replace` call.",
    });
    const line = guidelines.find((g) => g.includes("Call `read` to get fresh anchors"));
    expect(line).toBeTruthy();
    expect(line).toContain("Call `read` to get fresh anchors for follow-up edits.");
  });

  it("loadGuide replaces AUTO_READ_GUIDANCE with auto-read message when auto-read is on", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md", {
      AUTO_READ_GUIDANCE: "Anchors are provided automatically after write operations when auto-read is enabled.",
      MODE_PREFIX: "- Use `replace` with HASH anchors for all file changes; batch every change to one file into a single `replace` call.",
    });
    const line = guidelines.find((g) => g.includes("Anchors are provided automatically"));
    expect(line).toBeTruthy();
    expect(line).toContain("Anchors are provided automatically after write operations when auto-read is enabled.");
  });

  it("loadGuide without replacements leaves template variable intact", () => {
    const guidelines = loadGuide("../prompts/replace-guidelines.md");
    const line = guidelines.find((g) => g.includes("{{AUTO_READ_GUIDANCE}}"));
    expect(line).toBeTruthy();
  });
});
