import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { ALPHA, HASH_CLASS, HASH_LEN, HASH_RE } from "../../src/hashline/alphabet.js";
import { ANCHOR_LEN, HASH_SPACE, MAX_HASH_LINES } from "../../src/hashline/hash-identity.js";
import { HASH_PROBE_STRIDE } from "../../src/hashline/index.js";

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

// WHY: the leaf pin is only as strong as the walker — a static `import` is
// WHY: one of three ways to depend on a module, so re-exports (`export … from`)
// WHY: and dynamic `import(…)` must be collected too, or `alphabet.ts` could
// WHY: re-export a hasher into every error path with the guard still green.
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

// WHY: the two hand-rolled width shapes T1 deleted — a count word restates the
// WHY: width instead of deriving it from `HASH_LEN`, and a `[class]{3}` /
// WHY: `[class]{4}` regex is a second owner of the anchor shape beside
// WHY: `HASH_RE`. Either would let a width flip leave a stale digit behind (or
// WHY: ship a mixed-width build), so both are refused anywhere under `src/`.
// WHY: generalised to any single digit (not just 3/4): `src/` must derive every
// WHY: count word, and the `(^|[^…])` guard spares compounds like `62-char`
// WHY: (the alphabet size, not a width) since the digit there follows `6`.
const COUNT_WORD_RE = /(^|[^A-Za-z0-9])\d-(?:char|chars|character|characters)\b/;
const COUNT_WORD_SPACE_RE = /(^|[^A-Za-z0-9])\d\s+(?:chars|characters)\b/;
// WHY: the class-quantifier arm is inline in `scanStrictLine` (generalized to
// WHY: any `{N}` off the live width) — no separate constant to drift.

// WHY: the numeric width shapes T1 deleted from the anchor-shape surface —
// WHY: `ANCHOR_WIDTH = 3`, `text[3]`, `slice(0, 3)`, the one-arg `slice(4)` tail,
// WHY: `length < 4`, and the `3907` stride literal. Reverting the refactor to any
// WHY: of these keeps the count-word arms green, so this third arm watches
// WHY: `src/hashline/**` for digits where only `HASH_LEN` may stand.
// WHY: (`[1-9]`/`[2-9]` lead: index `0`, one-arg `slice(1)` (the diff-marker
// WHY: strip), emptiness checks like `length > 0`, and the shipped
// WHY: pluralisation `length > 1` are live idioms on the surface, while a
// WHY: width literal is always a positive count above one — `0`/`1` can never
// WHY: encode one. The ticket's "matching at least" covers every shape below,
// WHY: all of which use digits above one.)
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

function scanStrictLine(line: string): WidthHit[] {
  const hits: WidthHit[] = [];
  if (COUNT_WORD_RE.test(line)) hits.push({ arm: "count-word", line });
  if (COUNT_WORD_SPACE_RE.test(line)) hits.push({ arm: "count-word-space", line });
  // WHY: generalized quantifier — flags `[class]{N}` for any `N` that is not
  // WHY: the live `HASH_LEN`, so the arm stays load-bearing at width 5 instead
  // WHY: of going blind past `3|4`. The `TEMP_UUID_RE` exact-line allowlist
  // WHY: still excuses the UUID shape (its `{8}`/`{12}` groups now flag too).
  for (const match of line.matchAll(/\[[^\]]*\]\{([0-9]+)\}/g)) {
    if (match[1] !== String(HASH_LEN)) {
      hits.push({ arm: "class-quantifier", line });
      break;
    }
  }
  return hits;
}

// WHY: split by false-positive radius — the two name-specific arms fire
// WHY: only on the exact former-owner spellings (`ANCHOR_WIDTH = 3`, the
// WHY: `3907` stride), so they run src-wide with zero live hits; the three
// WHY: positional arms (`text[3]`, `slice(0, 3)`, the one-arg `slice(4)`,
// WHY: `length < 4`) also match innocent code elsewhere (`homes.slice(0, 3)`,
// WHY: BOM `length >= 4`), so they stay on the anchor-shape surface
// WHY: `src/hashline/**`.
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

