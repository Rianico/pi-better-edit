import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The prompt surfaces once advertised third-party widening that could never fire for this tool:
 * pi-lens rewrites `input.offset`/`input.limit`, while the payload here is
 * `{ file, windows: [{ offset, limit }] }`. The claim also told the model to "pass limit above 100",
 * a parameter this schema does not have.
 *
 * The words that carried that claim stay forbidden here. A future, real expansion may describe
 * itself in this tool's own terms; it may not resurrect the capability of another extension or a
 * parameter that does not exist.
 */
const FORBIDDEN_CLAIMS = [
  "ast symbol",
  "markdown heading",
  "enclosing ast",
  "before this tool runs",
  "limit above 100",
  "interop:",
];

const PROMPT_SURFACES = ["prompts/read.md", "prompts/read-guidelines.md"];

describe("read prompts make no false widening claim", () => {
  it.each(PROMPT_SURFACES)("%s carries none of the retired widening words", (file) => {
    const text = readFileSync(file, "utf-8").toLowerCase();
    for (const claim of FORBIDDEN_CLAIMS) {
      expect(text, `${file} still claims "${claim}"`).not.toContain(claim);
    }
  });
});
