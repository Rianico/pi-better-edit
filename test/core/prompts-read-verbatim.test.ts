import { describe, expect, it } from "vitest";
import { loadGuide, loadP } from "../../src/prompts";

describe("read prompts serve mode: verbatim", () => {
  it("loads the new read.md description with the mode choice", () => {
    const description = loadP("../prompts/read.md");
    expect(description).toContain('mode: "verbatim"');
    expect(description).toContain("HASH│content");
    expect(description).not.toContain("{{");
    expect(description).not.toContain("shares the 238,328-line");
    expect(description).toContain("is not capped");
  });

  it("loads six read guidelines including the verbatim, image and widening bullets", () => {
    const guidelines = loadGuide("../prompts/read-guidelines.md");
    expect(guidelines).toHaveLength(6);
    expect(guidelines.some((guideline) => guideline.includes("never served"))).toBe(true);
    expect(guidelines.some((guideline) => guideline.includes('mode: "verbatim"'))).toBe(true);
    // WHY: image support recovered (PR #52) — the restored contract names the image-attachment return.
    expect(guidelines.some((guideline) => guideline.includes("image attachment"))).toBe(true);
    expect(guidelines.some((guideline) => guideline.includes("widened"))).toBe(true);
    expect(guidelines.some((guideline) => guideline.includes("re-read"))).toBe(false);
  });

  it("loads the snippet with the mode choice", () => {
    const snippet = loadP("../prompts/read-snippet.md");
    expect(snippet).toContain('mode: "verbatim"');
    expect(snippet).toContain("HASH│content");
  });
});
