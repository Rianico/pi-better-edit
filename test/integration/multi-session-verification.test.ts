/**
 * Multi-session verification of the line-identity MVCC redesign (bd3a8f2).
 *
 * The redesign scopes its whole identity authority to `(session_id, file_path, anchor)`: leases are
 * granted at serve time and resolved read-only at edit time, and the served mirror, the retired set
 * and the tombstone are per session. That makes multi-session behaviour a first-class invariant, not
 * an edge case — and none of the existing suites drive two live sessions against one store.
 *
 * Each `it` pins one isolation property:
 *   1. a lease granted in one session authorizes nothing in another
 *   2. sessions do not clobber each other's served state
 *   3. a concurrent edit in another session is an external change (fail closed on the touched line)
 *   4. a restart (fresh session key, same store) invalidates anchors from the previous session
 *   5. leases are path-scoped: an identical anchor in another file is not authorized
 *   6. delete-heavy churn across many sessions never poisons a fresh session
 */
import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";
import { loadServed } from "../../src/served-session";

const SMALL_CPP = Array.from({ length: 6 }, (_, i) => {
  const n = i + 1;
  return `int f${n}(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n`;
}).join("\n");

function ctxFor(cwd: string, id: string): unknown {
  return { cwd, ui: { notify() {} }, sessionManager: { getSessionId: () => id } };
}

function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9]{3})│(.*)$/);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

describe("multi-session — lease isolation", () => {
  it("rejects a lease granted in another session and writes nothing", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const sessionA = ctxFor(cwd, "session-A");
      const sessionB = ctxFor(cwd, "session-B");

      const aRows = rows(
        getText(
          await readTool.execute("a1", { path: "small.cpp" }, undefined, undefined, sessionA),
        ),
      );
      const line9 = aRows[8]!.hash;

      // B never read the file: A's lease must not authorize B's edit
      await expect(
        editTool.execute(
          "b1",
          { path: "small.cpp", edits: [[line9, line9, "\tif (x > 999) {"]] },
          undefined,
          undefined,
          sessionB,
        ),
      ).rejects.toThrow(/E_STALE_(ANCHOR|RANGE)/);
      expect(await readFile(path, "utf-8")).toBe(SMALL_CPP);

      // control: the very same anchor is authorized once B holds its own lease
      const bRows = rows(
        getText(
          await readTool.execute("b2", { path: "small.cpp" }, undefined, undefined, sessionB),
        ),
      );
      expect(bRows[8]!.hash).toBe(line9);
      await expect(
        editTool.execute(
          "b3",
          { path: "small.cpp", edits: [[line9, line9, "\tif (x > 999) {"]] },
          undefined,
          undefined,
          sessionB,
        ),
      ).resolves.toBeDefined();
      expect((await readFile(path, "utf-8")).split("\n")[8]).toBe("\tif (x > 999) {");
    });
  });

  it("keeps both sessions working once each holds its own leases", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const sessionA = ctxFor(cwd, "session-A2");
      const sessionB = ctxFor(cwd, "session-B2");

      const aRows = rows(
        getText(
          await readTool.execute("a1", { path: "small.cpp" }, undefined, undefined, sessionA),
        ),
      );
      const bRows = rows(
        getText(
          await readTool.execute("b1", { path: "small.cpp" }, undefined, undefined, sessionB),
        ),
      );
      // content-addressed anchors agree across sessions for identical content
      expect(bRows.map((r) => r.hash)).toEqual(aRows.map((r) => r.hash));

      // B's read must not invalidate A's served mirror
      expect((await loadServed("session-A2", path)).filter((h) => h !== null)).toHaveLength(
        aRows.length,
      );

      await editTool.execute(
        "b2",
        { path: "small.cpp", edits: [[bRows[2]!.hash, bRows[2]!.hash, "\t\treturn 42;"]] },
        undefined,
        undefined,
        sessionB,
      );
      // A edits a line B never touched
      await editTool.execute(
        "a2",
        { path: "small.cpp", edits: [[aRows[8]!.hash, aRows[8]!.hash, "\tif (x > 999) {"]] },
        undefined,
        undefined,
        sessionA,
      );

      const lines = (await readFile(path, "utf-8")).split("\n");
      expect(lines[2]).toBe("\t\treturn 42;");
      expect(lines[8]).toBe("\tif (x > 999) {");
    });
  });
});

describe("multi-session — concurrent edits are external changes", () => {
  it("fails closed when another session already rewrote the same line", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const sessionA = ctxFor(cwd, "concurrent-A");
      const sessionB = ctxFor(cwd, "concurrent-B");

      const aRows = rows(
        getText(
          await readTool.execute("a1", { path: "small.cpp" }, undefined, undefined, sessionA),
        ),
      );
      const bRows = rows(
        getText(
          await readTool.execute("b1", { path: "small.cpp" }, undefined, undefined, sessionB),
        ),
      );

      await editTool.execute(
        "b2",
        { path: "small.cpp", edits: [[bRows[8]!.hash, bRows[8]!.hash, "\tif (x > 111) {"]] },
        undefined,
        undefined,
        sessionB,
      );

      // A's anchor for that line has no live identity any more
      await expect(
        editTool.execute(
          "a2",
          { path: "small.cpp", edits: [[aRows[8]!.hash, aRows[8]!.hash, "\tif (x > 222) {"]] },
          undefined,
          undefined,
          sessionA,
        ),
      ).rejects.toThrow(/E_STALE_(ANCHOR|RANGE)/);

      const lines = (await readFile(path, "utf-8")).split("\n");
      expect(lines[8]).toBe("\tif (x > 111) {");
      expect(lines.filter((l) => l.includes("x > 222"))).toHaveLength(0);
    });
  });
});

