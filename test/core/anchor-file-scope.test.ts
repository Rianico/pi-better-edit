import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  CANON_VERSION,
  DIGIT_ANCHOR_RE,
  HASH_LEN,
  canonicalAnchorPath,
  fileBaseIndex,
  fileHashesFor,
} from "../../src/hashline/index.js";
import { ALPHA } from "../../src/hashline/alphabet.js";
import { canon, canonDigest } from "../../src/hashline/hash.js";
import { xxh32 } from "../../src/hashline/hasher.js";
import { applyEdit } from "../../src/hashline/apply.js";
import { resEdit } from "../../src/hashline/resolve.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures";

function ctxFor(cwd: string, id: string): unknown {
  return { cwd, ui: { notify() {} }, sessionManager: { getSessionId: () => id } };
}

function rows(text: string): { hash: string; text: string }[] {
  const out: { hash: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (m) out.push({ hash: m[1]!, text: m[2]! });
  }
  return out;
}

function indexToSpelling(idx: number): string {
  let out = "";
  let m = idx;
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPHA[m % ALPHA.length] + out;
    m = Math.floor(m / ALPHA.length);
  }
  return out;
}

describe("anchor file scope", () => {
  it("C1: byte-identical files at different paths derive disjoint anchor sets", () => {
    // WHY: the intersection count is the evidence — file-scoping means the same
    // WHY: bytes under another path share no anchor with this file.
    const content = Array.from({ length: 2_000 }, (_, i) => `row ${i}`).join("\n") + "\n";
    const a = fileHashesFor("/test/c1-a.ts", content);
    const b = fileHashesFor("/test/c1-b.ts", content);
    expect(a).toHaveLength(2_000);
    expect(b).toHaveLength(2_000);
    const setA = new Set(a);
    let intersection = 0;
    for (const h of b) if (setA.has(h)) intersection++;
    expect(intersection).toBe(0);
    // WHY: and corresponding lines actually differ, not just the sets.
    expect(a[0]).not.toBe(b[0]);
    expect(a[1_999]).not.toBe(b[1_999]);
  });

  it("C2: an anchor served by A is refused for B and applies to A", async () => {
    await withTempFile("a.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { writeFile } = await import("node:fs/promises");
      const other = `${path}.b.txt`;
      await writeFile(other, "alpha\nbravo\ncharlie\n", "utf-8");
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const ctx = ctxFor(cwd, "c2");
      const aRows = rows(
        getText(await readTool.execute("r1", { path: "a.txt" }, undefined, undefined, ctx)),
      );
      const bRows = rows(
        getText(await readTool.execute("r2", { path: "a.txt.b.txt" }, undefined, undefined, ctx)),
      );
      // WHY: explicit precondition — this fixture really is in the disjoint regime.
      const inter = new Set(aRows.map((r) => r.hash));
      let overlap = 0;
      for (const r of bRows) if (inter.has(r.hash)) overlap++;
      expect(overlap).toBe(0);
      await expect(
        editTool.execute(
          "e1",
          {
            file: "a.txt.b.txt",
            edits: [{ anchor_from: aRows[1]!.hash, anchor_to: aRows[1]!.hash, text: "BRAVO" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/E_FOREIGN_ANCHOR/);
      expect(await readFile(other, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
      const ok = (await editTool.execute(
        "e2",
        {
          file: "a.txt",
          edits: [{ anchor_from: aRows[1]!.hash, anchor_to: aRows[1]!.hash, text: "BRAVO" }],
        },
        undefined,
        undefined,
        ctx,
      )) as unknown as { isError?: boolean; content: Array<{ text?: string }> };
      expect(ok.isError).not.toBe(true);
      expect(getText(ok)).toContain("Successfully edited");
      expect(await readFile(`${cwd}/a.txt`, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("C3: an unchanged line keeps its anchor across an edit and across sessions", async () => {
    await withTempFile("c3.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const s1 = ctxFor(cwd, "c3-first");
      const before = rows(
        getText(await readTool.execute("r1", { path: "c3.txt" }, undefined, undefined, s1)),
      );
      await editTool.execute(
        "e1",
        {
          file: "c3.txt",
          edits: [{ anchor_from: before[0]!.hash, anchor_to: before[0]!.hash, text: "ONE" }],
        },
        undefined,
        undefined,
        s1,
      );
      const after = rows(
        getText(await readTool.execute("r2", { path: "c3.txt" }, undefined, undefined, s1)),
      );
      // WHY: line three's bytes never changed, so its anchor survives the edit.
      expect(after[2]!.hash).toBe(before[2]!.hash);
      const s2 = ctxFor(cwd, "c3-fresh");
      const fresh = rows(
        getText(await readTool.execute("r3", { path: "c3.txt" }, undefined, undefined, s2)),
      );
      // WHY: derivation is a pure function of (path, content) — a fresh session
      // WHY: agrees exactly on the same bytes.
      expect(fresh.map((r) => r.hash)).toEqual(after.map((r) => r.hash));
    });
  });

  it("C4: canon and canonDigest are path-independent", () => {
    // WHY: canonicalization never sees a path — only the allocation base does.
    expect(canon("  padded  ")).toBe(canon("  padded  "));
    expect(canon("a\r\nb")).toBe("ab");
    expect(canonDigest("alpha\nbeta\n")).toBe(canonDigest("alpha\nbeta\n"));
    expect(canonDigest("alpha\nbeta\n")).toBe(String(xxh32(canon("alpha\nbeta\n"))));
  });

  it("C6: lexical spellings of one path derive identical anchors", () => {
    // WHY: `canonicalAnchorPath` normalizes — `.`/`..` spellings seed identically.
    const content = "x\ny\nz\n";
    const plain = fileHashesFor("/x/a.ts", content);
    expect(fileHashesFor("/x/./a.ts", content)).toEqual(plain);
    expect(fileHashesFor("/x/b/../a.ts", content)).toEqual(plain);
  });

  it("C7: CANON_VERSION is 3", () => {
    // WHY: the file-scoped derivation changes every anchor — the snapshot cache
    // WHY: key must miss every pre-change snapshot. (The version-2 miss itself is
    // WHY: pinned in the snapshot-store suite, next to the key builder.)
    expect(CANON_VERSION).toBe(3);
  });

  it("C8: reservation survives file-scoped seeding, including the fast path", () => {
    // WHY: the full-space derivation can reach the digit subcube on the fast path
    // WHY: itself — the duplicate-heavy sample proves allocation still refuses it.
    const dup = Array.from({ length: 20_000 }, () => "dup line 9").join("\n");
    const hashes = fileHashesFor("/x/c8.ts", dup);
    expect(hashes).toHaveLength(20_000);
    for (const h of hashes) expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
    // WHY: fast-path pin — find a (content, path) pair whose file base index IS
    // WHY: reserved, then verify allocation displaces it instead of serving it.
    const seed = xxh32(canonicalAnchorPath("/x/c8fast.ts"));
    let reservedIdx = -1;
    let probeContent = "";
    for (let i = 0; i < 50_000; i++) {
      const candidate = `fast-probe ${i}`;
      const idx = fileBaseIndex(canon(candidate), seed);
      if (DIGIT_ANCHOR_RE.test(indexToSpelling(idx))) {
        reservedIdx = idx;
        probeContent = candidate;
        break;
      }
    }
    expect(reservedIdx).toBeGreaterThanOrEqual(0);
    expect(indexToSpelling(fileBaseIndex(canon(probeContent), seed))).toBe(
      indexToSpelling(reservedIdx),
    );
    const [served] = fileHashesFor("/x/c8fast.ts", `${probeContent}\n`);
    expect(served).not.toBe(indexToSpelling(reservedIdx));
    expect(DIGIT_ANCHOR_RE.test(served!)).toBe(false);
  });

  it("C5: applyEdit with neither precomputed hashes nor a file path throws", () => {
    // WHY: no pathless file materialization — the programmer error fires before
    // WHY: any content-only derivation could serve a file's rows.
    const edit = resEdit({ anchor_from: "AAAA", anchor_to: "AAAA", text: "X" });
    expect(() => applyEdit("a\n", edit)).toThrow(/E_BAD_PAYLOAD/);
  });
});
