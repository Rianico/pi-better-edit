import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { admitReadRequest, normalizeReadPayload } from "../../src/file-content/admission";
import { readToolSchema } from "../../src/read";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures";

const validator = Compile(readToolSchema);

/** Twelve addressable lines, so a two-line window is visibly narrower than the whole page. */
const TWELVE = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

function rowsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map((line) => line.split("│")[1]!);
}

// WHY (#271): a model can serialize `windows` as a JSON string. The schema requires an array, so
// WHY: the call is refused before `execute`, and the model falls back to a whole-file read — it pays
// WHY: for the failed window AND the whole page. The seam folds the string to an array BEFORE the
// WHY: schema sees it; anything that is not a JSON array keeps the existing array refusal.
describe("read admission — JSON-stringified windows (#271)", () => {
  it("parses a stringified offset-window array before schema validation", () => {
    const prepared = normalizeReadPayload({
      file: "a.ts",
      windows: '[{"offset": 2, "limit": 2}]',
    });
    // The seam hands the schema an array, so validation admits the call.
    expect(prepared.windows).toEqual([{ offset: 2, limit: 2 }]);
    expect(validator.Check(prepared)).toBe(true);
    expect(admitReadRequest(prepared).windows).toEqual([{ kind: "offset", offset: 2, limit: 2 }]);
  });

  it("parses a stringified around_anchor window before schema validation", () => {
    const prepared = normalizeReadPayload({
      file: "a.ts",
      windows: '[{"around_anchor": "ulQm", "radius": 10}]',
    });
    expect(prepared.windows).toEqual([{ around_anchor: "ulQm", radius: 10 }]);
    expect(validator.Check(prepared)).toBe(true);
    expect(admitReadRequest(prepared).windows).toEqual([
      { kind: "anchor", anchor: "ulQm", radius: 10 },
    ]);
  });

  it("leaves a JSON value that is not an array to the existing array refusal", () => {
    const prepared = normalizeReadPayload({ file: "a.ts", windows: '{"offset": 1}' });
    // Not an array: leave the value as-is so the downstream guard keeps its wording.
    expect(typeof prepared.windows).toBe("string");
    expect(validator.Check(prepared)).toBe(false);
    expect(() => admitReadRequest(prepared)).toThrow(
      'Read request field "windows" must be an array.',
    );
  });

  it("leaves unparseable text to the existing array refusal", () => {
    const prepared = normalizeReadPayload({ file: "a.ts", windows: "[{oops" });
    expect(typeof prepared.windows).toBe("string");
    expect(validator.Check(prepared)).toBe(false);
    expect(() => admitReadRequest(prepared)).toThrow(
      'Read request field "windows" must be an array.',
    );
  });

  it("reads the windowed rows a stringified payload names, not the whole file", async () => {
    await withTempFile("a.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = getText(
        await readTool.execute(
          "r1",
          { file: "a.ts", windows: '[{"offset": 2, "limit": 2}]' },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("(lines 2-3 of 12 total)");
      expect(rowsOf(text)).toEqual(["line 2", "line 3"]);
    });
  });
});
