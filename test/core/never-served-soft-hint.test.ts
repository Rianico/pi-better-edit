import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { _lineHashesPure } from "../../src/hashline/hash";
import { applyEdit } from "../../src/hashline/apply";
import {
  findNeverServedAnchorShapes,
  buildNeverServedEditHint,
  buildNeverServedWriteHint,
} from "../../src/hashline/served-guard";
import { initHasher } from "../../src/hashline";
import { HASH_SEP, canon } from "../../src/hashline/hash-identity";
import { EDIT_GUIDELINES } from "../../src/payload-contract.js";
import { withTempFile, withTempDir, setupIntegrationTest, useTestHome } from "../support/fixtures";
import { lineHashes } from "../../src/hashline";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";
import { readFile as readFsFile, writeFile } from "node:fs/promises";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

function canonsFor(content: string): (string | null)[] {
  if (content === "") return [];
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return lines.map((line) => canon(line));
}

describe("never-served anchor-shaped predicate", () => {
  it("reports a never-served anchor-shaped line", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const hits = findNeverServedAnchorShapes([`ZZZ${HASH_SEP}alpha`], served, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ k: 1, anchor: "ZZZ" });
  });

  it("stays silent for a served anchor and for plain lines", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    expect(findNeverServedAnchorShapes([`${hashes[0]}${HASH_SEP}one`], served, 1)).toEqual([]);
    expect(findNeverServedAnchorShapes(["plain replacement"], served, 1)).toEqual([]);
  });
});

describe("applyEdit never-served soft hint", () => {
  it("writes never-served anchor-shaped bytes verbatim with a non-blocking soft hint", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    expect(hashes).not.toContain("ZZZ");
    const submitted = `ZZZ${HASH_SEP}alpha`;
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [submitted],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe(`alpha\n${submitted}\ngamma`);
    const hints = (result.warnings ?? []).filter((w) => w.includes("ZZZ"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[MODEL]");
    expect(hints[0]).toContain("anchor");
    expect(hints[0]).toContain("No action is required");
    expect(hints[0]).toContain("written as-is");
  });

  it("served hash echo still refuses with E_SERVED_ECHO", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons }),
    ).toThrow(/E_SERVED_ECHO/);
  });

  it("literal declaration succeeds without refusal", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
      mode: "literal",
    });
    expect(result.content).toBe(`alpha\n${hashes[1]}${HASH_SEP}beta\ngamma`);
    expect(result.literalBypass).toBe(true);
  });

  it("hint builders name the anchor and state no action is required", () => {
    const editHint = buildNeverServedEditHint({ k: 1, anchor: "ZZZ" });
    expect(editHint).toContain("[MODEL]");
    expect(editHint).toContain("ZZZ");
    expect(editHint).toContain("anchor");
    expect(editHint).toContain("No action is required");
    expect(editHint).toContain("written as-is");
    const writeHint = buildNeverServedWriteHint({ line: 2, anchor: "ZZZ" });
    expect(writeHint).toContain("[MODEL]");
    expect(writeHint).toContain("ZZZ");
    expect(writeHint).toContain("anchor");
    expect(writeHint).toContain("No action is required");
    expect(writeHint).toContain("written as-is");
  });
});

describe("edit tool never-served success plus hint", () => {
  it("reports success with the hint on the model-visible channel and keeps file bytes verbatim", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(hashes).not.toContain("ZZZ");
      const submitted = `ZZZ${HASH_SEP}alpha`;
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: submitted }],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      expect(text).toContain("Successfully edited");
      expect(text).toContain("[MODEL]");
      expect(text).toContain("ZZZ");
      expect(text).toContain("anchor");
      expect(text).toContain("No action is required");
      expect(await readFsFile(path, "utf-8")).toContain(submitted);
    });
  });
});

describe("write never-served success plus hint", () => {
  it("keeps written bytes verbatim with the hint on the model-visible channel", async () => {
    await withTempDir("write-never-served-", async (cwd) => {
      const fileName = "notes.md";
      const filePath = join(cwd, fileName);
      await writeFile(filePath, "one\ntwo\n", "utf-8");
      const sessionId = "sess-never-served";
      const ctx = {
        cwd,
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify() {} },
      } as any;
      const { getTool } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { path: fileName }, undefined, undefined, ctx);
      const submitted = `ZZZ${HASH_SEP}alpha`;
      const written = `${submitted}\ntwo\n`;
      await writeFile(filePath, written, "utf-8");
      const hooks = createLifecycleHooks();
      const out = await hooks.onToolResult(
        {
          toolName: "write",
          isError: false,
          input: { path: fileName, content: written },
          content: [{ type: "text", text: "wrote notes.md" }],
          details: undefined,
        } as any,
        ctx,
      );
      const text =
        (out?.content as Array<{ text?: string }> | undefined)
          ?.map((part) => (part as { text?: string }).text ?? "")
          .join("\n") ?? "";
      expect(text).toContain("[MODEL]");
      expect(text).toContain("ZZZ");
      expect(text).toContain("anchor");
      expect(text).toContain("No action is required");
      expect(await readFsFile(filePath, "utf-8")).toBe(written);
    });
  });
});

describe("guideline soft-hint scoping", () => {
  it("qualifies the MODEL line in content so the soft hint is not read as a retry demand", async () => {
    const line = EDIT_GUIDELINES.find((g) => g.includes("[MODEL]") && g.includes("content"));
    expect(line).toBeDefined();
    expect(line!).toContain("No action is required");
    const promptText = await readFile(
      new URL("../../prompts/edit-guidelines.md", import.meta.url),
      "utf-8",
    );
    const promptLine = promptText
      .split("\n")
      .find((l) => l.includes("[MODEL]") && l.includes("content"));
    expect(promptLine).toBeDefined();
    expect(promptLine!).toContain("No action is required");
  });
});
