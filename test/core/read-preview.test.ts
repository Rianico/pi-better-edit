import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { fmtReadPreview } from "../../src/read";
import { setupTestHome } from "../support/fixtures";

let testPath: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestHome();
  testPath = s.testPath;
  cleanup = s.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("fmtReadPreview", () => {
  it("returns empty file marker for empty content", async () => {
    const result = await fmtReadPreview("", {}, undefined, testPath);
    expect(result.text).toContain("[File is empty. Use replace to insert content.]");
  });

  it("returns empty file marker for content with only newline", async () => {
    const result = await fmtReadPreview("\n", {}, undefined, testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9_\-]{3}│$/);
  });

  it("returns all lines when no offset or limit given", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", {}, undefined, testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
  });

  it("respects offset parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { offset: 2 }, undefined, testPath);
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│a");
  });

  it("respects limit parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│c");
  });

  it("shows pagination hint when limit is less than total lines", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, testPath);
    expect(result.text).toContain("[Showing lines 1-2 of 3. Use offset=3 to continue.]");
  });

  it("shows pagination hint when offset is beyond start", async () => {
    const result = await fmtReadPreview("a\nb\nc\nd\n", { offset: 2, limit: 2 }, undefined, testPath);
    expect(result.text).toContain("[Showing lines 2-3 of 4. Use offset=4 to continue.]");
  });

  it("rejects non-positive offset", async () => {
    await expect(fmtReadPreview("a\nb\nc\n", { offset: 0 } as any, undefined, testPath)).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limit", async () => {
    await expect(fmtReadPreview("a\nb\nc\n", { limit: 0 } as any, undefined, testPath)).rejects.toThrow("positive integer");
  });

  it("uses precomputed hashes when provided", async () => {
    const hashes = ["AAA", "BBB", "CCC"];
    const result = await fmtReadPreview("a\nb\nc\n", {}, hashes, testPath);
    expect(result.text).toContain("AAA│a");
    expect(result.text).toContain("BBB│b");
    expect(result.text).toContain("CCC│c");
  });
});
