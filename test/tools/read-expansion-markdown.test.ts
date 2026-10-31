import { describe, expect, it } from "vitest";
import { regRead } from "../../src/read";
import { createReadSpanProvider } from "../../src/read-expansion/read-provider";
import { isMarkdownPath } from "../../src/read-expansion/markdown-provider";
import {
  anchorRows,
  getText,
  makeFakePiRegistry,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

type ReadResult = {
  content: Array<{ text?: string }>;
};

function reader() {
  const { pi, getTool } = makeFakePiRegistry();
  regRead(pi, { spanProvider: createReadSpanProvider() });
  return getTool("read") as {
    execute(
      callId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<ReadResult>;
  };
}

function runRead(
  tool: ReturnType<typeof reader>,
  cwd: string,
  params: unknown,
): Promise<ReadResult> {
  return tool.execute("read-expansion-markdown", params, undefined, undefined, {
    cwd,
    sessionManager: testSessionManager,
  });
}

function lines(result: ReadResult): string[] {
  return anchorRows(getText(result)).map((row) => row.slice(row.indexOf("│") + 1));
}

function notes(result: ReadResult): string[] {
  return getText(result)
    .split("\n")
    .filter((line) => line.includes("[widened "));
}

describe("read expansion: Markdown heading sections", () => {
  it("serves the deepest ## section through the line before the next equal-or-higher heading", async () => {
    const source = `# Guide\n\nIntro.\n\n## Language\n\nAlpha.\nBeta.\n\n### Nested\n\nGamma.\n\n## Next\n\nDelta.\n`;
    await withTempFile("guide.md", source, async ({ cwd, path }) => {
      const tool = reader();

      const language = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 8, limit: 1 }],
      });
      expect(lines(language)[0]).toBe("## Language");
      expect(lines(language).at(-2)).toBe("Gamma.");
      expect(notes(language)).toEqual(['[widened 8-8 -> 5-13, section "Language"]']);

      const nested = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 12, limit: 1 }],
      });
      expect(lines(nested)[0]).toBe("### Nested");
      expect(lines(nested).at(-2)).toBe("Gamma.");
      expect(notes(nested)).toEqual(['[widened 12-12 -> 10-13, section "Nested"]']);
    });
  });

  it("does not treat # lines inside a fence as section boundaries", async () => {
    const source = `## Code\n\n\`\`\`sh\n# not a heading\n### also not a heading\necho hi\n\`\`\`\n\n## Next\n`;
    await withTempFile("fence.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## Code");
      expect(lines(result).at(-2)).toBe("```");
      expect(notes(result)).toEqual(['[widened 4-4 -> 1-8, section "Code"]']);
    });
  });

  it("does not treat # lines inside a ~~~ fence as section boundaries", async () => {
    const source = `## Code\n\n~~~sh\n# not a heading\n### also not a heading\necho hi\n~~~\n\n## Next\n`;
    await withTempFile("tilde-fence.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## Code");
      expect(lines(result).at(-2)).toBe("~~~");
      expect(notes(result)).toEqual(['[widened 4-4 -> 1-8, section "Code"]']);
    });
  });

  it("keeps a ~~~ fence open when a ``` line appears inside it", async () => {
    const source = `## Code\n\n~~~\n\`\`\`sh\n# not a heading\n~~~\n\n## Next\n`;
    await withTempFile("tilde-mismatch.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 5, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## Code");
      expect(lines(result).at(-2)).toBe("~~~");
      expect(notes(result)).toEqual(['[widened 5-5 -> 1-7, section "Code"]']);
    });
  });

  it("refuses a file with a Setext heading and serves the requested window", async () => {
    const source = `Title\n=====\n\n## Section\n\nText.\n`;
    await withTempFile("setext.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 6, limit: 1 }],
      });

      expect(lines(result)).toEqual(["Text."]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("clamps an over-cap section to a window containing the request and names the extent", async () => {
    const body = Array.from({ length: 100 }, (_, index) => `body ${index + 2}`).join("\n");
    const source = `## Long\n${body}\n## Next\ntail\n`;
    await withTempFile("long.md", source, async ({ cwd, path }) => {
      const tool = reader();

      const first = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 20, limit: 1 }],
      });
      expect(lines(first)).toHaveLength(80);
      expect(lines(first)[0]).toBe("## Long");
      expect(notes(first)).toEqual(['[widened 20-20 -> 1-80, section "Long" (section 1-101)]']);

      const late = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 90, limit: 1 }],
      });
      expect(lines(late)).toHaveLength(80);
      expect(lines(late)[0]).toBe("body 11");
      expect(notes(late)).toEqual(['[widened 90-90 -> 11-90, section "Long" (section 1-101)]']);
    });
  });

  it("keeps the section extent when more than three requests collapse to one note", async () => {
    const body = Array.from({ length: 100 }, (_, index) => `body ${index + 2}`).join("\n");
    const source = `## Long\n${body}\n## Next\ntail\n`;
    await withTempFile("many.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [10, 30, 50, 70].map((offset) => ({ offset, limit: 1 })),
      });

      expect(notes(result)).toEqual(["[widened 4 windows: 1-80 (section 1-101)]"]);
    });
  });

  it("fails closed for an unclosed fence, a pre-heading probe and a no-heading file", async () => {
    const tool = reader();
    await withTempFile("unclosed.md", `## Open\n\n\`\`\`\n# body\n\`\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });
      expect(lines(result)).toEqual(["# body"]);
      expect(notes(result)).toEqual([]);
    });

    await withTempFile("unclosed-tilde.md", `## Open\n\n~~~\n# body\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });
      expect(lines(result)).toEqual(["# body"]);
      expect(notes(result)).toEqual([]);
    });

    await withTempFile("before.md", `intro\n## Section\ntext\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });
      expect(lines(result)).toEqual(["intro"]);
      expect(notes(result)).toEqual([]);
    });

    await withTempFile("plain.md", `one\ntwo\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(lines(result)).toEqual(["two"]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("sees a heading after a UTF-8 BOM", async () => {
    const source = `\uFEFF## Title\n\nbody\n`;
    await withTempFile("bom.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 3, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## Title");
      expect(notes(result)).toEqual(['[widened 3-3 -> 1-3, section "Title"]']);
    });
  });

  it("treats blockquote headings as plain text", async () => {
    const source = `> ## quoted\n\nbody\n`;
    await withTempFile("quote.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 1, limit: 1 }],
      });

      expect(lines(result)).toEqual(["> ## quoted"]);
      expect(notes(result)).toEqual([]);
    });
  });

  it("keeps reader line numbers for CRLF and CR-only breaks", async () => {
    const tool = reader();
    await withTempFile("crlf.md", `## A\r\npara\r\n## B\r\ntail\r\n`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(lines(result)).toEqual(["## A", "para"]);
      expect(notes(result)).toEqual(['[widened 2-2 -> 1-2, section "A"]']);
    });

    await withTempFile("cr.md", `## A\rpara\r## B\rtail\r`, async ({ cwd, path }) => {
      const result = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(lines(result)).toEqual(["## A", "para"]);
      expect(notes(result)).toEqual(['[widened 2-2 -> 1-2, section "A"]']);
    });
  });

  it("skips YAML frontmatter instead of refusing its closing delimiter", async () => {
    const source = `---\ntitle: x\n---\n## A\n\nbody\n`;
    await withTempFile("frontmatter.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 6, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## A");
      expect(notes(result)).toEqual(['[widened 6-6 -> 4-6, section "A"]']);
    });
  });

  it("handles closing hashes, indented code and #hashtag text as ATX rules require", async () => {
    const source = `## Foo ##\n\n    ## indented code\n#hashtag\n### Sub\ntext\n## Bar\n`;
    await withTempFile("edge.md", source, async ({ cwd, path }) => {
      const tool = reader();

      const parent = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 2, limit: 1 }],
      });
      expect(lines(parent)[0]).toBe("## Foo ##");
      expect(notes(parent)).toEqual(['[widened 2-2 -> 1-6, section "Foo"]']);

      const sub = await runRead(tool, cwd, {
        file: path,
        windows: [{ offset: 5, limit: 1 }],
      });
      expect(lines(sub)[0]).toBe("### Sub");
      expect(notes(sub)).toEqual(['[widened 5-5 -> 5-6, section "Sub"]']);
    });
  });

  it("ignores a Setext underline inside a fence", async () => {
    const source = `## Code\n\n\`\`\`md\nTitle\n=====\n\`\`\`\n`;
    await withTempFile("setext-fence.md", source, async ({ cwd, path }) => {
      const result = await runRead(reader(), cwd, {
        file: path,
        windows: [{ offset: 4, limit: 1 }],
      });

      expect(lines(result)[0]).toBe("## Code");
      expect(lines(result).at(-1)).toBe("```");
      expect(notes(result)).toEqual(['[widened 4-4 -> 1-6, section "Code"]']);
    });
  });
  it("dispatches Markdown extensions case-insensitively and rejects near misses", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("guide.markdown")).toBe(true);
    expect(isMarkdownPath("guide.md.bak")).toBe(false);
    expect(isMarkdownPath("guide.mdx")).toBe(false);
  });
});
