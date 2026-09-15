import { describe, expect, it, beforeAll } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { _lineHashesPure } from "../../src/hashline/hash";
import { applyEdit } from "../../src/hashline/apply";
import {
  findServedPrefixMismatches,
  buildServedEditPrefixNote,
  buildServedWritePrefixNote,
} from "../../src/hashline/served-guard";
import { initHasher, lineHashes } from "../../src/hashline";
import { HASH_SEP, canon } from "../../src/hashline/hash-identity";
import { withTempFile, withTempDir, setupIntegrationTest, useTestHome } from "../support/fixtures";
import { createLifecycleHooks } from "../../src/lifecycle-hooks/index.js";

const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

function canonsFor(content: string): (string | null)[] {
  if (content === "") return [];
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return lines.map((line) => canon(line));
}

describe("served prefix mismatch predicate", () => {
  it("reports a served anchor prefix whose remainder differs", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    const hits = findServedPrefixMismatches([`${hashes[1]}${HASH_SEP}CHANGED`], served, canons, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ k: 1, anchor: hashes[1], servedLine: 2 });
  });

  it("stays silent for a verbatim served row", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    expect(findServedPrefixMismatches([`${hashes[1]}${HASH_SEP}two`], served, canons, 1)).toEqual(
      [],
    );
  });

  it("stays silent for a never-served prefix", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    expect(hashes).not.toContain("Zz9");
    expect(findServedPrefixMismatches([`Zz9${HASH_SEP}literal`], served, canons, 1)).toEqual([]);
  });

  it("stays silent without canon data", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    expect(findServedPrefixMismatches([`${hashes[1]}${HASH_SEP}CHANGED`], served, [], 1)).toEqual(
      [],
    );
  });
});

describe("applyEdit ambiguous tier", () => {
  it("applies the bytes as-is with a model note", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}CHANGED-beta`],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe(`alpha\n${hashes[1]}${HASH_SEP}CHANGED-beta\ngamma`);
    const notes = (result.warnings ?? []).filter((w) => w.startsWith("[MODEL]"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("applied");
    expect(notes[0]).toContain("replacement line 1");
    expect(notes[0]).toContain(hashes[1]!);
    expect(notes[0]).toContain("line 2");
    expect(notes[0]).toContain("differs from what was served");
    expect(notes[0]).toContain("undo_last_edit");
  });

  it("emits no note when no served-anchor prefix matches", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: ["plain replacement"],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe("alpha\nplain replacement\ngamma");
    expect((result.warnings ?? []).filter((w) => w.startsWith("[MODEL]"))).toEqual([]);
  });

  it("emits no ambiguous note when the evidence gate refuses", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        servedCanons,
      }),
    ).toThrow(/E_SERVED_ECHO/);
  });

  it("builds edit and write notes with the required fields", () => {
    const editNote = buildServedEditPrefixNote({ k: 2, anchor: "Ab3", servedLine: 1 });
    expect(editNote.startsWith("[MODEL]")).toBe(true);
    expect(editNote).toContain("applied");
    expect(editNote).toContain("replacement line 2");
    expect(editNote).toContain("Ab3");
    expect(editNote).toContain("line 1");
    expect(editNote).toContain("differs from what was served");
    expect(editNote).toContain("undo_last_edit");
    const writeNote = buildServedWritePrefixNote({ line: 2, anchor: "Ab3", servedLine: 1 });
    expect(writeNote.startsWith("[MODEL]")).toBe(true);
    expect(writeNote).toContain("applied");
    expect(writeNote).toContain("line 2");
    expect(writeNote).toContain("Ab3");
    expect(writeNote).toContain("line 1");
    expect(writeNote).toContain("differs from what was served");
    expect(writeNote).toContain("undo_last_edit");
  });
});

describe("edit result content carries the note", () => {
  it("applies an ambiguous line and informs the model channel", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const ambiguous = `${hashes[1]}${HASH_SEP}CHANGED`;
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: ambiguous }],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      expect(text).toContain("[MODEL]");
      expect(text).toContain("applied");
      expect(text).toContain(hashes[1]!);
      expect(text).toContain("differs from what was served");
      expect(text).toContain("undo_last_edit");
      expect(await readFile(path, "utf-8")).toContain(ambiguous);
    });
  });

  it("leaves clean edits without a note", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: "plain" }],
        } as any,
        undefined,
        undefined,
        ctx,
      );
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      expect(text).not.toContain("served anchor prefix");
    });
  });
});

describe("write result content carries the note", () => {
  it("applies written bytes as-is and informs the model channel", async () => {
    await withTempDir("write-prefix-note-", async (cwd) => {
      const fileName = "notes.md";
      const filePath = join(cwd, fileName);
      await writeFile(filePath, "one\ntwo\n", "utf-8");
      const sessionId = "sess-prefix-note";
      const ctx = {
        cwd,
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify() {} },
      } as any;
      const { getTool } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { path: fileName }, undefined, undefined, ctx);
      const hashes = await lineHashes("one\ntwo\n", filePath);
      const ambiguous = `${hashes[0]}${HASH_SEP}CHANGED`;
      const written = `${ambiguous}\ntwo\n`;
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
      expect(text).toContain("applied");
      expect(text).toContain(hashes[0]!);
      expect(text).toContain("differs from what was served");
      expect(text).toContain("undo_last_edit");
      expect(await readFile(filePath, "utf-8")).toBe(written);
    });
  });

  it("leaves clean writes without a note", async () => {
    await withTempDir("write-prefix-clean-", async (cwd) => {
      const fileName = "notes.md";
      const filePath = join(cwd, fileName);
      await writeFile(filePath, "one\ntwo\n", "utf-8");
      const sessionId = "sess-prefix-clean";
      const ctx = {
        cwd,
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify() {} },
      } as any;
      const { getTool } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      await readTool.execute("r1", { path: fileName }, undefined, undefined, ctx);
      const written = "fresh\nlines\n";
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
      expect(text).not.toContain("served anchor prefix");
    });
  });
});
