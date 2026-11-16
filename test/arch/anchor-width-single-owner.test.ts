/**
 * Width has ONE owner, `HASH_LEN`; this file guards it. Any `src/` line: count-word,
 * count-word-space, class-quantifier (`N-char(s)`, `N chars`, `[class]{N}` off the live
 * width). Src-wide with zero live hits, because they name the former owner exactly:
 * anchor-assign and stride-assign (`ANCHOR_WIDTH = 3`, `HASH_PROBE_STRIDE = 3907`).
 * Anchor-shape surface only (`src/hashline/**` plus `src/served-session/serve-render.ts`),
 * since those shapes match innocent code elsewhere: text-index, slice-prefix,
 * slice-offset, length-cmp (`text[3]`, `slice(0, 3)`, `slice(4)`, `length < 4`). Across the
 * shipped contract text (src/, prompts/, package.json description, README.md,
 * GLOSSARY.md, scripts/runtime-edge-test.mjs) every static width names the live one, and
 * the allowlist below is exact-line only: an entry that suppresses nothing is dead weight.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { ALPHA, HASH_CLASS, HASH_LEN, HASH_RE } from "../../src/hashline/alphabet.js";
import {
  ANCHOR_LEN,
  HASH_SPACE,
  MAX_HASH_LINES,
  USABLE_HASH_SPACE,
} from "../../src/hashline/hash-identity.js";
import { HASH_PROBE_STRIDE } from "../../src/hashline/hash-identity.js";

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name));
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

function stringValue(node: unknown): string | undefined {
  if (node !== null && typeof node === "object") {
    const record = node as AnyNode;
    if (record.type === "StringLiteral" && typeof record.value === "string") {
      return record.value;
    }
  }
  return undefined;
}

function moduleSources(code: string): string[] {
  const program = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program as unknown as AnyNode;
  const sources: string[] = [];
  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      const value = stringValue(node.source);
      if (value !== undefined) sources.push(value);
    } else if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source !== null &&
      node.source !== undefined
    ) {
      const value = stringValue(node.source);
      if (value !== undefined) sources.push(value);
    } else if (
      node.type === "CallExpression" &&
      node.callee !== null &&
      typeof node.callee === "object" &&
      (node.callee as AnyNode).type === "Import" &&
      Array.isArray(node.arguments)
    ) {
      const value = stringValue((node.arguments as unknown[])[0]);
      if (value !== undefined) sources.push(value);
    }
  });
  return sources;
}

const COUNT_WORD_RE = /(^|[^A-Za-z0-9])\d-(?:char|chars|character|characters)\b/;
const COUNT_WORD_SPACE_RE = /(^|[^A-Za-z0-9])\d\s+(?:chars|characters)\b/;

const ANCHOR_ASSIGN_RE = /ANCHOR_(?:WIDTH|LEN)\s*=\s*[0-9]/;
const TEXT_INDEX_RE = /\btext\s*\[\s*[1-9][0-9]*\s*\]/;
const SLICE_PREFIX_RE = /\b(?:slice|substring|substr)\(\s*0\s*,\s*[0-9]+\s*\)/;
const SLICE_OFFSET_RE = /\b(?:slice|substring|substr)\(\s*[2-9][0-9]*\s*\)/;
const LENGTH_CMP_RE = /\.length\s*[<>]=?\s*[2-9][0-9]*\b/;
const STRIDE_ASSIGN_RE = /HASH_PROBE_STRIDE\s*=\s*[0-9]/;

interface WidthHit {
  arm: string;
  line: string;
}

/**
 * A cited record's PATH is not a hand-rolled width literal, and every record slug carries the width
 * it introduced — `0002-tokenizer-stable-4-character-…` is the record that OWNS the digit-subcube
 * reservation this surface derives from, so the citation the comment grammar requires was the thing
 * the count-word arm flagged. Only a path that RESOLVES is stripped: a decoy or a typo stays in the
 * scanned text, so the exemption cannot be widened by inventing a path.
 */
function withoutCitedRecordPaths(line: string): string {
  return line.replace(/docs\/[\w./-]+\.md/g, (cited) => (existsSync(cited) ? "" : cited));
}

