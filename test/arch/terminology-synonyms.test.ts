import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * `CONTEXT.md` bans three synonyms the resolution seams used to carry (#101):
 * `anchor identity` (identity belongs to a line's `line_id`), `range staleness` (canonical:
 * `served-range staleness`), and `echo` for served feedback rows (canonical only inside
 * `served hash echo`). This guard keeps the rename from creeping back in (#108, #114).
 * #108 freeze is served-qualified only: `findServedHashEcho`, `ServedHashEchoError`,
 * `ServedHashEcho`, `servedHashEchoDenial` stay frozen; the model-facing refusal
 * code is `E_MALFORM_TEXT` (renamed per ADR-0019, no alias); the surface-qualified
 * `findEditHashEcho` / `EditHashEchoError` are retired (#125).
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

// No file allowlist: every `src/**/*.ts` file must contain no `/echo/i` once the
// canonical tokens below are stripped (#125 removed the `src/write-hook.ts`
// exemption — the hook now names only the canonical served hash echo family).
const CANONICAL_ALLOWLIST = new Set<string>([]);

// Canonical `served hash echo` family (#108 served-qualified freeze, #114 reuses for all
// three scopes): stripping these tokens (longest first so `findServedHashEcho`
// does not leave a suffix and `ServedHashEchoError` does not leave `Error` over
// `ServedHashEcho`) plus the glossary phrase `served hash echo` leaves only
// non-canonical uses. Surface-qualified `findEditHashEcho` / `EditHashEchoError`
// are retired (#125) and must not reappear.
const CANONICAL_TOKENS = [
  "servedHashEchoDenial",
  "ServedHashEchoError",
  "findServedHashEcho",
  "ServedHashEcho",
  "E_MALFORM_TEXT",
];

function stripCanonical(text: string): string {
  let out = text;
  for (const token of CANONICAL_TOKENS) {
    out = out.split(token).join("");
  }
  // Allow the glossary phrase `served hash echo` (any case, space/hyphen/underscore
  // separated) when it names the canonical error condition.
  out = out.replace(/served[\s\-_]*hash[\s\-_]*echo/gi, "");
  // Allow the mandated literal-declaration human line, which names the served
  // condition with a hyphen (`served-echo`) and no hash (#125 escape audit).
  out = out.split("[USER] served-echo check bypassed by literal declaration").join("");
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
// prose naming the canonical condition stays green. Accepted records that predate
// the T-rename keep their original codes as historical quotes (see ADR-0019) and
// are exempt here by path; `src/` keeps zero tolerance via the src scope.
//
// Accepted ADR records exempt from scope 3: they predate the T-rename and retain
// the original model-facing codes as historical quotes (never rewritten). ADR-0019
// is exempt as the rename record itself.
const HISTORICAL_ADR_FILES = new Set<string>([
  "docs/adr/0009-bounded-hash-echo-guard.md",
  "docs/adr/0010-user-facing-drift-signals.md",
  "docs/adr/0014-user-model-audience.md",
  "docs/adr/0015-named-object-edit-payload.md",
  "docs/adr/0018-region-scoped-rejection-serves.md",
  "docs/adr/0019-malformed-code-rename.md",
]);
function bindingDocsViolations(): string[] {
  const docs = ["CONTEXT.md", ...allFiles("docs/adr", ".md")].filter(
    (file) => !HISTORICAL_ADR_FILES.has(file),
  );
  return docs.filter((file) => {
    const text = readFileSync(file, "utf-8");
    // Strip `_Avoid_:` definition lines: the glossary must name the banned term
    // to ban it. Only those lines are exempt; prose elsewhere stays checked.
    const withoutAvoid = text
      .split("\n")
      .filter((line) => !/^\s*_Avoid_:/.test(line))
      .join("\n");
    // Retired surface-qualified names may appear in revision notes that document
    // their retirement (#125); they stay forbidden in `src/` via the src scope.
    const withoutRetired = withoutAvoid
      .split("findEditHashEcho")
      .join("")
      .split("EditHashEchoError")
      .join("");
    return /echo/i.test(stripCanonical(withoutRetired));
  });
}

describe("CONTEXT.md terminology — forbidden synonyms stay out of src/", () => {
  it("names no `anchor identity`: identity belongs to a line_id, not a presentation anchor", () => {
    expect(matching(/anchor identity|AnchorIdentity/)).toEqual([]);
  });

  it("names no `range staleness`: the canonical term is served-range staleness", () => {
    // The canonical `served-range staleness` cause value (CONTEXT.md glossary) is exempt:
    // only the bare synonym stays banned.
    const violations = files.filter((file) => {
      const stripped = readFileSync(file, "utf-8").replace(/served-range staleness/gi, "");
      return /range staleness/i.test(stripped);
    });
    expect(violations).toEqual([]);
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
    expect(apply).toContain("E_MALFORM_TEXT");
    expect(apply).toContain("findServedHashEcho");
    expect(apply).not.toContain("findEditHashEcho");
    const index = readFileSync("src/hashline/index.ts", "utf-8");
    expect(index).toContain("ServedHashEchoError");
    expect(index).not.toContain("EditHashEchoError");
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
    // condition (`E_MALFORM_TEXT`, `findServedHashEcho`, `served hash echo`) stay green.
    expect(testTitleViolations()).toEqual([]);
  });
});

describe("CONTEXT.md terminology — forbidden synonyms stay out of binding docs/", () => {
  it("keeps the binding domain docs free of the avoided synonym for served feedback (canonical family stripped)", () => {
    // Whole-file over live binding docs (`CONTEXT.md` + non-historical ADRs):
    // strip the canonical `served hash echo` family, then assert no `/echo/i`
    // remains. Prose calling served rows by the avoided synonym fails here;
    // prose naming the canonical condition stays green. Historical ADR records
    // are path-exempt above (they keep original codes as quotes, never rewritten).
    expect(bindingDocsViolations()).toEqual([]);
  });
});
