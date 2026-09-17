/**
 * Verification of the downstream (`Rianico/dsh-better-edit`) open issue reports against the
 * line-identity MVCC redesign (bd3a8f2).
 *
 * Each `it` encodes the *downstream acceptance criterion*, not the current behavior, so a failure
 * here means the downstream report has not vanished.
 *
 *  - #62: anchors on the same line numbers are invariant across any read sequence (unchanged file)
 *  - #61: no silent miswrite to a different line sharing the same canon
 *  - #63: literal `HASH│` content (0 matched) writes through unchanged
 */
import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

/** Six byte-identical function groups — the downstream #61/#62 fixture (41 lines). */
const SMALL_CPP = Array.from({ length: 6 }, (_, i) => {
  const n = i + 1;
  return `int f${n}(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n`;
}).join("\n");

const ROW_RE = /^([A-Za-z0-9]{3})│(.*)$/;

/** served rows of a read result, in order: `[{hash, text}]` */
function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(ROW_RE);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

async function read(
  readTool: ReturnType<typeof setupIntegrationTest>["readTool"],
  ctx: unknown,
  id: string,
  offset: number,
  limit: number,
  file = "small.cpp",
): Promise<string> {
  const res = await readTool.execute(id, { path: file, offset, limit }, undefined, undefined, ctx);
  return getText(res);
}

describe("downstream #62 — anchor stability across interleaved partial reads", () => {
  it("keeps the anchors of lines 8–14 identical across the issue's 5-step read sequence", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      const step1 = rows(await read(readTool, ctx, "r1", 8, 7));
      await read(readTool, ctx, "r2", 15, 7);
      const step3 = rows(await read(readTool, ctx, "r3", 8, 7));
      await read(readTool, ctx, "r4", 29, 7);
      const step5 = rows(await read(readTool, ctx, "r5", 8, 7));

      expect(step1.length).toBe(7);
      expect(step3.map((r) => r.hash)).toEqual(step1.map((r) => r.hash));
      expect(step5.map((r) => r.hash)).toEqual(step1.map((r) => r.hash));
      // the file is unchanged, so the served text must be unchanged too
      expect(step3.map((r) => r.text)).toEqual(step1.map((r) => r.text));
      expect(step5.map((r) => r.text)).toEqual(step1.map((r) => r.text));
    });
  });

  it("does not rebind an old anchor to another same-canon line after one interleaved read", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      const first = rows(await read(readTool, ctx, "r1", 8, 7)); // lines 8–14
      const f2Guard = first.find((r) => r.text === "\tif (x > 0) {")!;
      expect(f2Guard).toBeDefined();

      await read(readTool, ctx, "r2", 15, 7); // f3 group

      const after = rows(await read(readTool, ctx, "r3", 8, 7));
      const sameText = after.filter((r) => r.text === "\tif (x > 0) {");
      expect(sameText).toHaveLength(1);
      expect(sameText[0]!.hash).toBe(f2Guard.hash);
      expect(await readFile(path, "utf-8")).toBe(SMALL_CPP);
    });
  });

  it("serves the same anchors for a window whether it arrives via a full read or a partial read", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      const full = rows(await read(readTool, ctx, "r1", 1, 42));
      const partial = rows(await read(readTool, ctx, "r2", 8, 7));

      expect(full.length).toBe(SMALL_CPP.replace(/\n$/, "").split("\n").length);
      expect(partial.map((r) => r.hash)).toEqual(full.slice(7, 14).map((r) => r.hash));
    });
  });
});

describe("downstream #61 — no silent miswrite on canon-repeated lines", () => {
  it("does not write line 2 when editing line 9's old anchor after an interleaved read", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const first = rows(await read(readTool, ctx, "r1", 8, 7)); // lines 8–14
      const line9Hash = first[1]!.hash; // f2 guard, canonical `\tif (x > 0) {`
      expect(first[1]!.text).toBe("\tif (x > 0) {");

      await read(readTool, ctx, "r2", 15, 7); // interleaved f3 window

      let applied = false;
      try {
        await editTool.execute(
          "e1",
          { path: "small.cpp", edits: [[line9Hash, line9Hash, "\tif (x > 999) {"]] },
          undefined,
          undefined,
          ctx,
        );
        applied = true;
      } catch (error) {
        // fail-closed is acceptable; a wrong-line write is not
        expect(String(error)).toMatch(/E_STALE_(ANCHOR|RANGE)/);
      }

      const lines = (await readFile(path, "utf-8")).split("\n");
      const guards = lines
        .map((text, index) => ({ text, number: index + 1 }))
        .filter((l) => l.text === "\tif (x > 999) {");

      // exactly one guard may be rewritten, and only when it is the served line (line 9)
      expect(guards.length).toBe(applied ? 1 : 0);
      if (applied) expect(guards[0]!.number).toBe(9);
    });
  });

  it("still writes line 9 correctly when re-read immediately before the edit", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const first = rows(await read(readTool, ctx, "r1", 8, 7));
      const line9Hash = first[1]!.hash;

      await editTool.execute(
        "e1",
        { path: "small.cpp", edits: [[line9Hash, line9Hash, "\tif (x > 999) {"]] },
        undefined,
        undefined,
        ctx,
      );

      const lines = (await readFile(path, "utf-8")).split("\n");
      expect(lines[8]).toBe("\tif (x > 999) {");
      expect(lines[1]).toBe("\tif (x > 0) {");
    });
  });
});

// #63 is cured by dropping the shape refusal: literal `HASH│` bytes now write through
// byte-exact, while a verbatim served row still refuses via the evidence gate.
describe("downstream #63 — literal HASH│ content in replace_with", () => {
  it("writes literal `abc│text` / `KEY│value` lines whose hashes are not anchors of the file", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const line2Hash = served[1]!.hash;

      await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [[line2Hash, line2Hash, "abc│text\nKEY│value"]],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("one\nabc│text\nKEY│value\nthree\n");
    });
  });

  it("still rejects a pasted served hash echo in replace_with", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const line2Hash = served[1]!.hash;
      const echo = `${served[1]!.hash}│two`; // real anchor of this file

      await expect(
        editTool.execute(
          "e1",
          { path: "sample.txt", edits: [[line2Hash, line2Hash, echo]] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_SERVED_ECHO/);
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });
});
