import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import type { ViewOp } from "../../src/bash-classifier.js";
import { assertNever } from "../../src/utils.js";
import { useTestHome, withTempDir } from "../support/fixtures";

useTestHome();

// WHY: (#175) local copies of the bash-view-lifecycle idiom — the seam under test grants no
// WHY: exports for these, so the suite owns its helpers rather than importing producers.
function makeFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<string, unknown>();
  return {
    pi: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    } as any,
    handlers,
    getTool(name: string) {
      return tools.get(name) as {
        execute: (
          id: string,
          params: unknown,
          ...rest: unknown[]
        ) => Promise<{ content?: unknown; details?: any; isError?: boolean }>;
      };
    },
  };
}

function rowsOf(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("│"));
}

// WHY: (#175) content after the LAST anchor separator — rows whose text itself contains `│`
// WHY: still extract exactly, so geometry-mimicking content cannot confuse the oracle.
function rowContent(row: string): string {
  return row.split("│").slice(1).join("│");
}

// WHY: (#175) the anchor half of a rendered row — asserted against independently derived
// WHY: anchors per coordinate, so a row served under the wrong file's anchor is visible even
// WHY: when the bytes are identical across files.
function rowAnchor(row: string): string {
  return row.split("│")[0]!;
}
async function bashResult(
  handler: (...args: unknown[]) => unknown,
  command: string,
  ctx: { cwd: string; sessionManager: { getSessionId(): string } },
  stdout: string,
) {
  return (await handler!(
    {
      toolName: "bash",
      isError: false,
      input: { command },
      content: [{ type: "text", text: stdout }],
    },
    ctx,
  )) as { content: Array<{ type: string; text: string }> } | undefined;
}

// WHY: (#175) the suite's own normalization — the same D9 contract the seams apply, written
// WHY: out by hand so the oracle never imports the production normalizer it audits.
function normText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

async function diskLines(dir: string, file: string): Promise<string[]> {
  const raw = await readFile(join(dir, file), "utf-8");
  return splitNormLines(normText(raw));
}
function splitNormLines(norm: string): string[] {
  if (norm === "") return [];
  const parts = norm.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// WHY: (#175) intervals from COUNTERS only — cumulative byte lengths over the normalized
// WHY: stream, never content matching. Returns one [lo, hi) per observed line and asserts the
// WHY: separators are exactly the stream's newlines.
function observedIntervals(norm: string): Array<{ lo: number; hi: number }> {
  const lines = splitNormLines(norm);
  const out: Array<{ lo: number; hi: number }> = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lo = pos;
    const hi = lo + line.length;
    out.push({ lo, hi });
    pos = hi + 1;
  }
  // WHY: (#175) this scan is a different mechanism from the split walk above — it reads the
  // WHY: stream's own newline offsets, so a dropped separator, a merged row or an off-by-one
  // WHY: in the walk fails here instead of hiding behind the same counters.
  const expected: Array<{ lo: number; hi: number }> = [];
  let start = 0;
  for (;;) {
    const next = norm.indexOf("\n", start);
    const end = next === -1 ? norm.length : next;
    if (!(start === norm.length && norm.endsWith("\n"))) expected.push({ lo: start, hi: end });
    if (next === -1) break;
    start = next + 1;
  }
  expect(out).toEqual(expected);
  return out;
}

let sessionSeq = 0;
function freshSession(tag: string) {
  sessionSeq += 1;
  const id = `attr175-${tag}-${sessionSeq}`;
  return { cwd: "", sessionManager: { getSessionId: () => id } };
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const abs = join(dir, name);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf-8");
  }
}

function realStdout(dir: string, command: string): string {
  return execFileSync("bash", ["-c", command], { cwd: dir, encoding: "utf-8" }) as string;
}

async function serveOnce(
  dir: string,
  command: string,
  observed: string,
  tag: string,
): Promise<{
  result: { content: Array<{ type: string; text: string }> } | undefined;
  editTool: ReturnType<ReturnType<typeof makeFakePi>["getTool"]>;
  ctx: { cwd: string; sessionManager: { getSessionId(): string } };
}> {
  const { pi, handlers, getTool } = makeFakePi();
  register(pi);
  const base = freshSession(tag);
  const ctx = { cwd: dir, sessionManager: base.sessionManager };
  const result = await bashResult(handlers.get("tool_result")!, command, ctx, observed);
  return { result, editTool: getTool("edit"), ctx };
}

