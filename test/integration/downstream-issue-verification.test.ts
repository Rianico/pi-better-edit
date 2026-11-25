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
 *  - #145: a dry-run preview matches the later apply and commits nothing
 */
import { describe, expect, it } from "vitest";
import { readFile, stat, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";
import { NOOP_LOOP_THRESHOLD } from "../../src/constants.js";
import { loadHashStore } from "../../src/hash-store.js";

/** Six byte-identical function groups — the downstream #61/#62 fixture (41 lines). */
const SMALL_CPP = Array.from({ length: 6 }, (_, i) => {
  const n = i + 1;
  return `int f${n}(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n`;
}).join("\n");

const ROW_RE = /^([A-Za-z0-9]{4})│(.*)$/;

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
  const res = await readTool.execute(
    id,
    { file: file, windows: [{ offset, limit }] },
    undefined,
    undefined,
    ctx,
  );
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
      expect(step3.map((r) => r.text)).toEqual(step1.map((r) => r.text));
      expect(step5.map((r) => r.text)).toEqual(step1.map((r) => r.text));
    });
  });

  it("does not rebind an old anchor to another same-canon line after one interleaved read", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);

      const first = rows(await read(readTool, ctx, "r1", 8, 7));
      const f2Guard = first.find((r) => r.text === "\tif (x > 0) {")!;
      expect(f2Guard).toBeDefined();

      await read(readTool, ctx, "r2", 15, 7);

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

      const first = rows(await read(readTool, ctx, "r1", 8, 7));
      const line9Hash = first[1]!.hash;
      expect(first[1]!.text).toBe("\tif (x > 0) {");

      await read(readTool, ctx, "r2", 15, 7);

      let applied = false;
      try {
        await editTool.execute(
          "e1",
          {
            file: "small.cpp",
            edits: [{ anchor_from: line9Hash, anchor_to: line9Hash, text: "\tif (x > 999) {" }],
          },
          undefined,
          undefined,
          ctx,
        );
        applied = true;
      } catch (error) {
        expect(String(error)).toMatch(/E_STALE_(ANCHOR|RANGE)/);
      }

      const lines = (await readFile(path, "utf-8")).split("\n");
      const guards = lines
        .map((text, index) => ({ text, number: index + 1 }))
        .filter((l) => l.text === "\tif (x > 999) {");

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
        {
          file: "small.cpp",
          edits: [{ anchor_from: line9Hash, anchor_to: line9Hash, text: "\tif (x > 999) {" }],
        },
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

describe("downstream #63 — literal HASH│ content in text", () => {
  it("writes literal `abc│text` / `KEY│value` lines whose hashes are not anchors of the file", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const line2Hash = served[1]!.hash;

      await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: "abc│text\nKEY│value" }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("one\nabc│text\nKEY│value\nthree\n");
    });
  });

  it("still rejects a pasted served hash echo in text", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const line2Hash = served[1]!.hash;
      const echo = `${served[1]!.hash}│two`;

      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.txt",
            edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: echo }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_SUSPICIOUS_TEXT/);
      expect(await readFile(path, "utf-8")).toBe("one\ntwo\nthree\n");
    });
  });
});

/**
 * The rendered diff body of an edit response: the file banner onward, with each row's gutter
 * reduced to its `+`/`-`/` ` marker. A dry run prints an empty 4-space gutter where a live run
 * prints anchors, so only this projection is comparable across the two.
 */
function diffBody(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^--- .+ ---$/.test(line));
  expect(start, "the response must render a file banner").toBeGreaterThanOrEqual(0);
  return lines
    .slice(start)
    .map((line) => line.replace(/^([ +-]).{4}│/, "$1"))
    .join("\n");
}

/** Undo rows this worker's store holds — a dry run must append none. */
async function undoRowCount(): Promise<number> {
  const store = await loadHashStore();
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM file_undo").get() as { n: number };
  return row.n;
}

/** The domain code a tool call rejects with, or a marker naming the unexpected outcome. */
async function rejectionCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /E_[A-Z_]+/.exec(message)?.[0] ?? "no-code";
  }
  return "no-rejection";
}

