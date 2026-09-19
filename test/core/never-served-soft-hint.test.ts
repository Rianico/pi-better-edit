import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { _lineHashesPure } from "../../src/hashline/hash";
import { applyEdit } from "../../src/hashline/apply";
import {
  findNeverServedAnchorShapes,
  buildNeverServedEditHint,
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

/** Local hint detector for rendered pipeline warnings (test-only).
 * Production no longer matches warning strings; the count travels as data. */
const HINT_MARK = "anchor-shaped replacement line";
function isRenderedHint(warning: string): boolean {
  return warning.includes(HINT_MARK);
}

/** A conforming hint states state only: no remedy, no imperative, no obligation. */
const REMEDY_TOKENS = [
  /if unintended/i,
  /undo_last_edit/,
  /re-issue/i,
  /reissue/i,
  /\brun\b/i,
  /\bretry\b/i,
  /\bundo\b/i,
  /\bshould\b/i,
  /\bmust\b/i,
];

function expectObservationOnly(hint: string): void {
  for (const token of REMEDY_TOKENS) expect(hint).not.toMatch(token);
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

describe("applyEdit never-served data (structured, no string channel)", () => {
  it("returns the offending count as data for 3 offending lines", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    for (const anchor of ["AAA", "BBB", "CCC"]) expect(hashes).not.toContain(anchor);
    const submitted = [`AAA${HASH_SEP}x`, `BBB${HASH_SEP}y`, `CCC${HASH_SEP}z`];
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: submitted,
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe(`alpha\n${submitted.join("\n")}\ngamma`);
    expect(result.neverServedCount).toBe(3);
    expect((result.warnings ?? []).filter(isRenderedHint)).toHaveLength(0);
  });

  it("returns the offending count as data for a single offending line", () => {
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
    expect(result.neverServedCount).toBe(1);
    expect((result.warnings ?? []).filter(isRenderedHint)).toHaveLength(0);
  });

  it("served hash echo still refuses with E_SUSPICIOUS_TEXT", () => {
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
    ).toThrow(/E_SUSPICIOUS_TEXT/);
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

  it("hint builder states the count and the row shape with no remedy", () => {
    const hint = buildNeverServedEditHint({ count: 3 });
    expect(hint).toContain("[MODEL]");
    expect(hint).toContain("3");
    expect(hint).toContain("anchor");
    expect(hint).toContain("row shape");
    expect(hint).toContain("written as-is");
    expect(hint).toContain("No action is required");
    expectObservationOnly(hint);
    const single = buildNeverServedEditHint({ count: 1 });
    expect(single).toContain("No action is required");
    expectObservationOnly(single);
  });
});

describe("edit tool never-served success plus hint", () => {
  it("reports success with one counted hint and keeps file bytes verbatim", async () => {
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
      const hints = (result.details.warnings as string[]).filter(isRenderedHint);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("1");
      expect(hints[0]).toContain("No action is required");
      expect(text).toContain("row shape");
      expectObservationOnly(hints[0]!);
      expect(await readFsFile(path, "utf-8")).toContain(submitted);
    });
  });

  it("emits exactly one hint for the whole call when 2 batch items offend", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\nfour\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      expect(hashes).not.toContain("ZZZ");
      expect(hashes).not.toContain("QQQ");
      const first = `ZZZ${HASH_SEP}alpha`;
      const second = `QQQ${HASH_SEP}beta`;
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, replace_with: first },
            { anchor_from: hashes[2]!, anchor_to: hashes[2]!, replace_with: second },
          ],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      expect(text).toContain("Successfully edited");
      const hints = (result.details.warnings as string[]).filter(isRenderedHint);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("2");
      expect(hints[0]).toContain("No action is required");
      expectObservationOnly(hints[0]!);
      const bytes = await readFsFile(path, "utf-8");
      expect(bytes).toContain(first);
      expect(bytes).toContain(second);
    });
  });
});

describe("write path carries no never-served hint", () => {
  it("keeps written bytes verbatim with no never-served hint", async () => {
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
      expect(text).not.toContain("never-served");
      expect(await readFsFile(filePath, "utf-8")).toBe(written);
    });
  });
});

describe("noop edit carries no never-served hint", () => {
  it("a noop edit yields no never-served hint at applyEdit level", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: ["beta"],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe(content);
    expect(result.neverServedCount ?? 0).toBe(0);
    expect((result.warnings ?? []).join("\n")).not.toContain("anchor-shaped replacement line");
    expect((result.warnings ?? []).join("\n")).not.toContain("Edit applied with");
  });

  it("a noop edit yields no never-served hint at edit-tool level", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "two" }],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      expect(text).toContain("No changes made");
      expect(text).not.toContain("anchor-shaped replacement line");
      expect(text).not.toContain("Edit applied with");
      const warnings = ((result.details as { warnings?: string[] }).warnings ?? []).join("\n");
      expect(warnings).not.toContain("anchor-shaped replacement line");
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
