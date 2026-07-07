import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const replaceBulkPrompt = readFileSync(
  new URL("../../prompts/replace-bulk.md", import.meta.url),
  "utf-8",
);

const replaceFlatPrompt = readFileSync(
  new URL("../../prompts/replace-flat.md", import.meta.url),
  "utf-8",
);

describe("prompts/replace-bulk.md (bulk-mode model-facing contract)", () => {
  it("shows the end-to-end workflow with read", () => {
    expect(replaceBulkPrompt).toMatch(/Call `read` to get HASH anchors/);
    expect(replaceBulkPrompt).toMatch(/Copy the 3-character HASH/);
  });

  it("includes worked examples with changes array", () => {
    expect(replaceBulkPrompt).toMatch(/Single line replace/);
    expect(replaceBulkPrompt).toMatch(/Range replace/);
    expect(replaceBulkPrompt).toMatch(/Multiple regions in one call/);
    expect(replaceBulkPrompt).toContain('"content_lines": []');
    expect(replaceBulkPrompt).toContain('"changes"');
  });

  it("requires hash_range_inclusive pair", () => {
    expect(replaceBulkPrompt).toMatch(/hash_range_inclusive/i);
  });

  it("declares that edits must be non-conflicting", () => {
    expect(replaceBulkPrompt).toContain("[E_EDIT_CONFLICT]");
    expect(replaceBulkPrompt).toMatch(/non-conflicting/);
  });

  it("tells the model not to include HASH or line content in anchors", () => {
    expect(replaceBulkPrompt).toMatch(/Do not include.*│.*line content/i);
  });

  it("documents that response is empty after successful edit", () => {
    expect(replaceBulkPrompt).toContain("response text is empty");
  });

  it("documents error recovery", () => {
    expect(replaceBulkPrompt).toContain("[E_STALE_ANCHOR]");
    expect(replaceBulkPrompt).toContain("[E_BAD_REF]");
  });

  it("does not mention flat mode", () => {
    expect(replaceBulkPrompt).not.toMatch(/Flat mode/i);
    expect(replaceBulkPrompt).not.toMatch(/top.level/);
  });
});

describe("prompts/replace-flat.md (flat-mode model-facing contract)", () => {
  it("shows the end-to-end workflow with read", () => {
    expect(replaceFlatPrompt).toMatch(/Call `read` to get HASH anchors/);
    expect(replaceFlatPrompt).toMatch(/Copy the 3-character HASH/);
  });

  it("includes worked examples without changes array", () => {
    expect(replaceFlatPrompt).toMatch(/Single line replace/);
    expect(replaceFlatPrompt).toMatch(/Range replace/);
    expect(replaceFlatPrompt).not.toContain('"changes"');
  });

  it("requires hash_range_inclusive pair", () => {
    expect(replaceFlatPrompt).toMatch(/hash_range_inclusive/i);
  });

  it("documents that only one edit per call is allowed", () => {
    expect(replaceFlatPrompt).toMatch(/Only one edit per call/i);
  });

  it("tells the model not to include HASH or line content in anchors", () => {
    expect(replaceFlatPrompt).toMatch(/Do not include.*│.*line content/i);
  });

  it("documents that response is empty after successful edit", () => {
    expect(replaceFlatPrompt).toContain("response text is empty");
  });

  it("documents error recovery", () => {
    expect(replaceFlatPrompt).toContain("[E_STALE_ANCHOR]");
    expect(replaceFlatPrompt).toContain("[E_BAD_REF]");
  });

  it("does not describe the bulk format as an alternative", () => {
    expect(replaceFlatPrompt).not.toMatch(/Bulk mode/i);
    expect(replaceFlatPrompt).not.toMatch(/go inside a `changes` array/i);
    expect(replaceFlatPrompt).not.toMatch(/Multiple regions in one call/i);
  });
});

const readPrompt = readFileSync(
  new URL("../../prompts/read.md", import.meta.url),
  "utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
  it("declares the HASH|content output format", () => {
    expect(readPrompt).toMatch(/`HASH|content`/);
    expect(readPrompt).toMatch(/3 characters/);
  });

  it("specifies the URL-safe base64 alphabet", () => {
    expect(readPrompt).toContain("A-Za-z0-9-_");
  });

  it("documents pagination", () => {
    expect(readPrompt).toContain("pagination hint");
    expect(readPrompt).toMatch(/offset=N/);
  });

  it("documents file-kind handling", () => {
    expect(readPrompt).toMatch(/Images? \(JPEG, PNG, GIF, WebP\)/);
    expect(readPrompt).toMatch(/Binary/);
    expect(readPrompt).toMatch(/directories/);
  });
});