// WHY: (#175) one isolated lease probe per (file, line): a fresh directory with byte-identical
// WHY: files and a fresh session re-serve the SAME observed bytes, then attempt exactly one edit.
// WHY: Isolation means a successful probe can never mutate the file a later probe reads, and a
// WHY: fresh session means leases cannot leak between probes — the probe reads the lease set,
// WHY: never the producer's word for it.
async function probeLease(
  files: Record<string, string>,
  command: string,
  observed: string,
  file: string,
  line1: number,
  tag: string,
): Promise<boolean> {
  let leased = false;
  await withTempDir("attr175-probe-", async (dir) => {
    await writeFiles(dir, files);
    const { result, editTool, ctx } = await serveOnce(dir, command, observed, `${tag}-p${line1}`);
    if (result === undefined) {
      leased = false;
      return;
    }
    const hashes = await lineHashes(files[file]!, join(dir, file));
    const anchor = hashes[line1 - 1];
    if (anchor === undefined) {
      leased = false;
      return;
    }
    try {
      const out = await editTool.execute(
        "e0",
        { file, edits: [{ anchor_from: anchor, anchor_to: anchor, text: "ATTR175PROBE" }] },
        undefined,
        undefined,
        ctx,
      );
      leased = out.isError !== true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("E_UNKNOWN_ANCHOR")) leased = false;
      else throw error;
    }
  });
  return leased;
}

type Shape = "view" | "numbered" | "search" | "triple" | "contentSet" | "compound" | "raw";

interface MatrixCase {
  name: string;
  files: Record<string, string>;
  command: string;
  shape: Shape;
  // WHY: 1-indexed leased lines per file under a SERVE; empty under RAW.
  served: Record<string, number[]>;
  // WHY: the compound glue literal lives on the record — one owner — so block extents are
  // WHY: fully derived, never half-hardcoded in the arm. Absent except on `compound` cases.
  glue?: string;
}

const L6 = "l1\nl2\nl3\nl4\nl5\nl6\n";

