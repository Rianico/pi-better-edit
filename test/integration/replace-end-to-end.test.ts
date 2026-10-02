import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  withTempBytes,
  setupIntegrationTest,
  useTestHome,
  getText,
  extractHash,
} from "../support/fixtures";

const home = useTestHome();

describe("edit tool — end-to-end", () => {
  it("reads a file and edits a single line", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readResult).split("\n");
      const betaHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);

      const editResult = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: betaHash, anchor_to: betaHash, text: "BBB" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully edited");
      expect(editResult.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("edits a range of lines", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: bHash, anchor_to: cHash, text: "B\nC" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully edited");
      expect(editResult.content[0].text).toContain("Added 2 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\nB\nC\nddd\n");
    });
  });

  it("deletes a range", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const lines = getText(readResult).split("\n");
      const bHash = extractHash(lines.find((l: string) => l.includes("│bbb"))!);
      const cHash = extractHash(lines.find((l: string) => l.includes("│ccc"))!);

      const editResult = await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: bHash, anchor_to: cHash, text: "" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("Successfully edited");
      expect(editResult.content[0].text).toContain("Added 0 line(s), removed 2 line(s).");

      const content = await readFile(path, "utf-8");
      expect(content).toBe("aaa\n");
    });
  });

  it("retired anchor rejection after edit", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const firstText = getText(firstRead);
      const betaRef = firstText
        .split("\n")
        .find((line: string) => line.includes("│bbb"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { file: "sample.ts", edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "BBB" }] },
        undefined,
        undefined,
        ctx,
      );

      // The edited line's identity is retired with no live unshifted bound, so its old anchor is
      // [E_TARGET_LOST] with no rows, never [E_STALE_ANCHOR] (spec §3.1.1 line 89 / §5.3, ADR-0018).
      await expect(
        editTool.execute(
          "e2",
          {
            file: "sample.ts",
            edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "BBB-AGAIN" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[MODEL\] \[E_TARGET_LOST\]/);
    });
  });

  it("seeds content into an empty file", async () => {
    await withTempFile("empty.ts", "", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { path: "empty.ts" },
        undefined,
        undefined,
        ctx,
      );
      const emptyHash = getText(readResult).split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[A-Za-z0-9]{3}$/);

      await editTool.execute(
        "e1",
        {
          file: "empty.ts",
          edits: [{ anchor_from: emptyHash, anchor_to: emptyHash, text: "first\nsecond" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("first\nsecond");
    });
  });

  it("preserves CRLF line endings after edit", async () => {
    await withTempFile("crlf.ts", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute(
        "r1",
        { path: "crlf.ts" },
        undefined,
        undefined,
        ctx,
      );
      const betaRef = getText(readResult)
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { file: "crlf.ts", edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "BETA" }] },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
      expect(content).toContain("\r\n");
    });
  });

  it("preserves lone-CR line endings after edit", async () => {
    await withTempBytes("cr.ts", Buffer.from("alpha\rbeta\rgamma\r"), async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const readResult = await readTool.execute("r1", { path: "cr.ts" }, undefined, undefined, ctx);
      const betaRef = getText(readResult)
        .split("\n")
        .find((line: string) => line.includes("│beta"))!
        .split("│")[0]!;

      await editTool.execute(
        "e1",
        { file: "cr.ts", edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "BETA" }] },
        undefined,
        undefined,
        ctx,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\rBETA\rgamma\r");
    });
  });

  describe("edit tool — line-ending matrix", () => {
    const cases = [
      {
        name: "LF",
        fileName: "lf.txt",
        bytes: Buffer.from("alpha\nbeta\ngamma\n"),
        afterDelete: "alpha\ngamma\n",
      },
      {
        name: "CRLF",
        fileName: "crlf.txt",
        bytes: Buffer.from("alpha\r\nbeta\r\ngamma\r\n"),
        afterDelete: "alpha\r\ngamma\r\n",
      },
      {
        name: "CR",
        fileName: "cr.txt",
        bytes: Buffer.from("alpha\rbeta\rgamma\r"),
        afterDelete: "alpha\rgamma\r",
      },
    ];

    for (const c of cases) {
      it(`${c.name}: delete middle line preserves the ending`, async () => {
        await withTempBytes(c.fileName, c.bytes, async ({ cwd, path }) => {
          const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
          const readResult = await readTool.execute(
            "r1",
            { path: c.fileName },
            undefined,
            undefined,
            ctx,
          );
          const betaRef = getText(readResult)
            .split("\n")
            .find((line: string) => line.includes("│beta"))!
            .split("│")[0]!;
          await editTool.execute(
            "e1",
            { file: c.fileName, edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "" }] },
            undefined,
            undefined,
            ctx,
          );
          const content = await readFile(path, "utf-8");
          expect(content).toBe(c.afterDelete);
        });
      });

      it(`${c.name}: noop edit keeps the file byte-identical`, async () => {
        await withTempBytes(c.fileName, c.bytes, async ({ cwd, path }) => {
          const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
          const readResult = await readTool.execute(
            "r1",
            { path: c.fileName },
            undefined,
            undefined,
            ctx,
          );
          const betaRef = getText(readResult)
            .split("\n")
            .find((line: string) => line.includes("│beta"))!
            .split("│")[0]!;
          await editTool.execute(
            "e1",
            {
              file: c.fileName,
              edits: [{ anchor_from: betaRef, anchor_to: betaRef, text: "beta" }],
            },
            undefined,
            undefined,
            ctx,
          );
          const content = await readFile(path, "utf-8");
          expect(content).toBe(c.bytes.toString("utf-8"));
        });
      });
    }
  });
});
