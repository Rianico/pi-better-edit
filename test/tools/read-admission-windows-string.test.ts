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

/**
 * The seam owns the contract sentence (#272). The union validator reports the outline variant's
 * missing `mode` beside a rejected `windows`, so a model that only wanted a served window reads
 * `mode: must have required properties mode` and never learns the window shapes; both the registered
 * tool path and the direct admission path speak this instead.
 */
const WINDOWS_CONTRACT =
  '"windows" must be an array of windows: [{ offset, limit }] or [{ around_anchor, radius }]. A JSON string is not an array.';

describe("read admission — JSON-stringified windows (#271)", () => {
  it("parses a stringified offset-window array before schema validation", () => {
    const prepared = normalizeReadPayload({
      file: "a.ts",
      windows: '[{"offset": 2, "limit": 2}]',
    });
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

  it("leaves a JSON value that is not an array to the contract refusal", () => {
    const prepared = normalizeReadPayload({ file: "a.ts", windows: '{"offset": 1}' });
    expect(typeof prepared.windows).toBe("string");
    expect(validator.Check(prepared)).toBe(false);
    expect(() => admitReadRequest(prepared)).toThrow(WINDOWS_CONTRACT);
  });

  it("leaves unparseable text to the contract refusal", () => {
    const prepared = normalizeReadPayload({ file: "a.ts", windows: "[{oops" });
    expect(typeof prepared.windows).toBe("string");
    expect(validator.Check(prepared)).toBe(false);
    expect(() => admitReadRequest(prepared)).toThrow(WINDOWS_CONTRACT);
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

describe("read admission — a non-array windows names the contract (#272)", () => {
  it("refuses a non-array windows on the registered tool path with the contract sentence", async () => {
    await withTempFile("a.ts", TWELVE, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const failure = await readTool
        .execute("r1", { file: "a.ts", windows: '{"offset": 1}' }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(failure?.message).toContain(WINDOWS_CONTRACT);
      expect(failure?.message).toContain("The read payload is not valid");
      expect(failure?.message).not.toContain("mode: must have required properties mode");
    });
  });

  it("throws the contract sentence from prepareArguments before the union validator runs", () => {
    const { readTool } = setupIntegrationTest("/tmp");
    expect(() => readTool.prepareArguments!({ file: "a.ts", windows: "[{oops" })).toThrow(
      WINDOWS_CONTRACT,
    );
    expect(() => readTool.prepareArguments!({ file: "a.ts", windows: { offset: 1 } })).toThrow(
      WINDOWS_CONTRACT,
    );
  });

  it("names the contract in a direct admitReadRequest refusal", () => {
    expect(() => admitReadRequest({ file: "a.ts", windows: "[{oops" })).toThrow(WINDOWS_CONTRACT);
    expect(() => admitReadRequest({ file: "a.ts", windows: '{"offset": 1}' })).toThrow(
      WINDOWS_CONTRACT,
    );
  });
});
