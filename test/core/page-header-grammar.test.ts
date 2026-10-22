import { describe, expect, it } from "vitest";
import { formatPageHeader, formatSectionHeader } from "../../src/file-content/served-header.js";
import { setupReadTest, withTempFile } from "../support/fixtures";

// WHY: the header is the only page chrome (spec §4.4), and this table IS the contract: one bracket
// WHY: grammar for every seam, so a change here is a change to what the model reads.
describe("page chrome grammar (spec §4.4)", () => {
  it("names a whole file by its total", () => {
    expect(formatPageHeader({ file: "src/app.ts", totalLines: 40 })).toBe(
      "[src/app.ts (40 lines total)]",
    );
  });

  it("names a window by the range it showed plus the file's total", () => {
    expect(
      formatPageHeader({
        file: "src/app.ts",
        totalLines: 40,
        shownRange: { startLine: 1, endLine: 5 },
      }),
    ).toBe("[src/app.ts (lines 1-5 of 40 total)]");
  });

  it("drops a range that covers the whole file, because the count already states it", () => {
    expect(
      formatPageHeader({
        file: "src/app.ts",
        totalLines: 40,
        shownRange: { startLine: 1, endLine: 40 },
      }),
    ).toBe("[src/app.ts (40 lines total)]");
  });

  it("marks verbatim as the only mode marker", () => {
    expect(
      formatPageHeader({
        file: "notes.md",
        totalLines: 40,
        shownRange: { startLine: 1, endLine: 5 },
        verbatim: true,
      }),
    ).toBe("[notes.md (verbatim, lines 1-5 of 40 total)]");
    expect(formatPageHeader({ file: "notes.md", totalLines: 40, verbatim: true })).toBe(
      "[notes.md (verbatim, 40 lines total)]",
    );
  });

  it("says where a byte-cut page stopped", () => {
    expect(
      formatPageHeader({
        file: "src/app.ts",
        totalLines: 40,
        shownRange: { startLine: 1, endLine: 5 },
        stoppedAtBytes: 50 * 1024,
      }),
    ).toBe("[src/app.ts (lines 1-5 of 40 total; stopped at 50.0KB)]");
  });

  it("moves a seam label inside the bracket", () => {
    expect(
      formatPageHeader({
        label: "Auto-read",
        file: "src/big.txt",
        totalLines: 2500,
        shownRange: { startLine: 1, endLine: 2000 },
      }),
    ).toBe("[Auto-read: src/big.txt (lines 1-2000 of 2500 total)]");
    expect(formatPageHeader({ label: "Auto-read", file: "src/big.txt", totalLines: 1500 })).toBe(
      "[Auto-read: src/big.txt (1500 lines total)]",
    );
    expect(formatPageHeader({ label: "Bash view", file: "src/app.ts", totalLines: 40 })).toBe(
      "[Bash view: src/app.ts (40 lines total)]",
    );
  });

  it("names a multi-window section by its own range", () => {
    expect(formatSectionHeader(2, 3, 40)).toBe("[Lines 2-3 of 40 total]");
    expect(formatSectionHeader(2, 3, 40, 50 * 1024)).toBe(
      "[Lines 2-3 of 40 total; stopped at 50.0KB]",
    );
  });
});

describe("the read tool's page header", () => {
  it("reports the byte stop on a page the byte budget cut", async () => {
    // WHY: 800 lines of 100 bytes overrun pi's 50KB byte budget long before the line budget, so the
    // WHY: header must say where the page stopped — the footer that used to is gone.
    const content = Array.from(
      { length: 800 },
      (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(96)}`,
    ).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text.startsWith("[big.ts (lines 1-")).toBe(true);
      expect(text.split("\n")[0]).toMatch(
        /^\[big\.ts \(lines 1-\d+ of 800 total; stopped at 50\.0KB\)\]$/,
      );
      expect(text).not.toContain("Use windows");
    });
  });

  it("names a verbatim page's mode and range", async () => {
    const content = Array.from({ length: 4 }, (_, i) => `b${i}`).join("\n");
    await withTempFile("notes.md", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "notes.md", mode: "verbatim", windows: [{ offset: 2, limit: 2 }] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content?.[0]?.text).toBe("[notes.md (verbatim, lines 2-3 of 4 total)]\nb1\nb2");
    });
  });
});
