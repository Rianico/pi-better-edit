import { describe, expect, it } from "vitest";
import { editRequestFrom, EDIT_DESCRIPTION, EDIT_SNIPPET } from "../../src/payload-contract";

describe("Gemma 4 tool calling bleed", () => {
  it("EDIT_DESCRIPTION should not contain literal <|tool_call> that confuses Gemma tokenizer", () => {
    expect(EDIT_DESCRIPTION).not.toContain("<|tool_call>");
    expect(EDIT_SNIPPET).not.toContain("<|tool_call>");
    // Also should not contain path:<|> pattern that Gemma might copy
    expect(EDIT_DESCRIPTION).not.toContain("path:<|>");
  });

  it("editRequestFrom should normalize path with <|> quoting (Gemma bleed)", () => {
    const result = editRequestFrom({ path: "<|>Window.py<|>", edits: [["KZc", "jPR", ""]] });
    expect(result).not.toBeUndefined();
    expect(result?.path).toBe("Window.py");
  });

  it("editRequestFrom should normalize path with │ quoting", () => {
    const result = editRequestFrom({ path: "│Window.py│", edits: [["KZc", "jPR", ""]] });
    expect(result?.path).toBe("Window.py");
  });

  it("editRequestFrom should handle normal path unchanged", () => {
    const result = editRequestFrom({ path: "Window.py", edits: [["KZc", "jPR", ""]] });
    expect(result?.path).toBe("Window.py");
  });

  it("EDIT_DESCRIPTION should be concise for small models (under 800 chars)", () => {
    // Long verbose prompts confuse Gemma 4, keep description under 800 chars
    expect(EDIT_DESCRIPTION.length).toBeLessThan(800);
  });
});
