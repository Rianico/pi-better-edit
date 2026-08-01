import { describe, expect, it } from "vitest";
import { fmtRegion } from "../../src/hashline";
import { fmtReadPreview } from "../../src/read";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("fmtReadPreview", () => {
  it("returns all lines when no offset or limit given", async () => {
    const text = "alpha\nbeta\ngamma\n";
    const result = await fmtReadPreview(text, {}, undefined, home.testPath);
    expect(result.text).toContain("│alpha");
    expect(result.text).toContain("│beta");
    expect(result.text).toContain("│gamma");
  });

  it("hides the terminal newline sentinel from preview output", async () => {
    const text = "alpha\nbeta\n";
    const result = await fmtReadPreview(text, {}, undefined, home.testPath);
    expect(result.text).toContain("│alpha");
    expect(result.text).toContain("│beta");
    const lines = result.text.split("\n");
    const emptyContentLines = lines.filter((l) => /^[A-Za-z0-9_-]{3}│$/.test(l));
    expect(emptyContentLines).toHaveLength(0);
  });

  it("keeps continuation hints for partial previews", async () => {
    const text = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const result = await fmtReadPreview(text, { limit: 3 }, undefined, home.testPath);
    expect(result.text).toContain("[Showing lines 1-3 of 10. Use offset=4 to continue.]");
  });

  it("reports when offset is beyond end of content", async () => {
    const text = "a\nb\n";
    const result = await fmtReadPreview(text, { offset: 5 }, undefined, home.testPath);
    expect(result.text).toContain("Offset 5 is beyond end of file");
  });

  it("rejects fractional offsets", async () => {
    await expect(fmtReadPreview("a\nb\n", { offset: 1.5 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limits", async () => {
    await expect(fmtReadPreview("a\nb\n", { limit: 0 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });

describe("fmtRegion", () => {
  it("formats lines as HASH|content rows", () => {
    const result = fmtRegion(["ABC", "DEF"], ["hello", "world"]);
    expect(result).toBe("ABC│hello\nDEF│world");
  });

  it("does not pad line numbers (the format drops them)", () => {
    const result = fmtRegion(["X"], ["test"]);
    expect(result).toBe("X│test");
  });
});
});