function scanStrictLine(line: string): WidthHit[] {
  const hits: WidthHit[] = [];
  const scanned = withoutCitedRecordPaths(line);
  if (COUNT_WORD_RE.test(scanned)) hits.push({ arm: "count-word", line });
  if (COUNT_WORD_SPACE_RE.test(scanned)) hits.push({ arm: "count-word-space", line });
  for (const match of line.matchAll(/\[[^\]]*\]\{([0-9]+)\}/g)) {
    if (match[1] !== String(HASH_LEN)) {
      hits.push({ arm: "class-quantifier", line });
      break;
    }
  }
  return hits;
}

function scanNumericNameLine(line: string): WidthHit[] {
  const hits: WidthHit[] = [];
  if (ANCHOR_ASSIGN_RE.test(line)) hits.push({ arm: "anchor-assign", line });
  if (STRIDE_ASSIGN_RE.test(line)) hits.push({ arm: "stride-assign", line });
  return hits;
}

function scanNumericPositionalLine(line: string): WidthHit[] {
  const hits: WidthHit[] = [];
  if (TEXT_INDEX_RE.test(line)) hits.push({ arm: "text-index", line });
  if (SLICE_PREFIX_RE.test(line)) hits.push({ arm: "slice-prefix", line });
  if (SLICE_OFFSET_RE.test(line)) hits.push({ arm: "slice-offset", line });
  if (LENGTH_CMP_RE.test(line)) hits.push({ arm: "length-cmp", line });
  return hits;
}

const ALLOWLISTED_LINES = [
  String.raw`const TEMP_UUID_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;`,
  String.raw`const preview = first.slice(0, 60);`,
  String.raw`const sample = (m.candidates ?? []).slice(0, 5);`,
];

function countWordWidths(line: string): string[] {
  const widths: string[] = [];
  for (const re of [
    /(^|[^A-Za-z0-9])(\d)-(?:char|chars|character|characters)\b/g,
    /(^|[^A-Za-z0-9])(\d)\s+(?:chars|characters)\b/g,
  ]) {
    for (const match of line.matchAll(re)) {
      const width = match[2];
      if (width !== undefined) widths.push(width);
    }
  }
  return widths;
}

function contractTexts(): { label: string; text: string }[] {
  const entries = tsFiles("src").map((file) => ({
    label: file,
    text: readFileSync(file, "utf-8"),
  }));
  for (const file of mdFiles("prompts")) {
    entries.push({ label: file, text: readFileSync(file, "utf-8") });
  }
  const packageJson = JSON.parse(readFileSync("package.json", "utf-8")) as {
    description?: unknown;
  };
  if (typeof packageJson.description === "string") {
    entries.push({ label: "package.json:description", text: packageJson.description });
  }
  entries.push({
    label: "scripts/runtime-edge-test.mjs",
    text: readFileSync("scripts/runtime-edge-test.mjs", "utf-8"),
  });
  for (const file of ["README.md", "GLOSSARY.md"]) {
    entries.push({ label: file, text: readFileSync(file, "utf-8") });
  }
  return entries;
}

function scanSrcFile(file: string, text: string): string[] {
  const hashlineSurface =
    file.startsWith(join("src", "hashline") + "/") ||
    file === join("src", "served-session", "serve-render.ts");
  const violations: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (ALLOWLISTED_LINES.includes(line)) continue;
    for (const hit of scanStrictLine(line)) {
      violations.push(`${file}: ${hit.arm}: ${hit.line}`);
    }
    if (hashlineSurface) {
      for (const hit of scanNumericNameLine(line).concat(scanNumericPositionalLine(line))) {
        violations.push(`${file}: ${hit.arm}: ${hit.line}`);
      }
    } else {
      for (const hit of scanNumericNameLine(line)) {
        violations.push(`${file}: ${hit.arm}: ${hit.line}`);
      }
    }
  }
  return violations;
}

