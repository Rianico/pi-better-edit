import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * `CONTEXT.md` bans three synonyms the resolution seams used to carry (#101):
 * `anchor identity` (identity belongs to a line's `line_id`), `range staleness` (canonical:
 * `served-range staleness`), and `echo` for served feedback rows (canonical only inside
 * `served hash echo`). This guard keeps the rename from creeping back in (#108, #114).
 */
function srcFiles(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function allFiles(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) allFiles(path, ext, out);
    else if (entry.isFile() && path.endsWith(ext)) out.push(path);
  }
  return out;
}

const files = srcFiles();

/** Source files whose text matches `pattern`. Patterns stay non-global so `lastIndex` cannot leak. */
function matching(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(readFileSync(file, "utf-8")));
}

// Allowlist: `src/write-hook.ts` implements the canonical `served hash echo`
// condition (`ServedHashEcho`, `findServedHashEcho`, `servedHashEchoDenial`,
// `E_SERVED_ECHO`) and its prose names that condition, so the whole file stays
// exempt. Every other `src/**/*.ts` file must contain no `/echo/i` once the
// canonical tokens below are stripped. Sole file exemption in this guard (#114).
const CANONICAL_ALLOWLIST = new Set(["src/write-hook.ts"]);

// Canonical `served hash echo` family (#108 MUST NOT rename, #114 reuses for all
// three scopes): stripping these tokens (longest first so `findServedHashEcho`
// does not leave a suffix) plus the glossary phrase `served hash echo` leaves
// only non-canonical uses.
const CANONICAL_TOKENS = [
  "servedHashEchoDenial",
  "findServedHashEcho",
  "findEditHashEcho",
  "EditHashEchoError",
  "ServedHashEcho",
  "E_SERVED_ECHO",
];

function stripCanonical(text: string): string {
  let out = text;
  for (const token of CANONICAL_TOKENS) {
    out = out.split(token).join("");
  }
  // Allow the glossary phrase `served hash echo` (any case, space/hyphen/underscore
  // separated) when it names the canonical error condition.
  out = out.replace(/served[\s\-_]*hash[\s\-_]*echo/gi, "");
  return out;
}

/** Non-allowlisted source files still containing `/echo/i` after canonical stripping. */
function filesWithNonCanonicalEcho(): string[] {
  return files
    .filter((file) => !CANONICAL_ALLOWLIST.has(file))
    .filter((file) => /echo/i.test(stripCanonical(readFileSync(file, "utf-8"))));
}

// Scope 2 — test titles (#114): only lines that name a test (`it`/`test`/`describe`)
// are checked, so local variables and fixture content stay out of scope. Canonical
// allowlist: same `CANONICAL_TOKENS` plus the glossary phrase `served hash echo`
// (via `stripCanonical`); a title naming the canonical condition stays green.
function testTitleViolations(): string[] {
  const out: string[] = [];
  for (const file of allFiles("test", ".ts")) {
    const text = readFileSync(file, "utf-8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (/^\s*(it|test|describe)\s*\(/.test(line)) {
        if (/echo/i.test(stripCanonical(line))) {
          out.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      }
    });
  }
  return out;
}

// Scope 3 — binding domain docs (#114): `CONTEXT.md` plus `docs/adr/**.md` whole
// files. Canonical allowlist: same `CANONICAL_TOKENS` plus the glossary phrase
// `served hash echo` (via `stripCanonical`) plus the glossary `_Avoid_:` lines
// themselves (they must name the banned synonym to define the ban, e.g.
// `_Avoid_: display, show, echo` and `_Avoid_: hash echo ..., anchor echo`);
// prose naming the canonical condition stays green. No file carve-outs in
// this scope.
function bindingDocsViolations(): string[] {
  const docs = ["CONTEXT.md", ...allFiles("docs/adr", ".md")];
  return docs.filter((file) => {
    const text = readFileSync(file, "utf-8");
    // Strip `_Avoid_:` definition lines: the glossary must name the banned term
    // to ban it. Only those lines are exempt; prose elsewhere stays checked.
    const withoutAvoid = text
      .split("\n")
      .filter((line) => !/^\s*_Avoid_:/.test(line))
      .join("\n");
    return /echo/i.test(stripCanonical(withoutAvoid));
  });
}

describe("CONTEXT.md terminology — forbidden synonyms stay out of src/", () => {
  it("names no `anchor identity`: identity belongs to a line_id, not a presentation anchor", () => {
    expect(matching(/anchor identity|AnchorIdentity/)).toEqual([]);
  });

  it("names no `range staleness`: the canonical term is served-range staleness", () => {
    expect(matching(/range staleness/i)).toEqual([]);
  });

  it("names served feedback as serve, not the avoided synonym, tree-wide (canonical family stripped)", () => {
    // Whole-tree: strip the canonical `served hash echo` family, then assert no
    // `/echo/i` remains. Reintroducing any renamed identifier (`buildRangeEcho`,
    // `buildRangeEchoBlock`, `recordEcho`, `recordEchoServes`, `echoRows`, `echo`)
    // fails here.
    expect(filesWithNonCanonicalEcho()).toEqual([]);
  });

  it("keeps the canonical served hash echo family and the line-identity rename", () => {
    const apply = readFileSync("src/hashline/apply.ts", "utf-8");
    expect(apply).toContain("E_SERVED_ECHO");
    expect(apply).toContain("findEditHashEcho");
    const index = readFileSync("src/hashline/index.ts", "utf-8");
    expect(index).toContain("EditHashEchoError");
    expect(index).toContain("resolveLineIdentity");
    // The canonical `served-range staleness` term stays named in the verification module; the
    // glossary list wraps, so accept the wrap between the hyphenated head and `staleness`.
    expect(readFileSync("src/hashline/served-verification.ts", "utf-8")).toMatch(
      /served-range[\s*]+staleness/,
    );
  });
});

describe("CONTEXT.md terminology — forbidden synonyms stay out of test titles/", () => {
  it("keeps test titles free of the avoided synonym for served feedback (canonical family stripped)", () => {
    // Title-only: strip the canonical `served hash echo` family, then assert no
    // `/echo/i` remains on `it`/`test`/`describe` lines. A title calling served
    // rows by the avoided synonym fails here; titles naming the canonical
    // condition (`E_SERVED_ECHO`, `findEditHashEcho`, `served hash echo`) stay green.
    expect(testTitleViolations()).toEqual([]);
  });
});

describe("CONTEXT.md terminology — forbidden synonyms stay out of binding docs/", () => {
  it("keeps the binding domain docs free of the avoided synonym for served feedback (canonical family stripped)", () => {
    // Whole-file over `CONTEXT.md` + `docs/adr/**.md`: strip the canonical
    // `served hash echo` family, then assert no `/echo/i` remains. Prose calling
    // served rows by the avoided synonym fails here; prose naming the canonical
    // condition stays green. No file carve-outs in this scope.
    expect(bindingDocsViolations()).toEqual([]);
  });
});
