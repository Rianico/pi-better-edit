import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { lineHashes } from "../../src/hashline";
import { flatEditToolSchema, regReplaceFlat } from "../../src/replace-flat";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("flatEditToolSchema", () => {
  it("has path, hash_range_inclusive, and content_lines at top level", () => {
    const schema = flatEditToolSchema as any;
    expect(schema.type).toBe("object");
    const props = schema.properties;
    expect(props.path).toBeDefined();
    expect(props.hash_range_inclusive).toBeDefined();
    expect(props.content_lines).toBeDefined();
    expect(props.changes).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("regReplaceFlat", () => {
  it("registers a tool named 'replace'", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("replace");
    expect(tool.parameters).toBe(flatEditToolSchema);
  });

  it("prepareArguments normalizes file_path to path", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");
    const result = tool.prepareArguments({
      file_path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: ["new"],
    });
    expect(result.path).toBe("test.txt");
    expect(result.file_path).toBeUndefined();
  });

  it("prepareArguments parses JSON-string hash_range_inclusive", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");
    const result = tool.prepareArguments({
      path: "test.txt",
      hash_range_inclusive: JSON.stringify(["AAA", "BBB"]),
      content_lines: ["new"],
    });
    expect(result.hash_range_inclusive).toEqual(["AAA", "BBB"]);
  });

  it("prepareArguments parses JSON-string content_lines", () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");
    const result = tool.prepareArguments({
      path: "test.txt",
      hash_range_inclusive: ["AAA", "BBB"],
      content_lines: JSON.stringify(["a", "b"]),
    });
    expect(result.content_lines).toEqual(["a", "b"]);
  });

  it("replaces a single line via flat mode execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["BBB"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      const content = await readFile(cwd + "/sample.txt", "utf-8");
      expect(content).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("replaces a range of lines via flat mode execute", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\nddd\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[2]!],
          content_lines: ["BBB", "CCC"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      const content = await readFile(cwd + "/sample.txt", "utf-8");
      expect(content).toBe("aaa\nBBB\nCCC\nddd\n");
    });
  });

  it("deletes a line via flat mode execute (empty content_lines)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: [],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
      const content = await readFile(cwd + "/sample.txt", "utf-8");
      expect(content).toBe("aaa\nccc\n");
    });
  });

  it("reports noop when content is unchanged", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["bbb"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("No changes made to sample.txt");
      expect(result.details.classification).toBe("noop");
    });
  });

  it("rejects stale anchors with [E_STALE_ANCHOR]", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");

      await expect(
        tool.execute(
          "e1",
          {
            path: "sample.txt",
            hash_range_inclusive: ["ZZZ", "ZZZ"],
            content_lines: ["x"],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("rejects deleting an entire non-empty file", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\n");

      await expect(
        tool.execute(
          "e1",
          {
            path: "sample.txt",
            hash_range_inclusive: [hashes[0]!, hashes[1]!],
            content_lines: [],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_WOULD_EMPTY/);
    });
  });

  it("silently ignores unknown fields at top level (schema validation in Pi framework)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["BBB"],
          unknown_field: "bad",
        } as any,
        undefined,
        undefined,
        { cwd } as any,
      );

      // Unknown field is silently stripped; edit still succeeds
      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
    });
  });

  it("rejects missing hash_range_inclusive", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");

    await expect(
      tool.execute(
        "e1",
        {
          path: "test.txt",
          content_lines: ["new"],
        } as any,
        undefined,
        undefined,
        { cwd: "/tmp" } as any,
      ),
    ).rejects.toThrow();
  });

  it("rejects missing content_lines", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");

    await expect(
      tool.execute(
        "e1",
        {
          path: "test.txt",
          hash_range_inclusive: ["AAA", "BBB"],
        } as any,
        undefined,
        undefined,
        { cwd: "/tmp" } as any,
      ),
    ).rejects.toThrow();
  });

  it("rejects missing path", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    regReplaceFlat(pi);
    const tool = getTool("replace");

    await expect(
      tool.execute(
        "e1",
        {
          hash_range_inclusive: ["AAA", "BBB"],
          content_lines: ["new"],
        } as any,
        undefined,
        undefined,
        { cwd: "/tmp" } as any,
      ),
    ).rejects.toThrow();
  });

  it("reports metrics with edits_attempted = 1", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("aaa\nbbb\nccc\n");

      const result = await tool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["BBB"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details.metrics.edits_attempted).toBe(1);
      expect(result.details.metrics.classification).toBe("applied");
    });
  });

  it("preserves CRLF line endings", async () => {
    await withTempFile("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      regReplaceFlat(pi);
      const tool = getTool("replace");
      const hashes = lineHashes("alpha\nbeta\ngamma\n");

      await tool.execute(
        "e1",
        {
          path: "crlf.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["BETA"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const content = await readFile(path, "utf-8");
      expect(content).toBe("alpha\r\nBETA\r\ngamma\r\n");
    });
  });
});