describe("anchor width single owner", () => {
  it("derives the hash space, line cap, and shape from HASH_LEN", () => {
    expect(HASH_SPACE).toBe(ALPHA.length ** HASH_LEN);
    expect(USABLE_HASH_SPACE).toBe(HASH_SPACE - 10 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(USABLE_HASH_SPACE);
    expect(ANCHOR_LEN).toBe(HASH_LEN);
    expect(HASH_CLASS).toBe(`[${ALPHA.replace(/-/g, "\\-")}]{${HASH_LEN}}`);
    const sample = [...ALPHA.replace(/-/g, "")].slice(0, HASH_LEN).join("");
    expect(sample).toHaveLength(HASH_LEN);
    expect(HASH_RE.test(sample)).toBe(true);
    expect(HASH_RE.test(sample + (sample.at(0) ?? "X"))).toBe(false);
  });

  it("derives the probe stride from the alphabet, never a literal", () => {
    expect(HASH_PROBE_STRIDE).toBe(ALPHA.length ** 2 + ALPHA.length + 1);
  });

  it("keeps src/hashline/alphabet.ts a zero-import leaf", () => {
    const code = readFileSync(join("src", "hashline", "alphabet.ts"), "utf-8");
    expect(moduleSources(code)).toEqual([]);
  });

  it("positive control: the leaf walker sees real dependencies", () => {
    const code = readFileSync(join("src", "domain-errors.ts"), "utf-8");
    expect(moduleSources(code)).toEqual(["./hashline/alphabet.js"]);
    expect(
      moduleSources(
        'export { HASH_RE } from "./hasher.js";\nconst lazy = await import("./dyn.js");\n',
      ),
    ).toEqual(["./hasher.js", "./dyn.js"]);
  });

  it("has no hand-rolled anchor-width literal under src/", () => {
    const files = tsFiles("src");
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((file) => scanSrcFile(file, readFileSync(file, "utf-8")));
    expect(violations).toEqual([]);
  });

  it("keeps every shipped count word consistent with HASH_LEN", () => {
    const mismatches: string[] = [];
    const surfaces = contractTexts();
    expect(surfaces.some((e) => e.label.startsWith("prompts"))).toBe(true);
    expect(mdFiles("prompts").length).toBeGreaterThan(0);
    for (const { label, text } of surfaces) {
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (ALLOWLISTED_LINES.includes(line)) continue;
        for (const width of countWordWidths(line)) {
          if (width !== String(HASH_LEN)) {
            mismatches.push(`${label}: ${width}-char ≠ HASH_LEN ${HASH_LEN}: ${line}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("negative control: the scanner arms detect planted width literals", () => {
    const plantedStrict = [
      "reason: `Pass the bare 4-char anchor and retry.`",
      "const SHAPE5 = /^[A-Za-z0-9]{5}$/;",
      "copy only the 3 chars before │",
    ];
    expect(plantedStrict.flatMap((line) => scanStrictLine(line))).toHaveLength(3);
    expect(scanStrictLine(`const S = /[A-Za-z0-9]{${HASH_LEN}}$/;`)).toEqual([]);
    const plantedNumeric = [
      "const ANCHOR_WIDTH = 3;",
      "if (text[3] !== HASH_SEP) return undefined;",
      "const anchor = text.slice(0, 3);",
      "return { anchor, tail: text.slice(4) };",
      "if (text.length < 4) return undefined;",
      "export const HASH_PROBE_STRIDE = 3907;",
    ];
    const numericHits = plantedNumeric.map((line) =>
      scanNumericNameLine(line).concat(scanNumericPositionalLine(line)),
    );
    expect(numericHits.map((hits) => hits.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(numericHits.map((hits) => hits[0]?.arm)).toEqual([
      "anchor-assign",
      "text-index",
      "slice-prefix",
      "slice-offset",
      "length-cmp",
      "stride-assign",
    ]);
    const foreign = String(HASH_LEN + 1);
    expect(countWordWidths(`a ${foreign}-char anchor`)).toEqual([foreign]);
    expect(countWordWidths(`a ${foreign}-char anchor`)).not.toContain(String(HASH_LEN));
    const dispatchName = scanSrcFile("src/domain-errors.ts", "const ANCHOR_WIDTH = 3;");
    expect(dispatchName).toHaveLength(1);
    expect(dispatchName[0]).toContain("anchor-assign");
    const dispatchPositional = scanSrcFile(
      "src/hashline/apply.ts",
      "if (text[3] !== HASH_SEP) return undefined;",
    );
    expect(dispatchPositional.some((v) => v.includes("text-index"))).toBe(true);
    const movedPositional = scanSrcFile(
      join("src", "served-session", "serve-render.ts"),
      "if (text[3] !== HASH_SEP) return undefined;",
    );
    expect(movedPositional.some((v) => v.includes("text-index"))).toBe(true);
    expect(scanStrictLine("no width here")).toEqual([]);
  });
});
