import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  resEdit,
  type LeaseIdentityView,
  type LeaseSpanSource,
} from "../../src/hashline/resolve.js";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve.js";
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
  it("C1: byte-identical files at different paths share at most a bounded few anchors", () => {
    // WHY: ADR-0030 §1 — E[shared] = n²/S (0.27 at n = 2000), so a zero is luck, not
    // WHY: proof. This fixture sits in the zero regime (it measures 0); the pinned
    // WHY: companion (`xN7H`, intersection 1) and the regression case (intersection
    // WHY: 2000) carry the refutability, plus this deterministic same-position
    // WHY: guard (P(equal) ≈ n/S per line).
    const lines = Array.from({ length: 2_000 }, (_, i) => `row ${i}`);
    const content = lines.join("\n") + "\n";
    const a = fileHashesFor("/test/c1-a.ts", content);
    const b = fileHashesFor("/test/c1-b.ts", content);
    expect(a).toHaveLength(lines.length);
    expect(b).toHaveLength(lines.length);
    const setA = new Set(a);
    let intersection = 0;
    for (const h of b) if (setA.has(h)) intersection++;
    expect(intersection).toBeLessThan(lines.length);
    expect(intersection).toBeLessThanOrEqual(8);
    for (let i = 0; i < lines.length; i++) expect(a[i]).not.toBe(b[i]);
  });

  it("C1 companion: a fixed colliding pair shares a spelling (ADR-0030 §1)", () => {
    // WHY: the residual is real, so it is pinned visibly on a fixed pair — never a
    // WHY: lucky zero. E[shared] = n²/S makes some pair collide; this one does.
    const lines = Array.from({ length: 2_000 }, (_, i) => `crow ${i}`);
    const content = lines.join("\n") + "\n";
    const a = fileHashesFor("/test/c1c-a.ts", content);
    const b = fileHashesFor("/test/c1c-1.ts", content);
    const setA = new Set(a);
    let intersection = 0;
    for (const h of b) if (setA.has(h)) intersection++;
    expect(intersection).toBeGreaterThanOrEqual(1);
    // WHY: the exact shared spelling is pinned — a derivation change that moves it
    // WHY: must fail loudly here, not silently re-luck the fixture.
    expect(b.find((h) => setA.has(h))).toBe("xN7H");
    expect(a.indexOf("xN7H") + 1).toBe(1211);
    expect(b.indexOf("xN7H") + 1).toBe(1245);
  });

  it("C1 companion: a runtime shared spelling resolves lease-scoped", async () => {
    // WHY: on-disk paths are per-run random, so the colliding pair cannot be
    // WHY: hardcoded here — at n = 20,000, E[shared] ≈ 27 and P(no shared
    // WHY: spelling) ≈ 1e-12, and the defined-gate below fails loudly on a miss
    // WHY: rather than going vacuous. P(a given anchor exists in the sibling) = n/S.
    // WHY: No end-to-end assertion here claims a wrong write succeeds.
    const lines = Array.from({ length: 20_000 }, (_, i) => `gull ${i}`);
    const content = lines.join("\n") + "\n";
    await withTempFile("gull-a.txt", content, async ({ cwd }) => {
      const { writeFile, readFile } = await import("node:fs/promises");
      await writeFile(join(cwd, "gull-b.txt"), content, "utf-8");
      // WHY: the discovery runs on the exact derivation (fast, in-process) — served
      // WHY: rows cap at 2,000 per read, so paging 20k rows to find the shared
      // WHY: spelling would be contortion. The defined-gate below still fails
      // WHY: loudly on a miss (P ≈ 1e-12) rather than going vacuous.
      const realA = join(cwd, "gull-a.txt");
      const realB = join(cwd, "gull-b.txt");
      const dA = await fileHashesFor(realA, content);
      const dB = await fileHashesFor(realB, content);
      const dSet = new Set(dA);
      const sharedIdxB = dB.findIndex((h) => dSet.has(h));
      expect(sharedIdxB).toBeGreaterThanOrEqual(0);
      const shared = dB[sharedIdxB]!;
      const lineInA = dA.indexOf(shared) + 1;
      const lineInB = sharedIdxB + 1;
      const fresh = ctxFor(cwd, "c1c-runtime");
      const { getTool } = setupIntegrationTest(cwd);
      const readTool = getTool("read");
      const editTool = getTool("edit");
      const readWindow = async (name: string, line: number): Promise<string> =>
        getText(
          await readTool.execute(
            "r1",
            { file: name, offset: line, limit: 10 },
            undefined,
            undefined,
            fresh,
          ),
        );
      // WHY: the served windows must show the derived shared spelling at the
      // WHY: derived lines — derivation and serving agree by construction here.
      const winA = await readWindow("gull-a.txt", lineInA);
      const winB = await readWindow("gull-b.txt", lineInB);
      expect(winA.split("\n").find((l) => l.startsWith(shared + "│"))).toBeDefined();
      expect(winB.split("\n").find((l) => l.startsWith(shared + "│"))).toBeDefined();
      const lineOf = (text: string): number => {
        const l = text.split("\n").find((x) => x.startsWith(shared + "│"))!;
        return Number(l.slice(shared.length + 1 + "gull ".length)) + 1;
      };
      expect(lineOf(winA)).toBe(lineInA);
      expect(lineOf(winB)).toBe(lineInB);
      await editTool.execute(
        "e1",
        {
          file: "gull-b.txt",
          edits: [{ anchor_from: shared, anchor_to: shared, text: "RESOLVED" }],
        },
        undefined,
        undefined,
        fresh,
      );
      const afterB = await readFile(join(cwd, "gull-b.txt"), "utf-8");
      // WHY: lease-scoped resolution — the sibling's own line changed, and the
      // WHY: identically-spelled line in the other file did not.
      expect(afterB.split("\n")[lineInB - 1]).toBe("RESOLVED");
      const afterA = await readFile(join(cwd, "gull-a.txt"), "utf-8");
      // WHY: `gull ${lineInA - 1}` is the zero-based content line at that 1-based row.
      expect(afterA.split("\n")[lineInA - 1]).toBe(`gull ${lineInA - 1}`);
    });
  });

  it("C2: an anchor served by A is refused for B and applies to A", async () => {
    await withTempFile("a.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { writeFile } = await import("node:fs/promises");
      const other = `${path}.b.txt`;
      await writeFile(other, "alpha\nbravo\ncharlie\n", "utf-8");
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const ctx = ctxFor(cwd, "c2");
      const aRows = rows(
        getText(await readTool.execute("r1", { file: "a.txt" }, undefined, undefined, ctx)),
      );
      const bRows = rows(
        getText(await readTool.execute("r2", { file: "a.txt.b.txt" }, undefined, undefined, ctx)),
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
        getText(await readTool.execute("r1", { file: "c3.txt" }, undefined, undefined, s1)),
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
        getText(await readTool.execute("r2", { file: "c3.txt" }, undefined, undefined, s1)),
      );
      // WHY: line three's bytes never changed, so its anchor survives the edit.
      expect(after[2]!.hash).toBe(before[2]!.hash);
      const s2 = ctxFor(cwd, "c3-fresh");
      const fresh = rows(
        getText(await readTool.execute("r3", { file: "c3.txt" }, undefined, undefined, s2)),
      );
      // WHY: derivation is a pure function of (path, content) — a fresh session
      // WHY: agrees exactly on the same bytes.
      expect(fresh.map((r) => r.hash)).toEqual(after.map((r) => r.hash));
    });
  });

  it("C4: allocation is file-scoped while verification keys on the content hash", () => {
    // WHY: `canon` takes one argument — no path parameter to smuggle — and the
    // WHY: leases recorded for identical bytes carry an identical canon_hash while
    // WHY: the served anchors differ per file: allocation file-scoped,
    // WHY: verification content-only.
    expect(canon.length).toBe(1);
    const lines = ["alpha", "beta"];
    const content = lines.join("\n") + "\n";
    const hA = fileHashesFor("/test/c4a.ts", content);
    const hB = fileHashesFor("/test/c4b.ts", content);
    expect(hA).not.toEqual(hB);
    const setA = new Set(hA);
    for (const h of hB) expect(setA.has(h)).toBe(false);
    const leases: Record<string, LeaseIdentityView> = {};
    const deal = (hashes: string[], snap: string): void => {
      hashes.forEach((h, i) => {
        leases[h] = {
          lineId: i + 1,
          canonHash: canonDigest(lines[i]!),
          servedSnapshotHash: snap,
          servedLineNumber: i + 1,
          retiredAt: null,
        };
      });
    };
    deal(hA, "S");
    deal(hB, "S");
    // WHY: the same bytes record the same canon_hash in both files' leases.
    expect(leases[hA[0]!]!.canonHash).toBe(leases[hB[0]!]!.canonHash);
    expect(leases[hA[1]!]!.canonHash).toBe(leases[hB[1]!]!.canonHash);
    const source: LeaseSpanSource = {
      currentSnapshotHash: "S",
      leaseFor: (anchor) => leases[anchor],
      rebasedLineOf: (lineId) => lineId,
      anchorHomes: () => [],
    };
    const snap = (hashes: string[], path: string) => ({
      fileHashes: hashes,
      fileLines: lines,
      filePath: path,
    });
    const rA = resolveLeasedEdit({
      edit: resEdit({ anchor_from: hA[0]!, anchor_to: hA[1]!, text: "X" }),
      snapshot: snap(hA, "c4a.ts"),
      served: hA,
      source,
    });
    const rB = resolveLeasedEdit({
      edit: resEdit({ anchor_from: hB[0]!, anchor_to: hB[1]!, text: "X" }),
      snapshot: snap(hB, "c4b.ts"),
      served: hB,
      source,
    });
    // WHY: each file's own anchors resolve fast against its own leases.
    expect(rA.status).toBe("fast");
    expect(rB.status).toBe("fast");
    expect(rA.resolved?.hash_bounds.map((b) => b.line)).toEqual([1, 2]);
    expect(rB.resolved?.hash_bounds.map((b) => b.line)).toEqual([1, 2]);
  });

  it("C6: lexical spellings of one path derive identical anchors", () => {
    // WHY: `canonicalAnchorPath` resolves lexically — `.`/`..` spellings and a
    // WHY: trailing separator seed identically (no realpath, no cwd).
    const content = "x\ny\nz\n";
    const plain = fileHashesFor("/x/a.ts", content);
    expect(fileHashesFor("/x/./a.ts", content)).toEqual(plain);
    expect(fileHashesFor("/x/b/../a.ts", content)).toEqual(plain);
    expect(fileHashesFor("/x/a.ts/", content)).toEqual(plain);
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