const MATRIX: MatrixCase[] = [
  {
    name: "cat basic",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1, 2, 3] },
  },
  {
    name: "head slice",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "head -n 2 f.txt",
    shape: "view",
    served: { "f.txt": [1, 2] },
  },
  {
    name: "tail slice",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "tail -n 2 f.txt",
    shape: "view",
    served: { "f.txt": [2, 3] },
  },
  {
    name: "sed range",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "sed -n '2,3p' f.txt",
    shape: "view",
    served: { "f.txt": [2, 3] },
  },
  {
    name: "missing trailing newline",
    files: { "f.txt": "a1" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1] },
  },
  {
    name: "crlf normalized",
    files: { "f.txt": "c1\r\nc2\r\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1, 2] },
  },
  {
    name: "bom stripped",
    files: { "f.txt": "﻿b1\nb2\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1, 2] },
  },
  {
    name: "empty line kept",
    files: { "f.txt": "e1\n\ne3\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1, 2, 3] },
  },
  {
    name: "one empty line",
    files: { "f.txt": "\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1] },
  },
  {
    name: "colon tab pipe content",
    files: { "f.txt": "5:foo\nplain\ta│b\n5\tfoo\n" },
    command: "cat f.txt",
    shape: "view",
    served: { "f.txt": [1, 2, 3] },
  },
  {
    name: "cat -n numbered",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "cat -n f.txt",
    shape: "numbered",
    served: { "f.txt": [1, 2, 3] },
  },
  {
    name: "nl numbered",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "nl -ba f.txt",
    shape: "numbered",
    served: { "f.txt": [1, 2, 3] },
  },
  {
    name: "grep single",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "grep -n l2 f.txt",
    shape: "search",
    served: { "f.txt": [2] },
  },
  {
    name: "grep duplicates",
    files: { "f.txt": "dup\ndup\nuniq\n" },
    command: "grep -n dup f.txt",
    shape: "search",
    served: { "f.txt": [1, 2] },
  },
  {
    name: "grep geometry-mimic text",
    files: { "f.txt": "5:foo\nplain\n5\tfoo\n" },
    command: "grep -n foo f.txt",
    shape: "search",
    served: { "f.txt": [1, 3] },
  },
  {
    name: "pipelined head slice",
    files: { "f.txt": "l1\nl2\nl3\n" },
    command: "grep -n l f.txt | head -2",
    shape: "search",
    served: { "f.txt": [1, 2] },
  },
  {
    name: "sort -u set",
    files: { "f.txt": "dup\ndup\nuniq\n" },
    command: "cat f.txt | sort -u",
    shape: "contentSet",
    served: { "f.txt": [1, 3] },
  },
  {
    name: "uniq runs",
    files: { "f.txt": "dup\ndup\nuniq\n" },
    command: "cat f.txt | uniq",
    shape: "contentSet",
    served: { "f.txt": [1, 3] },
  },
  {
    name: "multi identical files",
    files: { "a.txt": "l1\nl2\nl3\n", "b.txt": "l1\nl2\nl3\n" },
    command: "grep -n l2 a.txt b.txt",
    shape: "triple",
    served: { "a.txt": [2], "b.txt": [2] },
  },
  {
    name: "multi shared row",
    files: { "a.txt": "x\ncommon\n", "b.txt": "common\ny\n" },
    command: "grep -n common a.txt b.txt",
    shape: "triple",
    served: { "a.txt": [2], "b.txt": [1] },
  },
  {
    name: "recursive walk",
    files: { "sub/ok.txt": "l1\nl2\n" },
    command: "grep -rn l2 sub",
    shape: "triple",
    served: { "sub/ok.txt": [2] },
  },
  {
    name: "bare two-view chain is raw",
    files: { "a.txt": "l1\n", "b.txt": "l1\n" },
    command: "cat a.txt && cat b.txt",
    shape: "raw",
    served: {},
  },
  {
    name: "bare two-sed chain is raw",
    files: { "f.txt": L6 },
    command: "sed -n '1,2p' f.txt && sed -n '5,6p' f.txt",
    shape: "raw",
    served: {},
  },
  {
    name: "glued two-sed compound serves per block",
    files: { "f.txt": L6 },
    command: "printf \"h\\n\"; sed -n '1,2p' f.txt; sed -n '5,6p' f.txt",
    shape: "compound",
    served: { "f.txt": [1, 2, 5, 6] },
    glue: "h\n",
  },
];

describe("bash serve attribution invariant (#175)", () => {
  for (const c of MATRIX) {
    it(`matrix: ${c.name} — two outcomes, geometry, byte identity, bijection`, async () => {
      await withTempDir("attr175-matrix-", async (dir) => {
        await writeFiles(dir, c.files);
        // WHY: (#175) the oracle is the actual binary, not a hand-written string — independence
        // WHY: of instrument: the test never trusts the producer's bytes for `observed`.
        const observed = realStdout(dir, c.command);
        const norm = normText(observed);
        const { result } = await serveOnce(dir, c.command, observed, "matrix");
        const expectServe = Object.values(c.served).some((lines) => lines.length > 0);

        if (!expectServe) {
          // WHY: raw branch — pass-through with zero leases anywhere.
          expect(result).toBeUndefined();
          for (const [file, content] of Object.entries(c.files)) {
            const lines = splitNormLines(normText(content));
            for (let i = 1; i <= lines.length; i++) {
              expect(await probeLease(c.files, c.command, observed, file, i, "matrix-raw")).toBe(
                false,
              );
            }
          }
          return;
        }

        expect(result).toBeDefined();
        const text = result!.content[0]!.text;
        const rows = rowsOf(text);
        const servedContents = rows.map(rowContent);

        // WHY: (#175) independent geometry per shape — intervals from counters, content mapping
        // WHY: from the shape's own normalization, never the production parsers.
        const lines = splitNormLines(norm);
        const intervals = observedIntervals(norm);
        expect(intervals).toHaveLength(lines.length);

        if (c.shape === "view") {
          // WHY: a view owns the whole stream: row i IS observed line i, in order.
          const file = Object.keys(c.files)[0]!;
          const onDisk = await diskLines(dir, file);
          const want = c.served[file]!.map((n) => onDisk[n - 1]!);
          expect(lines).toEqual(want);
          expect(servedContents).toEqual(want);
        } else if (c.shape === "numbered") {
          // WHY: the `%6d\t` number field is display geometry of fixed width 7 — the content
          // WHY: starts at a counter-derived offset, never a content match.
          const file = Object.keys(c.files)[0]!;
          const onDisk = await diskLines(dir, file);
          const want = c.served[file]!.map((n) => onDisk[n - 1]!);
          expect(lines).toHaveLength(want.length);
          for (let i = 0; i < lines.length; i++) {
            expect(lines[i]!.slice(0, 7)).toBe(`${String(i + 1).padStart(6)}\t`);
            expect(lines[i]!.slice(7)).toBe(want[i]);
            const iv = intervals[i]!;
            expect(norm.slice(iv.lo, iv.lo + 7)).toBe(`${String(i + 1).padStart(6)}\t`);
            expect(norm.slice(iv.lo + 7, iv.hi)).toBe(want[i]);
          }
          expect(servedContents).toEqual(want);
        } else if (c.shape === "search") {
          // WHY: `digits(line)+1` is the label width — derived from the LEASED line number
          // WHY: (a counter), so a row whose text starts `5:foo` cannot shift the split.
          const file = Object.keys(c.files)[0]!;
          const onDisk = await diskLines(dir, file);
          const leased = c.served[file]!;
          expect(lines).toHaveLength(leased.length);
          for (let i = 0; i < leased.length; i++) {
            const n = leased[i]!;
            const prefix = `${n}:`;
            expect(lines[i]!.slice(0, prefix.length)).toBe(prefix);
            expect(lines[i]!.slice(prefix.length)).toBe(onDisk[n - 1]);
            const iv = intervals[i]!;
            expect(norm.slice(iv.lo, iv.lo + prefix.length)).toBe(prefix);
            expect(norm.slice(iv.lo + prefix.length, iv.hi)).toBe(onDisk[n - 1]);
          }
          expect(servedContents).toEqual(leased.map((n) => onDisk[n - 1]!));
        } else if (c.shape === "contentSet") {
          // WHY: a reordering fold owns no per-row stream order — every served row must still be
          // WHY: byte-identical to its disk line, and the multiset must equal the observed set.
          const file = Object.keys(c.files)[0]!;
          const onDisk = await diskLines(dir, file);
          expect([...servedContents].sort()).toEqual([...lines].sort());
          const leased = c.served[file]!;
          expect(servedContents).toHaveLength(leased.length);
          for (const n of leased) {
            expect(servedContents).toContain(onDisk[n - 1]);
          }
        } else if (c.shape === "triple") {
          // WHY: `file + ":" + digits(line) + ":"` — both widths from counters (the display
          // WHY: name length, the leased line digits), so equal bytes across files keep distinct
          // WHY: intervals and the lease resolves per file, never per content.
          // WHY: Anchor identity per rendered row: coordinates are recovered in observed order
          // WHY: by matching declared `file:line:` prefixes (candidates from the declared set,
          // WHY: never a general parser), then each rendered hash must equal the independently
          // WHY: derived anchor for that coordinate — independent of content, so a swap under
          // WHY: identical bytes is visible as a hash mismatch, not hidden by `toContain`.
          const pending: Array<{ file: string; line: number }> = [];
          for (const [file, leased] of Object.entries(c.served)) {
            for (const n of leased) pending.push({ file, line: n });
          }
          const coords: Array<{ file: string; line: number }> = [];
          for (const observedLine of lines) {
            // WHY: the recovery must be unambiguous — a nesting pair of declared prefixes fails
            // WHY: loudly here instead of mis-assigning the row to the shorter coordinate.
            expect(
              pending.filter((p) => observedLine.startsWith(`${p.file}:${p.line}:`)),
            ).toHaveLength(1);
            const idx = pending.findIndex((p) => observedLine.startsWith(`${p.file}:${p.line}:`));
            coords.push(pending.splice(idx, 1)[0]!);
          }
          expect(pending).toHaveLength(0);
          expect(rows).toHaveLength(coords.length);
          const onDiskByFile = new Map<string, string[]>();
          const hashesByFile = new Map<string, string[]>();
          for (const file of Object.keys(c.served)) {
            onDiskByFile.set(file, await diskLines(dir, file));
            hashesByFile.set(file, await lineHashes(c.files[file]!, join(dir, file)));
          }
          // WHY: per-file row counts in render order — every declared coordinate renders once.
          for (const [file, leased] of Object.entries(c.served)) {
            expect(
              coords
                .filter((coord) => coord.file === file)
                .map((coord) => coord.line)
                .sort((a, b) => a - b),
            ).toEqual([...leased].sort((a, b) => a - b));
          }
          for (let i = 0; i < rows.length; i++) {
            const coord = coords[i]!;
            expect(rowContent(rows[i]!)).toBe(onDiskByFile.get(coord.file)![coord.line - 1]);
            expect(rowAnchor(rows[i]!)).toBe(hashesByFile.get(coord.file)![coord.line - 1]);
          }
        } else if (c.shape === "compound") {
          // WHY: block extents derived from LENGTHS — the glue literal length plus each block's
          // WHY: re-read disk-slice byte length — then every slice is asserted against the re-read
          // WHY: disk bytes and the extents must tile the stream exactly. Equal bytes in different
          // WHY: blocks keep different intervals by construction, never by content matching.
          const onDisk = await diskLines(dir, "f.txt");
          // WHY: the glue literal comes from the case record — the arm derives everything else.
          const glue = c.glue!;
          const block1 = `${onDisk[0]}\n${onDisk[1]}\n`;
          const block2 = `${onDisk[4]}\n${onDisk[5]}\n`;
          expect(norm.slice(0, glue.length)).toBe(glue);
          expect(norm.slice(glue.length, glue.length + block1.length)).toBe(block1);
          expect(norm.slice(glue.length + block1.length)).toBe(block2);
          expect(glue.length + block1.length + block2.length).toBe(norm.length);
          expect(servedContents).toEqual([onDisk[0], onDisk[1], onDisk[4], onDisk[5]]);
        } else if (c.shape === "raw") {
          // WHY: unreachable — raw cases return early above; the arm exists so the final
          // WHY: `satisfies never` stays total over `Shape` and a new shape breaks typecheck.
          throw new Error("raw cases return early");
        } else {
          throw new Error(`unhandled shape ${c.shape satisfies never}`);
        }

        // WHY: (#175) byte identity + bijection — every served row equals the independently
        // WHY: re-read disk line, and the probed lease set equals exactly the declared set.
        for (const [file, leased] of Object.entries(c.served)) {
          const onDisk = await diskLines(dir, file);
          const total = onDisk.length;
          for (let n = 1; n <= total; n++) {
            const want = leased.includes(n);
            expect(await probeLease(c.files, c.command, observed, file, n, "matrix")).toBe(want);
          }
        }
      });
    });
  }

  it("negative control: one mutated byte fails closed with zero leases", async () => {
    await withTempDir("attr175-neg-", async (dir) => {
      const files = { "f.txt": "l1\nl2\nl3\n" };
      await writeFiles(dir, files);
      const command = "cat f.txt";
      const observed = realStdout(dir, command);
      // WHY: control first — the unmutated bytes serve, so the refusal below is the mutation's
      // WHY: doing and not a dead path that refuses everything.
      const control = await serveOnce(dir, command, observed, "neg-ctl");
      expect(control.result).toBeDefined();
      const mutated = `${observed.slice(0, 1)}X${observed.slice(2)}`;
      expect(mutated).not.toBe(observed);
      const { result } = await serveOnce(dir, command, mutated, "neg");
      expect(result).toBeUndefined();
      for (let n = 1; n <= 3; n++) {
        expect(await probeLease(files, command, mutated, "f.txt", n, "neg")).toBe(false);
      }
    });
  });

  it("G1 twin dot-root: recursive spellings are ambiguous too", async () => {
    await withTempDir("attr175-g1dot-", async (dir) => {
      // WHY: `admitted` displays are `path.join`-normalized (`a`) while bash echoes the operand
      // WHY: spelling (`./a` for a `.` root) — a pre-filter comparing those two strings never
      // WHY: examines a candidate, so the guard would be inert for dot roots. Candidates are
      // WHY: resolved, never display-matched.
      const files = { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" };
      await writeFiles(dir, files);
      const command = "grep -rn x .";
      const observed = realStdout(dir, command);
      expect(observed).toBe("./a:1:b.txt:3:x\n./a:1:b.txt:3:x\n");
      const { result } = await serveOnce(dir, command, observed, "g1dot");
      expect(result).toBeUndefined();
      expect(await probeLease(files, command, observed, "a", 1, "g1dot")).toBe(false);
      expect(await probeLease(files, command, observed, "a:1:b.txt", 3, "g1dot")).toBe(false);
    });
    await withTempDir("attr175-g1dotctl-", async (dir) => {
      // WHY: dot-root control — one admitted split still serves. The phantom `./a:1:b.txt`
      // WHY: candidate resolves nowhere and is skipped, never refused: a throw is not ambiguity.
      const files = { a: "b.txt:3:x\n", "other.txt": "q\n" };
      await writeFiles(dir, files);
      const command = "grep -rn x .";
      const observed = realStdout(dir, command);
      expect(observed).toBe("./a:1:b.txt:3:x\n");
      const { result } = await serveOnce(dir, command, observed, "g1dotctl");
      expect(result).toBeDefined();
      expect(await probeLease(files, command, observed, "a", 1, "g1dotctl")).toBe(true);
    });
  });

  it("triple ordering: descending rows for one file fail closed; ascending serves", async () => {
    // WHY: (serve-seam rule, one served row per file line) rows within a file arrive contiguous
    // WHY: and ascending for every admitted `grep`/`rg` shape — the check runs AFTER the repeat
    // WHY: dedupe (`grep -n pat a a` repeats a coordinate legitimately), so only a reordering
    // WHY: wrapper fails closed here, with zero leases.
    const files = { "a.txt": "l1\nl2\n", "b.txt": "l3\n" };
    await withTempDir("attr175-tord-", async (dir) => {
      await writeFiles(dir, files);
      const command = "grep -n l a.txt b.txt";
      const descending = "a.txt:2:l2\na.txt:1:l1\nb.txt:1:l3\n";
      expect((await serveOnce(dir, command, descending, "tord")).result).toBeUndefined();
      expect(await probeLease(files, command, descending, "a.txt", 2, "tord")).toBe(false);
      expect(await probeLease(files, command, descending, "a.txt", 1, "tord")).toBe(false);
    });
    await withTempDir("attr175-tordctl-", async (dir) => {
      await writeFiles(dir, files);
      const command = "grep -n l a.txt b.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a.txt:1:l1\na.txt:2:l2\nb.txt:1:l3\n");
      const { result } = await serveOnce(dir, command, observed, "tordctl");
      expect(result).toBeDefined();
      expect(await probeLease(files, command, observed, "a.txt", 2, "tordctl")).toBe(true);
    });
  });

  it("G1 twin: the ambiguous triple fails closed; single-split control still serves", async () => {
    await withTempDir("attr175-g1-", async (dir) => {
      // WHY: (ADR-0042 D1 — bash serve admission; pending merge) never content matching, no other-file anchor bleed — file `a` line 1
      // WHY: (`b.txt:3:x`) and file `a:1:b.txt` line 3 (`x`) produce the identical stdout row
      // WHY: `a:1:b.txt:3:x`, so serving it under either coordinate witnesses bytes bash never
      // WHY: anchored to that file. Fail closed with zero leases.
      await writeFiles(dir, { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" });
      const command = "grep -n x a 'a:1:b.txt'";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a:1:b.txt:3:x\na:1:b.txt:3:x\n");
      const { result } = await serveOnce(dir, command, observed, "g1");
      expect(result).toBeUndefined();
      expect(
        await probeLease(
          { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" },
          command,
          observed,
          "a",
          1,
          "g1",
        ),
      ).toBe(false);
      expect(
        await probeLease(
          { a: "b.txt:3:x\n", "a:1:b.txt": "y\nz\nx\n" },
          command,
          observed,
          "a:1:b.txt",
          3,
          "g1",
        ),
      ).toBe(false);
    });
    await withTempDir("attr175-g1ctl-", async (dir) => {
      // WHY: adjacent control — only one split resolves into the admitted set, so the row is
      // WHY: unambiguous and still serves. Proves the guard is not a blanket multi-file refusal.
      const files = { a: "b.txt:3:x\n", "other.txt": "q\n" };
      await writeFiles(dir, files);
      const command = "grep -n x a other.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a:1:b.txt:3:x\n");
      const { result } = await serveOnce(dir, command, observed, "g1ctl");
      expect(result).toBeDefined();
      expect(await probeLease(files, command, observed, "a", 1, "g1ctl")).toBe(true);
    });
  });

  it("G2: descending and duplicate search rows fail closed; ascending serves", async () => {
    const files = { "f.txt": "l1\nl2\nl3\n" };
    // WHY: (serve-seam rule, one served row per file line — ADR-0042, bash serve admission,
    // WHY: pending merge, states the no-bleed invariant, not an ordering clause) the printed
    // WHY: number is a LABEL whose order is proven by the stream, not by matching content —
    // WHY: descending or repeated labels own no disjoint ordered intervals and no lease↔row
    // WHY: bijection, even when every row byte-matches disk. Real grep/rg on one file always
    // WHY: print ascending, so no served call regresses.
    await withTempDir("attr175-g2-", async (dir) => {
      await writeFiles(dir, files);
      expect(
        (await serveOnce(dir, "grep -n l f.txt", "3:l3\n1:l1\n", "g2desc")).result,
      ).toBeUndefined();
      expect(
        (await serveOnce(dir, "grep -n l f.txt", "2:l2\n2:l2\n", "g2dup")).result,
      ).toBeUndefined();
      expect(await probeLease(files, "grep -n l f.txt", "3:l3\n1:l1\n", "f.txt", 3, "g2desc")).toBe(
        false,
      );
      expect(await probeLease(files, "grep -n l f.txt", "3:l3\n1:l1\n", "f.txt", 1, "g2desc")).toBe(
        false,
      );
    });
    await withTempDir("attr175-g2ctl-", async (dir) => {
      await writeFiles(dir, files);
      const observed = realStdout(dir, "grep -n l f.txt");
      expect(observed).toBe("1:l1\n2:l2\n3:l3\n");
      const { result } = await serveOnce(dir, "grep -n l f.txt", observed, "g2ctl");
      expect(result).toBeDefined();
      expect(await probeLease(files, "grep -n l f.txt", observed, "f.txt", 2, "g2ctl")).toBe(true);
    });
  });

  it("count is the single exempt shape: number witnessed, rows in file order, all leased", async () => {
    // WHY: (#175) `wc -l` prints the NUMBER, not the content — no observed interval exists for a
    // WHY: row. The closed exemption: count == survivor fold length, file-order render, every
    // WHY: counted row leased. The total switch below makes a sixth ViewOp kind a type error,
    // WHY: so no new op can silently join the exemption.
    function exemptKind(op: ViewOp): "count" | "other" {
      switch (op.kind) {
        case "count":
          return "count";
        case "keep":
        case "drop":
        case "sortUnique":
        case "uniq":
        case "first":
        case "last":
        case "from":
        case "dropLast":
        case "range":
          return "other";
        default:
          return assertNever(op);
      }
    }
    expect(exemptKind({ kind: "count" })).toBe("count");
    expect(exemptKind({ kind: "first", n: 2 })).toBe("other");
    expect(exemptKind({ kind: "sortUnique" })).toBe("other");

    await withTempDir("attr175-count-", async (dir) => {
      const files = { "f.txt": "dup\ndup\nuniq\n" };
      await writeFiles(dir, files);
      const command = "cat f.txt | sort -u | wc -l";
      const observed = realStdout(dir, command);
      expect(observed.trim()).toBe("2");
      const { result } = await serveOnce(dir, command, observed, "count");
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      // WHY: file-order render of the counted fold: dup@1 before uniq@3.
      expect(rows.map(rowContent)).toEqual(["dup", "uniq"]);
      for (let n = 1; n <= 3; n++) {
        expect(await probeLease(files, command, observed, "f.txt", n, "count")).toBe(n !== 2);
      }
    });
  });

  it("prefix pin: corrupted second block keeps block 1 leases, raw tail unleased", async () => {
    // WHY: (ADR-0039 D4) a failing block halts the peel — the proven prefix keeps its leases
    // WHY: (each proven before its own first lease) and the failing block plus remainder stay raw.
    await withTempDir("attr175-prefix-", async (dir) => {
      const files = { "f.txt": L6 };
      await writeFiles(dir, files);
      const command = "printf \"h\\n\"; sed -n '1,2p' f.txt; sed -n '5,6p' f.txt";
      const bad = `h\nl1\nl2\nl5\nCORRUPT\n`;
      const { result } = await serveOnce(dir, command, bad, "prefix");
      expect(result).toBeDefined();
      const text = result!.content[0]!.text;
      // WHY: exactly one anchored view block (the verified prefix); the corrupt tail stays raw.
      expect(rowsOf(text).map(rowContent)).toEqual(["l1", "l2"]);
      expect(text.includes("CORRUPT")).toBe(true);
      expect(await probeLease(files, command, bad, "f.txt", 1, "prefix")).toBe(true);
      expect(await probeLease(files, command, bad, "f.txt", 5, "prefix")).toBe(false);
      expect(await probeLease(files, command, bad, "f.txt", 6, "prefix")).toBe(false);
    });
    await withTempDir("attr175-prefix0-", async (dir) => {
      // WHY: corrupted FIRST block — nothing was proven, so the whole command is raw, zero leases.
      const files = { "f.txt": L6 };
      await writeFiles(dir, files);
      const command = "printf \"h\\n\"; sed -n '1,2p' f.txt; sed -n '5,6p' f.txt";
      const bad = `h\nCORRUPT\nl2\nl5\nl6\n`;
      const { result } = await serveOnce(dir, command, bad, "prefix0");
      expect(result).toBeUndefined();
      for (let n = 1; n <= 6; n++) {
        expect(await probeLease(files, command, bad, "f.txt", n, "prefix0")).toBe(false);
      }
    });
  });

  it("per-file isolation: identical bytes lease per file, never across", async () => {
    await withTempDir("attr175-xfile-", async (dir) => {
      const files = { "a.txt": "same\n", "b.txt": "same\n" };
      await writeFiles(dir, files);
      const command = "grep -n same a.txt b.txt";
      const observed = realStdout(dir, command);
      expect(observed).toBe("a.txt:1:same\nb.txt:1:same\n");
      const { result, editTool, ctx } = await serveOnce(dir, command, observed, "xfile");
      expect(result).toBeDefined();
      const rows = rowsOf(result!.content[0]!.text);
      expect(rows).toHaveLength(2);
      const hashesA = await lineHashes(files["a.txt"]!, join(dir, "a.txt"));
      const anchorA = hashesA[0]!;
      // WHY: a's anchor authorizes a — and the same bytes never authorize b.
      const ok = await editTool.execute(
        "e1",
        { file: "a.txt", edits: [{ anchor_from: anchorA, anchor_to: anchorA, text: "A" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(ok.isError).toBeFalsy();
    });
    await withTempDir("attr175-xfile2-", async (dir) => {
      const files = { "a.txt": "same\n", "b.txt": "same\n" };
      await writeFiles(dir, files);
      const command = "grep -n same a.txt b.txt";
      const observed = realStdout(dir, command);
      const { editTool, ctx } = await serveOnce(dir, command, observed, "xfile2");
      const hashesA = await lineHashes(files["a.txt"]!, join(dir, "a.txt"));
      const anchorA = hashesA[0]!;
      // WHY: the other-file direction — a's anchor against b is refused, even with equal bytes.
      // WHY: `E_FOREIGN_ANCHOR` (not unknown): the lease exists but is bound to a's path.
      // WHY: (see edit.foreign-attribution.test.ts for the code's own pin).
      await expect(
        editTool.execute(
          "e0",
          { file: "b.txt", edits: [{ anchor_from: anchorA, anchor_to: anchorA, text: "B" }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("E_FOREIGN_ANCHOR");
    });
  });
});
