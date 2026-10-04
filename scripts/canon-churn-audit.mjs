#!/usr/bin/env node
/**
 * WHY: re-runnable formatter-churn audit — measures, per code point, whether locally installed
 * formatters rewrite it in source. Evidence generator for any future canon version (issue #22).
 * Invocation: node scripts/canon-churn-audit.mjs — a formatter rejecting a snippet is measured
 * as skip for that language; formatter behaviour is never asserted from docs/articles records.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLASS_CPS = [
  [0x0009, "TAB"],
  [0x000a, "LF"],
  [0x000b, "VT"],
  [0x000c, "FF"],
  [0x000d, "CR"],
  [0x0020, "SPACE"],
  [0x0085, "NEL"],
  [0x00a0, "NBSP"],
  [0x1680, "OGHAM SPACE"],
  [0x2000, "EN QUAD"],
  [0x2001, "EM QUAD"],
  [0x2002, "EN SPACE"],
  [0x2003, "EM SPACE"],
  [0x2004, "THREE-PER-EM"],
  [0x2005, "FOUR-PER-EM"],
  [0x2006, "SIX-PER-EM"],
  [0x2007, "FIGURE SPACE"],
  [0x2008, "PUNCT SPACE"],
  [0x2009, "THIN SPACE"],
  [0x200a, "HAIR SPACE"],
  [0x2028, "LINE SEP"],
  [0x2029, "PARA SEP"],
  [0x202f, "NARROW NBSP"],
  [0x205f, "MED MATH SPACE"],
  [0x3000, "IDEOGRAPHIC SPACE"],
  [0x200e, "LRM"],
  [0x200f, "RLM"],
  [0xfeff, "ZWNBSP/BOM"],
];

const CONTROL_CPS = [
  [0x200b, "ZWSP"],
  [0x200c, "ZWNJ"],
  [0x200d, "ZWJ"],
  [0x00ad, "SOFT HYPHEN"],
  [0x2060, "WORD JOINER"],
  [0x180e, "MONGOLIAN VSEP"],
  [0x001c, "FILE SEP"],
  [0x001d, "GROUP SEP"],
  [0x001e, "RECORD SEP"],
  [0x001f, "UNIT SEP"],
  [0x0080, "C1 PAD"],
  [0x0081, "C1 HOP"],
  [0x009f, "C1 APC"],
];

const repoRoot = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "canon-churn-"));

function pipe(cmd, args, input) {
  const res = spawnSync(cmd, args, { input, encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

const FORMATTERS = [
  {
    name: "gofmt",
    file: "a.go",
    template: (s) => `package p\n\nvar a ${s}= 1\n`,
    run: (src) => pipe("gofmt", [], src),
  },
  {
    name: "rustfmt",
    file: "a.rs",
    template: (s) => `fn main() {\n    let a ${s}= 1;\n}\n`,
    run: (src) => pipe("rustfmt", ["--edition", "2021"], src),
  },
  {
    name: "ruff",
    file: "a.py",
    template: (s) => `a ${s}= 1\n`,
    run: (src) => pipe("ruff", ["format", "-"], src),
  },
  {
    name: "oxfmt",
    file: "a.ts",
    template: (s) => `const a ${s}= 1;\n`,
    run: (src) => {
      const path = join(scratch, "a.ts");
      writeFileSync(path, src);
      const res = spawnSync("node_modules/.bin/oxfmt", [path], { cwd: repoRoot, encoding: "utf8" });
      if (res.error || res.status !== 0) return null;
      return readFileSync(path, "utf8");
    },
  },
];

function probe(fmt) {
  return fmt.run(fmt.template(" ")) !== null;
}

function cell(fmt, cp) {
  const src = fmt.template(String.fromCharCode(cp));
  const out = fmt.run(src);
  if (out === null) return "skip";
  return out.includes(String.fromCharCode(cp)) ? "preserve" : "normalize";
}

const available = FORMATTERS.filter(probe);
const missing = FORMATTERS.filter((f) => !available.includes(f)).map((f) => f.name);

const measurements = [...CLASS_CPS, ...CONTROL_CPS].map(([cp, name]) => ({
  cp,
  name,
  label: `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${name}`,
  cells: available.map((f) => cell(f, cp)),
}));

function printSection(title, rows) {
  const header = [title, ...available.map((f) => f.name)];
  const widths = header.map((h, i) =>
    Math.max(
      h.length,
      ...rows.map((r) => r.label.length),
      ...rows.map((r) => r.cells[i - 1]?.length ?? 0),
    ),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(header));
  for (const r of rows) console.log(line([r.label, ...r.cells]));
}

if (available.length === 0) {
  console.log("skip-with-notice: no local formatters available (gofmt, rustfmt, ruff, oxfmt)");
  console.log("verdict: nothing measured — install at least one probed formatter");
} else {
  printSection("class (v3 normalize)", measurements.slice(0, CLASS_CPS.length));
  console.log("");
  printSection("controls (v3 significant)", measurements.slice(CLASS_CPS.length));
  const churned = measurements
    .slice(0, CLASS_CPS.length)
    .filter((r) => r.cells.includes("normalize"))
    .map((r) => r.label);
  const churnedControls = measurements
    .slice(CLASS_CPS.length)
    .filter((r) => r.cells.includes("normalize"))
    .map((r) => r.label);
  console.log("");
  console.log(`formatters measured: ${available.map((f) => f.name).join(", ")}`);
  for (const m of missing) console.log(`skip-with-notice: ${m} not available locally`);
  console.log(
    `verdict: v3 class members normalized by >=1 local formatter: ${churned.length > 0 ? churned.join(", ") : "none"}`,
  );
  console.log(
    `verdict: significant controls rewritten by >=1 local formatter: ${churnedControls.length > 0 ? `${churnedControls.join(", ")} — v4 tension: these survive canon but not every formatter` : "none"}`,
  );
}

rmSync(scratch, { recursive: true, force: true });