describe("downstream #145 — read-only edit preview (dry_run)", () => {
  it("previews exactly the bytes a later apply writes and commits nothing", async () => {
    const content = "line1\nline2\nline3\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));

      const edits = [
        { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, text: "line1-modified" },
        { anchor_from: served[2]!.hash, anchor_to: served[2]!.hash, text: "line3-modified" },
      ];
      const mtimeBefore = (await stat(path)).mtimeMs;
      const undoBefore = await undoRowCount();

      const dry = await editTool.execute(
        "e1",
        { file: "sample.txt", dry_run: true, edits },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8"), "the preview writes nothing").toBe(content);
      expect((await stat(path)).mtimeMs, "the preview touches no bytes").toBe(mtimeBefore);
      expect(await undoRowCount(), "the preview appends no undo row").toBe(undoBefore);
      const dryBody = diffBody(getText(dry));

      const live = await editTool.execute(
        "e2",
        { file: "sample.txt", edits },
        undefined,
        undefined,
        ctx,
      );
      const liveText = getText(live);

      expect(diffBody(liveText), "the preview equals the applied diff row for row").toBe(dryBody);
      expect(await readFile(path, "utf-8")).toBe("line1-modified\nline2\nline3-modified\n");
      expect(liveText.startsWith("Successfully edited"), liveText).toBe(true);
    });
  });

  it("rejects a stale range fail-closed with the same code as the live arm", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));

      await writeFile(path, "alpha\nbeta\nGAMMA\n", "utf-8");
      const staleBytes = "alpha\nbeta\nGAMMA\n";
      const mtimeBefore = (await stat(path)).mtimeMs;

      const edits = [
        { anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, text: "ALPHA" },
        { anchor_from: served[2]!.hash, anchor_to: served[2]!.hash, text: "GAMMA-2" },
      ];
      const dryCode = await rejectionCode(() =>
        editTool.execute(
          "e1",
          { file: "sample.txt", dry_run: true, edits },
          undefined,
          undefined,
          ctx,
        ),
      );

      expect(dryCode, "a dry run is never more permissive than the write").toMatch(
        /E_STALE_ANCHOR|E_TARGET_LOST|E_STALE_RANGE/,
      );
      expect(await readFile(path, "utf-8"), "no partial apply").toBe(staleBytes);
      expect((await stat(path)).mtimeMs).toBe(mtimeBefore);

      const liveCode = await rejectionCode(() =>
        editTool.execute("e2", { file: "sample.txt", edits }, undefined, undefined, ctx),
      );
      expect(liveCode, "the live arm rejects with the preview's own code").toBe(dryCode);
      expect(await readFile(path, "utf-8")).toBe(staleBytes);
      expect((await stat(path)).mtimeMs).toBe(mtimeBefore);
    });
  });

  it("locks no version: the same edit still rejects after an external write, and fresh anchors write", async () => {
    await withTempFile("sample.txt", "first\nsecond\nthird\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const staleEdit = {
        file: "sample.txt",
        edits: [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, text: "SECOND" }],
      };

      await editTool.execute("e1", { ...staleEdit, dry_run: true }, undefined, undefined, ctx);
      await writeFile(path, "first\nexternal\nthird\n", "utf-8");

      const rejected = await rejectionCode(() =>
        editTool.execute("e2", staleEdit, undefined, undefined, ctx),
      );
      expect(rejected, "a preview grants no lock over the old bytes").toMatch(
        /E_STALE_ANCHOR|E_TARGET_LOST|E_STALE_RANGE/,
      );
      expect(await readFile(path, "utf-8")).toBe("first\nexternal\nthird\n");

      const fresh = rows(await read(readTool, ctx, "r2", 1, 3, "sample.txt"));
      await editTool.execute(
        "e3",
        {
          file: "sample.txt",
          edits: [{ anchor_from: fresh[1]!.hash, anchor_to: fresh[1]!.hash, text: "written" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8"), "fresh anchors still write").toBe(
        "first\nwritten\nthird\n",
      );
    });
  });

  it("never advances the live noop loop", async () => {
    const content = "aaa\nbbb\nccc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const served = rows(await read(readTool, ctx, "r1", 1, 3, "sample.txt"));
      const noopEdit = [{ anchor_from: served[1]!.hash, anchor_to: served[1]!.hash, text: "bbb" }];

      for (let attempt = 0; attempt < NOOP_LOOP_THRESHOLD + 2; attempt++) {
        const result = await editTool.execute(
          "e1",
          { file: "sample.txt", dry_run: true, edits: noopEdit },
          undefined,
          undefined,
          ctx,
        );
        const details = result.details as { classification?: string };
        expect(getText(result), `attempt ${attempt + 1} previews the noop`).toContain(
          "[DRY RUN] No changes would be made",
        );
        expect(details.classification, `attempt ${attempt + 1} stays a noop`).toBe("noop");
      }

      const liveNoop = await editTool.execute(
        "e2",
        { file: "sample.txt", edits: noopEdit },
        undefined,
        undefined,
        ctx,
      );
      const liveText = getText(liveNoop);
      expect(liveText).toContain("No changes made");
      expect(liveText, "previews tally nothing").not.toContain("NOOP_LOOP");
      expect(await readFile(path, "utf-8")).toBe(content);

      await editTool.execute(
        "e3",
        {
          file: "sample.txt",
          edits: [{ anchor_from: served[0]!.hash, anchor_to: served[0]!.hash, text: "AAA" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(await readFile(path, "utf-8")).toBe("AAA\nbbb\nccc\n");
    });
  });
});
