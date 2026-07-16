import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupFlatIntegrationTest, useTestHome, getText, extractHash } from "../support/fixtures";

const home = useTestHome();

describe("flat mode replace — end-to-end", () => {
  it("reads a file and replaces a single line via flat mode", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const betaHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [betaHash, betaHash],
          content_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("replaces a range of lines via flat mode", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [bHash, cHash],
          content_lines: ["B", "C"],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nB\nC\nddd\n");
    });
  });

  it("deletes a range via flat mode", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [bHash, cHash],
          content_lines: [],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(editResult.content[0].text).toContain("Added 0 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\n");
    });
  });

  it("stale anchor rejection after edit in flat mode", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const firstText = getText(firstRead);
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [betaRef, betaRef],
          content_lines: ["BBB"],
        },
        undefined,
        undefined,
        ctx,
      );

      await expect(
        editTool.execute(
          "e2",
          {
            path: "sample.ts",
            hash_range_inclusive: [betaRef, betaRef],
            content_lines: ["BBB-AGAIN"],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);
    });
  });

  it("seeds content into an empty file via flat mode", async () => {
    await withTempFile("empty.ts", "", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "empty.ts" }, undefined, undefined, ctx);
      const emptyHash = getText(readResult).split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[A-Za-z0-9_-]{3}$/);

      await editTool.execute(
        "e1",
        {
          path: "empty.ts",
          hash_range_inclusive: [emptyHash, emptyHash],
          content_lines: ["first", "second"],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("first\nsecond");
    });
  });

  it("preserves CRLF line endings after flat mode edit", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupFlatIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "crlf.ts" }, undefined, undefined, ctx);
      const betaRef = getText(readResult)
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        {
          path: "crlf.ts",
          hash_range_inclusive: [betaRef, betaRef],
          content_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(content).toContain("\r\n");
    });
  });

  it("flat mode normalizes bulk changes array format via normReq", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupFlatIntegrationTest(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced");
      const { readFile } = await import("fs/promises");
      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });
});
