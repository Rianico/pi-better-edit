import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * `CONTEXT.md` bans three synonyms the resolution seams used to carry (#101):
 * `anchor identity` (identity belongs to a line's `line_id`), `range staleness` (canonical:
 * `served-range staleness`), and `echo` for served feedback rows (canonical only inside
 * `served hash echo`). This guard keeps the rename from creeping back in (#108, #114).
 * #108 freeze is served-qualified only: `findServedHashEcho`, `ServedHashEchoError`,
 * `ServedHashEcho`, `servedHashEchoDenial` stay frozen; the model-facing refusal
 * code is `E_SUSPICIOUS_TEXT` (renamed per ADR-0019, no alias); the surface-qualified
 * `findEditHashEcho` / `EditHashEchoError` are retired (#125).
 */
function srcFiles(dir = "src", out: string[] = []): string[] {
  // WHY (C1): the traversal lives in recurseDir; this wrapper states only
  // its predicate (src/, .ts) and keeps its signature for existing callers.
  return allFiles(dir, ".ts", out);
}

// WHY (C1): the single directory recursion. Pure traversal — NO file
// selection lives here; every caller states its own extension/scope
// predicate, so sharing this cannot mirror producer into pin or reverse.
function recurseDir(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) recurseDir(path, out);
    else out.push(path);
  }
  return out;
}

function allFiles(dir: string, ext: string, out: string[] = []): string[] {
  return recurseDir(dir, out).filter((f) => f.endsWith(ext));
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
  "E_SUSPICIOUS_TEXT",
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
  // condition with a hyphen (`served-echo`) and no hash (#125 escape audit);
  // the tier task codes it as `[W_LITERAL_BYPASS]` without changing the wording,
  // and the registry owns the header so the source holds only the wording.
  out = out.split("served-echo check bypassed by literal declaration").join("");
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
// are exempt here per file and per code; `src/` keeps zero tolerance via the src scope.
//
// Guard policy B (maintainer decision 2026-09-19: keep the per-file carve-out,
// recorded and shrink-only):
// - decisionAuthority: maintainer decision 2026-09-19
// - reason: accepted records predate the T-rename and retain original codes as
//   historical quotes, never rewritten (see ADR-0019)
// - narrowScope: scope 3 binding-docs check only; `src/` keeps zero tolerance;
//   each listed file is exempt only for its declared retired codes
// - owner: edit maintainer
// - reviewTrigger: any proposal to add or widen an entry, or any retirement
//   that quotes a retired code
// - removalCondition: delete an entry when its file no longer quotes every
//   declared retired code; retire the baseline when no entries remain
// `CONTEXT.md`, `README.md`, `src/`, and `docs/spec/` stay fully checked:
// no entry may name them. Only the listed records are exempt, and only for
// the retired codes they declare. Growth without a declared retired code
// cannot pass: a file outside the baseline gets no stripping, and an entry
// with an empty code list strips nothing.
type HistoricalBaselineEntry = {
  file: string;
  retiredCodes: string[];
  retiredBy: string;
  replacedBy: string[];
};

const HISTORICAL_BASELINE_POLICY = {
  decisionAuthority: "maintainer decision 2026-09-19",
  reason:
    "accepted records predate the T-rename and retain original codes as historical quotes, never rewritten (see ADR-0019)",
  narrowScope:
    "scope 3 binding-docs check only; src/ keeps zero tolerance; each listed file is exempt only for its declared retired codes",
  owner: "edit maintainer",
  reviewTrigger:
    "any proposal to add or widen an entry, or any retirement that quotes a retired code",
  removalCondition:
    "delete an entry when its file no longer quotes every declared retired code; retire the baseline when no entries remain",
};

const HISTORICAL_BASELINE: HistoricalBaselineEntry[] = [
  {
    file: "docs/adr/0009-bounded-hash-echo-guard.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
  {
    file: "docs/adr/0010-user-facing-drift-signals.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
  {
    file: "docs/adr/0014-user-model-audience.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
  {
    file: "docs/adr/0015-named-object-edit-payload.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
  {
    file: "docs/adr/0018-region-scoped-rejection-serves.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
  {
    file: "docs/adr/0019-malformed-code-rename.md",
    retiredCodes: ["E_SERVED_ECHO"],
    retiredBy: "docs/adr/0019-malformed-code-rename.md",
    replacedBy: ["E_SUSPICIOUS_TEXT"],
  },
];

function baselineByFile(): Map<string, HistoricalBaselineEntry> {
  return new Map(HISTORICAL_BASELINE.map((entry) => [entry.file, entry]));
}

function stripBaselineCodes(text: string, codes: string[]): string {
  let out = text;
  for (const code of codes) {
    out = out.split(code).join("");
  }
  return out;
}

function bindingDocsViolations(): string[] {
  const byFile = baselineByFile();
  const docs = ["CONTEXT.md", ...allFiles("docs/adr", ".md")];
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
    const stripped = stripCanonical(withoutRetired);
    const entry = byFile.get(file);
    const withoutBaseline = entry ? stripBaselineCodes(stripped, entry.retiredCodes) : stripped;
    return /echo/i.test(withoutBaseline);
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
    expect(apply).toContain("E_SUSPICIOUS_TEXT");
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
    // condition (`E_SUSPICIOUS_TEXT`, `findServedHashEcho`, `served hash echo`) stay green.
    expect(testTitleViolations()).toEqual([]);
  });
});

describe("CONTEXT.md terminology — forbidden synonyms stay out of binding docs/", () => {
  it("keeps the binding domain docs free of the avoided synonym for served feedback (canonical family stripped)", () => {
    // Whole-file over live binding docs (`CONTEXT.md` + ADRs): strip the
    // canonical `served hash echo` family, then assert no `/echo/i` remains.
    // Prose calling served rows by the avoided synonym fails here; prose
    // naming the canonical condition stays green. Listed records are exempt
    // per file and per code above (they keep original codes as quotes, never
    // rewritten); all other files stay fully checked.
    expect(bindingDocsViolations()).toEqual([]);
  });
});

describe("terminology baseline stays recorded and shrink-only", () => {
  it("declares a retired code and a retiring record for every entry", () => {
    for (const entry of HISTORICAL_BASELINE) {
      expect(entry.retiredCodes.length).toBeGreaterThan(0);
      expect(entry.retiredBy.length).toBeGreaterThan(0);
    }
  });
  it("declares the replacement code for every retired quote (keel §6: name what is retired)", () => {
    for (const entry of HISTORICAL_BASELINE) {
      expect(entry.replacedBy.length).toBeGreaterThan(0);
    }
  });
  it("keeps every replacement live: each replacing code is still a registry member", () => {
    const srcText = readFileSync("src/domain-errors.ts", "utf-8");
    for (const entry of HISTORICAL_BASELINE) {
      for (const code of entry.replacedBy) {
        expect(srcText).toContain(`"${code}"`);
      }
    }
  });
  it("keeps every entry needed: each listed file still quotes each declared retired code", () => {
    for (const entry of HISTORICAL_BASELINE) {
      const text = readFileSync(entry.file, "utf-8");
      for (const code of entry.retiredCodes) {
        expect(text).toContain(code);
      }
      expect(() => readFileSync(entry.retiredBy, "utf-8")).not.toThrow();
    }
  });

  it("records the six guard-policy fields and keeps live surfaces fully checked", () => {
    expect(HISTORICAL_BASELINE_POLICY.decisionAuthority).not.toBe("");
    expect(HISTORICAL_BASELINE_POLICY.reason).not.toBe("");
    expect(HISTORICAL_BASELINE_POLICY.narrowScope).not.toBe("");
    expect(HISTORICAL_BASELINE_POLICY.owner).not.toBe("");
    expect(HISTORICAL_BASELINE_POLICY.reviewTrigger).not.toBe("");
    expect(HISTORICAL_BASELINE_POLICY.removalCondition).not.toBe("");
    const names = HISTORICAL_BASELINE.map((entry) => entry.file);
    expect(names).not.toContain("CONTEXT.md");
    expect(names).not.toContain("README.md");
    expect(names.some((file) => file.startsWith("src/"))).toBe(false);
    expect(names.some((file) => file.startsWith("docs/spec/"))).toBe(false);
  });
});

type AnchorTermBaselineEntry = {
  term: string;
  avoids: string[];
  supersededCode: string;
  definedIn: string;
};

const ANCHOR_TERM_BASELINE: AnchorTermBaselineEntry[] = [
  {
    term: "reversed anchors",
    avoids: ["E_REVERSED_ANCHORS"],
    supersededCode: "W_REVERSED_ANCHORS",
    definedIn: "CONTEXT.md",
  },
  {
    term: "unknown anchor",
    avoids: ["unserved anchor", "missing anchor", "stale anchor"],
    supersededCode: "E_STALE_ANCHOR",
    definedIn: "CONTEXT.md",
  },
  {
    term: "foreign anchor",
    avoids: ["cross-file anchor", "wrong-file anchor", "leaked anchor"],
    supersededCode: "E_STALE_ANCHOR",
    definedIn: "CONTEXT.md",
  },
];

describe("anchor term baseline stays recorded and shrink-only", () => {
  it("declares avoids and a superseded code for every entry", () => {
    for (const entry of ANCHOR_TERM_BASELINE) {
      expect(entry.avoids.length).toBeGreaterThan(0);
      expect(entry.supersededCode.length).toBeGreaterThan(0);
      expect(entry.definedIn.length).toBeGreaterThan(0);
    }
  });

  it("keeps every entry needed: CONTEXT still defines each term with its Avoid line", () => {
    for (const entry of ANCHOR_TERM_BASELINE) {
      const text = readFileSync(entry.definedIn, "utf-8");
      expect(text).toContain(`**${entry.term}**`);
      for (const avoid of entry.avoids) {
        expect(text).toContain(avoid);
      }
      const srcText = readFileSync("src/domain-errors.ts", "utf-8");
      expect(srcText).toContain(entry.supersededCode);
    }
  });
});

/**
 * ticket-07 — the retired wire spellings get a witness.
 * WHY: 05's doc rewrite had no witness in the suite: README.md/CONTEXT.md could
 * reintroduce a retired spelling (this header names `replace_with` in prose as
 * the example) with every test green — demonstrated by planting the spelling
 * and watching the arch suite stay green. This block is the ban half (absence)
 * plus the presence half (E25): the five corrected facts asserted as text, so a
 * rewrite that DELETES the corrected sentences fails too. The ban's CODE below
 * builds every needle dynamically and contains none of the banned strings as
 * literals; only this header names one in prose (verified: grepping this file
 * for the three spellings finds this header alone).
 * Judgement recorded (R3): camelCase, hyphenated and upper-case variants are
 * DIFFERENT tokens and out of this ban's contract — decided, not missed. The
 * `op` class IS closed to decorated key shapes in BOTH scopes — markers
 * `" ' ` * _` and curly quotes around `op`, any non-letter prefix (`-`, `(`,
 * `>`, `#`, `[`, own-line, `**`/`*` emphasis): the scope scans whole-file
 * text and carved files mask only leading-marker WHY:/SAFETY: comment lines
 * (without trailing live code) before the same whole-file predicate runs. A
 * colon-less mention (table value cell) is not key-shaped and stays outside.
 * Presence is pinned VERBATIM (R4): each added fragment raises the cost of a
 * legitimate doc rewrite — that cost is disclosed, not hidden.
 * SYMMETRY (I1/J4): the guard enumerates THREE sets — scope members, needle
 * members, carve-out members — and pins ALL THREE (ban test pins scope, pin
 * test pins needles, carve-out pin below pins exemptions, self-test
 * shape-pins `op`). Deliberately unpinned: camel/hyphen/upper variants
 * (different tokens, out of contract — see above). No silent asymmetry.
 * Shape copied from terminology-foreign-source.test.ts.
 */
const RETIRED_WIRE_NEEDLES = [
  ["replace", "with"].join("_"),
  ["copy", "from"].join("_"),
  ["delete", "source"].join("_"),
];

// WHY: key-shaped, never bare — a colon-less mention is not a key. Prose like
// "no `op` field" must stay green; only a payload key trips this. Markers
// `" ' ` * _` and curly quotes may decorate `op`; any non-letter may prefix
// it. The quiet arms below pin each tightening, one per shape. Every shape
// was probed in node before encoding (see report for the probe table).
const OP_KEY_NEEDLE =
  /(^|[^A-Za-z_])["'`*_\u201c\u201d\u2018\u2019]*op["'`*_\u201c\u201d\u2018\u2019]*\s*:/;

// WHY (E26): each carve-out states its reason as a fact about the artifact.
// (a1) src/edit.ts documents the removal: `replaceWithSchema` REMOVED, no
// fold for the retired spelling. (a2) src/hashline/apply.ts sweep note names
// the retired spellings it swept. The exemption is COMMENT-anchored, not
// substring-anchored: leading-marker WHY:/SAFETY: comment lines are masked
// before the same whole-file predicate runs (pinned by the arm below). A live
// spelling on any other line — including a code line with a trailing WHY:
// note — still reddens. Masked lines are invisible by design: a documenting
// comment ABOUT a live alias on a leading-marker line is textually
// indistinguishable from the sanctioned sweep note.
// `op` prose: the key-shaped needle does not match it (pinned by quiet arms).
// SCOPE BY SURFACE (E26 — a reason per exclusion). IN: README.md, CONTEXT.md
// (the taught contract), prompts/*.md (model instructions), src/**/*.ts
// (shipped code), scripts/ (model-facing strings on declared entry points
// (package.json scripts — scripts/ is NOT in the shipped files list) —
// the benchmark prompt taught the retired shape from here).
// OUT by default: every tracked path not listed IN (the mechanism is an allow-list).
// OUT: docs/** historical/archive records: spec, adr, articles,
// .archive_issues (a superseded tuple-payload note still names the retired
// key) -- but NOT docs/agents/*.md, which are LIVE agent instructions
// (issue-tracker, triage-labels, domain), nor docs/spec/, which holds the
// LIVE architecture spec agents are pointed at;
// CHANGELOG.md (release history); benchmarks/ (measurement scripts); the
// repo-root index.ts (re-export barrel). OUT: test/ — refusal fixtures plus
// this guard's own prose (not shrink-only, so no re-assertion is owed).
// THE GUARD'S STATED CONTRACT: per-file membership, per surface.
const RETIRED_WIRE_CARVE_OUT = new Set(["src/edit.ts", "src/hashline/apply.ts"]);

function retiredWireScope(): string[] {
  // WHY (J1/J2): extension-independent — the helper matches by endsWith, so
  // ext "." matches NOTHING (verified: "x.py".endsWith(".") is false) and
  // would make any assertion over its walk vacuous. The walk uses "" (every
  // path ends with "") and filters compiled artifacts; a new scripts/ file
  // of ANY extension is then a member unless carved.
  return [
    "README.md",
    "CONTEXT.md",
    ...allFiles("prompts", ".md"),
    ...srcFiles(),
    ...allFiles("scripts", "").filter((f) => !f.endsWith(".pyc")),
  ].filter((file) => !RETIRED_WIRE_CARVE_OUT.has(file));
}

function needsRetiredWire(text: string): boolean {
  return RETIRED_WIRE_NEEDLES.some((needle) => text.includes(needle)) || OP_KEY_NEEDLE.test(text);
}

function retiredWireViolations(): string[] {
  const out: string[] = [];
  for (const file of retiredWireScope()) {
    out.push(...(needsRetiredWire(readFileSync(file, "utf-8")) ? [file] : []));
  }
  return out;
}

function walkFiles(dir: string): string[] {
  // WHY (R1/R2): the pins' OWN recursive walk — deliberately NOT allFiles /
  // srcFiles. Producer and pins must not share fate: contracting the producer
  // reddens the pins, and contracting this walk leaves the producer's ban
  // intact to redden on the plant. No single edit outside the pins' own
  // bodies shrinks both sides at once.
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

describe("retired wire spellings stay banned and corrected facts stay present (ticket-07)", () => {
  it("names no retired wire spelling in README, CONTEXT, prompts, src or scripts (carve-outs excluded)", () => {
    // WHY: non-empty is not coverage (E21, E25 on the scope itself) — a
    // merely non-empty scope can be silently disarmed. Required members are
    // pinned: shrinking to src/ alone must redden; a legitimate rename is
    // fixed in one line.
    const scope = retiredWireScope();
    expect(scope.length).toBeGreaterThan(0);
    for (const required of ["README.md", "CONTEXT.md"]) expect(scope).toContain(required);
    // WHY (R1, per-file membership per surface): each surface is pinned
    // member-by-member from the pins' own walk — one surviving member can no
    // longer satisfy a surface. Carve-outs skipped (the loop would redden on
    // src/edit.ts otherwise).
    for (const f of walkFiles("prompts").filter((f) => f.endsWith(".md")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f);
    for (const f of walkFiles("src").filter((f) => f.endsWith(".ts")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f);
    for (const f of walkFiles("scripts").filter((f) => !f.endsWith(".pyc")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f); // every script a member or carve-out
    expect(scope).toContain("scripts/practical-token-benchmark.mjs"); // the motivated artifact, pinned BY NAME
    expect(scope).not.toContain("src/edit.ts"); // the carve-out is still applied
    expect([...RETIRED_WIRE_CARVE_OUT]).toEqual(["src/edit.ts", "src/hashline/apply.ts"]); // J4: carve-out set pinned against addition
    expect(retiredWireViolations()).toEqual([]);
  });

  it("pins the needle set's members: all three retired spellings stay banned", () => {
    // WHY (I1, SYMMETRY): scope members pinned and needle members pinned —
    // the two enumerations agree about deserving pinning. Trimming this set
    // must redden (acceptance mutates the enumeration itself).
    expect(RETIRED_WIRE_NEEDLES).toEqual([
      ["replace", "with"].join("_"),
      ["copy", "from"].join("_"),
      ["delete", "source"].join("_"),
    ]);
  });

  it("composition: retiredWireViolations lists planted bytes through the real loop", () => {
    // WHY (R3): F6 witnessed the detector; this witnesses the COMPOSITION.
    // Neutralising the scope×predicate loop (return []) must redden THIS arm.
    // The fixture is written, asserted, and deleted inside this test.
    const fixture = "scripts/__retired-wire-fixture.tmp";
    writeFileSync(fixture, "anchor_from\n" + ["replace", "with"].join("_") + "\n");
    try {
      expect(retiredWireViolations()).toContain(fixture);
    } finally {
      unlinkSync(fixture);
    }
  });

  it("keeps the carve-outs needed: each still documents the removal it excuses", () => {
    // WHY: shrink-only honesty — the moment a file stops documenting the
    // removal, its carve-out is a hole and must be removed. Specific tokens,
    // not bare words: generic "retired" also names parameters elsewhere in
    // apply.ts, so the arm pins the sweep note's own token plus the spelling.
    // Substance disclosure (R7): the pin quotes the note's distinctive
    // substance — `named wire fields` occurs once, at apply.ts:452. Rewording
    // the note's other words needs no test change; dropping the substance
    // clause or a named spelling needs the reason updated.
    const edit = readFileSync("src/edit.ts", "utf-8");
    expect(edit).toContain("REMOVED");
    expect(edit).toContain(["replace", "with"].join("_"));
    const apply = readFileSync("src/hashline/apply.ts", "utf-8");
    expect(apply).toMatch(/WHY:.*named wire fields/);
    expect(apply).toContain(["copy", "from"].join("_"));
    expect(apply).toContain(["delete", "source"].join("_"));
  });

  it("carved files carry the spellings only inside leading-marker WHY:/SAFETY: comment lines", () => {
    // WHY (I2/I3/R5): exemption anchored to comment LINES. A leading-marker
    // WHY:/SAFETY: line is masked ONLY when no live code follows its `*/` —
    // ` * WHY: compat */ const x = "replace_with";` reddens (D8). Masked
    // lines are invisible by design (see residual below); everything else,
    // including trailing-WHY: code lines and own-line `op` keys, reddens.
    // Failure names file:line. Residual, stated: a documenting comment ABOUT
    // a live alias with no trailing code stays exempt (indistinguishable
    // from the sanctioned note).
    for (const file of RETIRED_WIRE_CARVE_OUT) {
      const lines = readFileSync(file, "utf-8").split("\n");
      const masked = (line: string): boolean =>
        /^\s*(\/\/+|\/?\*+|\/\*)\s*(WHY|SAFETY):/.test(line) && !/\*\/\s*\S/.test(line);
      const text = lines.map((line) => (masked(line) ? "" : line)).join("\n");
      if (!needsRetiredWire(text)) continue;
      const hits: string[] = [];
      lines.forEach((line, i) => {
        if (masked(line)) return;
        if (needsRetiredWire(i > 0 ? `\n${line}` : line)) hits.push(`${file}:${i + 1}`);
      });
      expect(hits.length > 0 ? hits : [`${file}:masked-text match`]).toEqual([]);
    }
  });

  it("planted-term self-test: the scanner sees planted bytes and stays quiet otherwise", () => {
    // WHY: a text guard that cannot be seen failing proves nothing. These arms
    // run the REAL per-file predicate over fixtures of the scanned bytes —
    // neutralising the detector reddens this test, not just a human's manual
    // run. One fixture per `op`-key shape the detector claims to catch, and
    // one quiet arm per newly-tightened shape.
    const clean = readFileSync("README.md", "utf-8");
    expect(needsRetiredWire(clean)).toBe(false);
    expect(needsRetiredWire(clean + "\n" + ["replace", "with"].join("_"))).toBe(true);
    expect(needsRetiredWire('{ "anchor_from": "a", "text": "T" }')).toBe(false);
    expect(needsRetiredWire('{ anchor_from: "a", op: "replace" }')).toBe(true);
    expect(needsRetiredWire('{"op": "replace"}')).toBe(true);
    expect(needsRetiredWire('\n"op": "replace"')).toBe(true);
    expect(needsRetiredWire('[ "op": "replace" ]')).toBe(true);
    expect(needsRetiredWire('cell `op: "replace"` here')).toBe(true);
    expect(needsRetiredWire('- **op**: "replace"')).toBe(true);
    expect(needsRetiredWire('**op**: "replace"')).toBe(true);
    expect(needsRetiredWire('**`op`**: "replace"')).toBe(true);
    expect(needsRetiredWire('- **`op`**: "replace" is retired')).toBe(true);
    expect(needsRetiredWire('- *op*: "replace"')).toBe(true);
    expect(needsRetiredWire('\u201cop\u201d: "replace"')).toBe(true);
    expect(needsRetiredWire('- op: "replace"')).toBe(true);
    expect(needsRetiredWire('(op: "replace")')).toBe(true);
    expect(needsRetiredWire('> op: "replace"')).toBe(true);
    expect(needsRetiredWire("### op: replace")).toBe(true);
    expect(needsRetiredWire('the payload key `op`: "replace" is retired')).toBe(true);
    // WHY: the colon-less table cell is not key-shaped — outside the key
    // contract (probed false; the key contract requires the colon).
    expect(needsRetiredWire('| `op` | "replace" |')).toBe(false);
    expect(needsRetiredWire("there is no `op` field and no verbs")).toBe(false);
    expect(needsRetiredWire("a legacy key, an `op` field")).toBe(false);
    expect(needsRetiredWire('{"stop": "halt"}')).toBe(false);
    expect(needsRetiredWire("the crop: wheat")).toBe(false);
    expect(needsRetiredWire("- stop: halt")).toBe(false);
    expect(needsRetiredWire("(stop: 1)")).toBe(false);
    expect(needsRetiredWire("> note: text")).toBe(false);
    expect(needsRetiredWire("# top: picks")).toBe(false);
    expect(needsRetiredWire("op status")).toBe(false);
    expect(needsRetiredWire('- **stop**: "halt"')).toBe(false);
    expect(needsRetiredWire("(**stop**: 1)")).toBe(false);
    expect(needsRetiredWire('- *stop*: "x"')).toBe(false);
    expect(needsRetiredWire("\u201cstop\u201d: x")).toBe(false);
  });

  it("presence: the delete spelling is taught as text", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain('`""` deletes the range when placed in-place');
    expect(readme).toContain("[W_NOOP_INSERT]` as a no-op");
    expect(readme).toContain("does NOT delete");
  });

  it("presence: at defaults to in-place and the underscore spelling is refused", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain('Omitted means `"in-place"`');
    expect(readme).toContain('"in_place"` is refused');
    expect(readme).toContain('the canonical spelling is `"in-place"`');
  });

  it("presence: exactly one payload per item", () => {
    const context = readFileSync("CONTEXT.md", "utf-8");
    expect(context).toContain(
      "exactly one payload per item (`text` XOR `text_ref`, both or neither refused)",
    );
  });

  it("presence: SpanRef mode is required and file names another served file", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain("`mode` is **required** (never inferred)");
    expect(readme).toContain("`file` may name another served file");
    expect(readme).toContain('`"copy"` re-inserts the span and keeps the source');
    expect(readme).toContain('`"cut"` additionally retires it');
  });

  it("presence: foreign-source copy vocabulary, not cross-file", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain("foreign-source copy");
    expect(readme).toContain('(never called "cross-file" here');
  });
});