describe("multi-session — restart semantics", () => {
  it("invalidates anchors served before the restart even though the store persists", async () => {
    await withTempFile("small.cpp", SMALL_CPP, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const before = ctxFor(cwd, "boot-1");
      const after = ctxFor(cwd, "boot-2"); // fresh session key, same store/HOME

      const pre = rows(
        getText(await readTool.execute("r1", { path: "small.cpp" }, undefined, undefined, before)),
      );
      expect(await loadServed("boot-1", path)).toContain(pre[8]!.hash);

      // pasted-history anchor from the previous session
      await expect(
        editTool.execute(
          "e1",
          { path: "small.cpp", edits: [[pre[8]!.hash, pre[8]!.hash, "\tif (x > 999) {"]] },
          undefined,
          undefined,
          after,
        ),
      ).rejects.toThrow(/E_STALE_(ANCHOR|RANGE)/);
      expect(await readFile(path, "utf-8")).toBe(SMALL_CPP);

      // and after its own read the new session works normally
      const post = rows(
        getText(await readTool.execute("r2", { path: "small.cpp" }, undefined, undefined, after)),
      );
      await editTool.execute(
        "e2",
        { path: "small.cpp", edits: [[post[8]!.hash, post[8]!.hash, "\tif (x > 999) {"]] },
        undefined,
        undefined,
        after,
      );
      expect((await readFile(path, "utf-8")).split("\n")[8]).toBe("\tif (x > 999) {");
    });
  });
});

describe("multi-session — path scoping", () => {
  it("does not authorize an identical anchor served for a different file", async () => {
    await withTempFile("one.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { writeFile } = await import("fs/promises");
      const other = `${path}.copy.txt`;
      await writeFile(other, "alpha\nbravo\ncharlie\n", "utf-8");

      const { readTool, editTool } = setupIntegrationTest(cwd);
      const ctx = ctxFor(cwd, "path-scope");

      const oneRows = rows(
        getText(await readTool.execute("r1", { path: "one.txt" }, undefined, undefined, ctx)),
      );
      const copyRows = rows(
        getText(
          await readTool.execute("r2", { path: "one.txt.copy.txt" }, undefined, undefined, ctx),
        ),
      );
      // same content ⇒ same anchors, different files ⇒ different leases
      expect(copyRows.map((r) => r.hash)).toEqual(oneRows.map((r) => r.hash));

      await expect(
        editTool.execute(
          "e1",
          { path: "one.txt.copy.txt", edits: [[oneRows[1]!.hash, oneRows[1]!.hash, "BRAVO"]] },
          undefined,
          undefined,
          ctx,
        ),
      ).resolves.toBeDefined(); // the copy has its own lease from r2, so this is authorized

      await writeFile(other, "alpha\nbravo\ncharlie\n", "utf-8"); // reset
      const neverRead = `${path}.never-read.txt`;
      await writeFile(neverRead, "alpha\nbravo\ncharlie\n", "utf-8");
      await expect(
        editTool.execute(
          "e2",
          {
            path: "one.txt.never-read.txt",
            edits: [[oneRows[1]!.hash, oneRows[1]!.hash, "BRAVO"]],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_STALE_(ANCHOR|RANGE)/);
      expect(await readFile(neverRead, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
    });
  });
});

describe("multi-session — churn does not poison a fresh session", () => {
  it("serves and edits normally after delete-heavy churn in eight prior sessions", async () => {
    const content = Array.from({ length: 24 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await withTempFile("churn.txt", content, async ({ cwd, path }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);

      for (let round = 0; round < 8; round++) {
        const ctx = ctxFor(cwd, `churn-${round}`);
        const served = rows(
          getText(
            await readTool.execute(`r${round}`, { path: "churn.txt" }, undefined, undefined, ctx),
          ),
        );
        const victim = served[0]!.hash;
        await editTool.execute(
          `e${round}`,
          { path: "churn.txt", edits: [[victim, victim, ""]] },
          undefined,
          undefined,
          ctx,
        );
      }

      const fresh = ctxFor(cwd, "churn-fresh");
      const served = rows(
        getText(await readTool.execute("rf", { path: "churn.txt" }, undefined, undefined, fresh)),
      );
      expect(served).toHaveLength(16);
      expect(served.map((r) => r.text)[0]).toBe("row 9");

      await editTool.execute(
        "ef",
        { path: "churn.txt", edits: [[served[15]!.hash, served[15]!.hash, "row 24 final"]] },
        undefined,
        undefined,
        fresh,
      );
      expect(await readFile(path, "utf-8")).toContain("row 24 final");
    });
  });
});