// WHY: exact-line allowlist, never substring: each entry is the full trimmed
// WHY: source line of a known false positive, so a line that grows a real
// WHY: anchor literal stops equalling its entry and is reported.
// WHY: - `TEMP_UUID_RE` is a UUIDv4 filename shape (`{8}`/`{4}` hex groups),
// WHY:   not an anchor width; narrowing the class arm to spare it would also
// WHY:   spare real violations.
// WHY: - `first.slice(0, 60)` truncates an error preview, and
// WHY:   `.slice(0, 5)` samples candidate anchors for a message — both slice
// WHY:   content, not an anchor prefix, but no regex can tell them apart from
// WHY:   `text.slice(0, 3)`.
// WHY: allowlist entries are exact and live — an entry that suppresses no hit
// WHY: is dead weight, so the single owner `HASH_LEN` carries none.
const ALLOWLISTED_LINES = [
  String.raw`const TEMP_UUID_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;`,
  String.raw`const preview = first.slice(0, 60);`,
  String.raw`const sample = (m.candidates ?? []).slice(0, 5);`,
];

// WHY: width-relative consistency for the shipped contract surface — every
// WHY: `N-char(s)` / `N-character(s)` must name the live `HASH_LEN`, so any
// WHY: leftover static digit fails loudly instead of shipping a mixed-width
// WHY: contract. `README.md` and `CONTEXT.md` ship (`package.json.files`) and
// WHY: state the width, so they are scanned; `docs/**` stays out for breadth,
// WHY: and `CHANGELOG.md` / `docs/adr/**` stay out as frozen history.
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
  // WHY: the runtime edge script was hand-migrated to `4-char-hash` and is
  // WHY: scanned by nothing else — pinning it here so the next width change
  // WHY: cannot forget it. Only this file, not all of `scripts/`: the count
  // WHY: arms would false-positive on unrelated script prose.
  entries.push({
    label: "scripts/runtime-edge-test.mjs",
    text: readFileSync("scripts/runtime-edge-test.mjs", "utf-8"),
  });
  // WHY: shipped prose states the width normatively — a stale `3-char` here
  // WHY: ships to every install, so the next width change must touch it too.
  // WHY: Only these two files, not all of `docs/**` (breadth) and never
  // WHY: `CHANGELOG.md` / `docs/adr/**` (frozen history).
  for (const file of ["README.md", "CONTEXT.md"]) {
    entries.push({ label: file, text: readFileSync(file, "utf-8") });
  }
  return entries;
}

