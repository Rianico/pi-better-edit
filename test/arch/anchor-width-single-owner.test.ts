import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { ALPHA, HASH_CLASS, HASH_LEN, HASH_RE } from "../../src/hashline/alphabet.js";
import { ANCHOR_LEN, HASH_SPACE, MAX_HASH_LINES } from "../../src/hashline/hash-identity.js";
import { HASH_PROBE_STRIDE } from "../../src/hashline/index.js";

function srcFiles(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

type AnyNode = Record<string, unknown>;

function walk(node: unknown, visit: (node: AnyNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as AnyNode;
  if (typeof record.type === "string") visit(record);
  for (const key of Object.keys(record)) {
    if (key === "loc") continue;
    walk(record[key], visit);
  }
}

// WHY: the two hand-rolled width shapes this guard exists to kill — a `3-char`
// WHY: / `4-char` count word restates the width instead of deriving it from
// WHY: `HASH_LEN`, and a `[class]{3}` / `[class]{4}` regex is a second owner of
// WHY: the anchor shape beside `HASH_RE`. Either would let a width flip leave a
// WHY: stale 3 behind (or ship a mixed-width build), so both are refused.
const COUNT_WORD_RE = /(^|[^A-Za-z0-9])[34]-char/;
const CLASS_QUANTIFIER_RE = /\[[^\]]*\]\{(3|4)\}/;

function scanTextForWidthLiterals(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    if (COUNT_WORD_RE.test(line)) hits.push(`count-word: ${line.trim()}`);
    if (CLASS_QUANTIFIER_RE.test(line)) hits.push(`class-quantifier: ${line.trim()}`);
  }
  return hits;
}

describe("anchor width single owner", () => {
  it("derives the hash space, line cap, and shape from HASH_LEN", () => {
    // WHY: `HASH_SPACE` is the lease capacity — a restated literal here would
    // WHY: cap serves at the wrong width the moment `HASH_LEN` flips.
    expect(HASH_SPACE).toBe(ALPHA.length ** HASH_LEN);
    // WHY: `MAX_HASH_LINES` gates allocation against the same space — drift
    // WHY: between the two would refuse files one seam claims to support.
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
    // WHY: `ANCHOR_LEN` is the parse-time alias the copy derives its count
    // WHY: word from — a second width constant would fork model-facing copy.
    expect(ANCHOR_LEN).toBe(HASH_LEN);
    // WHY: `HASH_CLASS` is the one shape regex — a hand-rolled class here
    // WHY: would accept/reject a different token set than the leases store.
    expect(HASH_CLASS).toBe(`[${ALPHA.replace(/-/g, "\\-")}]{${HASH_LEN}}`);
    // WHY: the shape accepts exactly one width — a wider/narrower match would
    // WHY: admit foreign-width anchors into the lease path (or refuse our own).
    expect(HASH_RE.test("aB3")).toBe(true);
    expect(HASH_RE.test("aB3".padEnd(HASH_LEN + 1, "X"))).toBe(false);
  });

  it("derives the probe stride from the alphabet, never a literal", () => {
    // WHY: the stride spaces the open-addressing probe over the full hash
    // WHY: space — a restated `3907` would probe the wrong lattice at a new
    // WHY: width and silently degrade allocation to linear scan or collision.
    expect(HASH_PROBE_STRIDE).toBe(ALPHA.length ** 2 + ALPHA.length + 1);
  });

  it("keeps src/hashline/alphabet.ts a zero-import leaf", () => {
    // WHY: `domain-errors.ts` throws from every seam, so it can only depend on
    // WHY: a leaf — a single transitive import here would drag a store,
    // WHY: session, or hasher into every rejection path.
    const code = readFileSync(join("src", "hashline", "alphabet.ts"), "utf-8");
    const program = parse(code, {
      sourceType: "module",
      plugins: ["typescript"],
    }).program as unknown as AnyNode;
    const imports: string[] = [];
    walk(program, (node) => {
      if (node.type === "ImportDeclaration") imports.push(String((node.source as AnyNode)?.value));
    });
    expect(imports).toEqual([]);
  });

  it("has no hand-rolled anchor-width literal under src/", () => {
    // WHY: every `N-char` count word and every `[class]{N}` shape outside the
    // WHY: alphabet leaf is a second owner of the width — the flip to 4 must
    // WHY: propagate from `HASH_LEN` alone, so the scanner below must stay empty.
    // WHY: allowlist: `TEMP_UUID_RE` is a UUIDv4 filename shape (`{4}` hex
    // WHY: groups), not an anchor width — it cannot drift with `HASH_LEN` and
    // WHY: narrowing the scanner to spare it would also spare real violations.
    const violations: string[] = [];
    for (const file of srcFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const hit of scanTextForWidthLiterals(text)) {
        if (hit.includes("TEMP_UUID_RE")) continue;
        violations.push(`${file}: ${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("negative control: the scanner helper detects planted width literals", () => {
    // WHY: a guard that cannot fire is decoration — the planted pair below is
    // WHY: exactly what the file walk must catch, so a neutered regex fails here.
    const planted = [
      "reason: `Pass the bare 4-char anchor and retry.`",
      "const SHAPE = /^[A-Za-z0-9]{4}$/;",
    ].join("\n");
    const hits = scanTextForWidthLiterals(planted);
    expect(hits).toHaveLength(2);
    expect(scanTextForWidthLiterals("no width here")).toEqual([]);
  });
});