// WHY: the file-walk dispatch lives here — not inline in the test — so the
// WHY: negative control can drive it directly: moving the src-wide name arms
// WHY: inside the hashline branch would silently drop the exact T1
// WHY: `ANCHOR_WIDTH` case, and only a control through this helper reddens.
function scanSrcFile(file: string, text: string): string[] {
  const hashlineSurface = file.startsWith(join("src", "hashline") + "/");
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
    // WHY: the sample is derived from the alphabet (not a `3`-char literal),
    // WHY: so the flip keeps this assertion meaningful instead of reddening it
    // WHY: for the wrong reason.
    const sample = [...ALPHA.replace(/-/g, "")].slice(0, HASH_LEN).join("");
    expect(sample).toHaveLength(HASH_LEN);
    expect(HASH_RE.test(sample)).toBe(true);
    expect(HASH_RE.test(sample + (sample.at(0) ?? "X"))).toBe(false);
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
    expect(moduleSources(code)).toEqual([]);
  });

  it("positive control: the leaf walker sees real dependencies", () => {
    // WHY: a walker that returns `[]` for every input would make the leaf pin
    // WHY: pass vacuously — parsing the known importer must yield exactly its
    // WHY: alphabet dependency, through imports and re-exports alike.
    const code = readFileSync(join("src", "domain-errors.ts"), "utf-8");
    expect(moduleSources(code)).toEqual(["./hashline/alphabet.js"]);
    expect(
      moduleSources(
        'export { HASH_RE } from "./hasher.js";\nconst lazy = await import("./dyn.js");\n',
      ),
    ).toEqual(["./hasher.js", "./dyn.js"]);
  });

  it("has no hand-rolled anchor-width literal under src/", () => {
    // WHY: every count word, class shape, and numeric width form outside the
    // WHY: alphabet leaf is a second owner of the width — the flip to 4 must
    // WHY: propagate from `HASH_LEN` alone, so the scan below must stay empty.
    const files = tsFiles("src");
    // WHY: an empty walk yields zero violations and a green test — assert the
    // WHY: surface is non-trivial so a cwd change or `src` rename cannot
    // WHY: silently no-op the guard.
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((file) => scanSrcFile(file, readFileSync(file, "utf-8")));
    expect(violations).toEqual([]);
  });

  it("keeps every shipped count word consistent with HASH_LEN", () => {
    // WHY: `prompts/read.md` and `package.json` state the width statically
    // WHY: (they cannot import `HASH_LEN`), so consistency — not absence — is
    // WHY: the pin: at width 3 every `N-char` must read `3`, and after T2's
    // WHY: flip every leftover `3` fails loudly instead of shipping a
    // WHY: mixed-width model contract.
    const mismatches: string[] = [];
    const surfaces = contractTexts();
    // WHY: same vacuous-walk hazard as the src scan — pin the prompts
    // WHY: md-walk and the contract surface before asserting emptiness.
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
    // WHY: a guard that cannot fire is decoration — each planted line below
    // WHY: is exactly what its arm must catch in the file walk, so a neutered
    // WHY: regex fails here rather than shipping a blind guard.
    const plantedStrict = [
      "reason: `Pass the bare 4-char anchor and retry.`",
      // WHY: width-5 plant — the generalized quantifier arm flags any
      // WHY: `[class]{N}` with `N` off the live width; a `{4}` plant would be
      // WHY: consistent at width 4 and must NOT fire.
      "const SHAPE5 = /^[A-Za-z0-9]{5}$/;",
      "copy only the 3 chars before │",
    ];
    expect(plantedStrict.flatMap((line) => scanStrictLine(line))).toHaveLength(3);
    // WHY: live-width control — a `{HASH_LEN}` class is consistent and must NOT
    // WHY: fire. It reddens both on a flag-everything mutant (`match[1] !== null`
    // WHY: flags every `{N}`) and on a revert to the old `(3|4)` positive arm.
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
    // WHY: the consistency arm must flag a foreign width on the contract
    // WHY: surface while accepting the live one.
    // WHY: the foreign width is derived (`HASH_LEN + 1`), never the literal
    // WHY: `4` — at the flip the sample stays foreign instead of inverting
    // WHY: into the live width and reddening for the wrong reason.
    const foreign = String(HASH_LEN + 1);
    expect(countWordWidths(`a ${foreign}-char anchor`)).toEqual([foreign]);
    expect(countWordWidths(`a ${foreign}-char anchor`)).not.toContain(String(HASH_LEN));
    // WHY: the walk dispatch itself is refuted through the shared helper — a
    // WHY: non-hashline name-arm hit (the exact T1 `ANCHOR_WIDTH` case) and a
    // WHY: hashline positional hit must both be reported, so moving the
    // WHY: src-wide name arms inside the hashline branch reddens here.
    const dispatchName = scanSrcFile("src/domain-errors.ts", "const ANCHOR_WIDTH = 3;");
    expect(dispatchName).toHaveLength(1);
    expect(dispatchName[0]).toContain("anchor-assign");
    const dispatchPositional = scanSrcFile(
      "src/hashline/served-guard.ts",
      "if (text[3] !== HASH_SEP) return undefined;",
    );
    expect(dispatchPositional.some((v) => v.includes("text-index"))).toBe(true);
    expect(scanStrictLine("no width here")).toEqual([]);
  });
});
