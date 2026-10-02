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
 * code is `E_SUSPICIOUS_TEXT` (renamed per ADR-0019, no alias); the surface-qualified
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
 * reintroduce `replace_with` (and friends) with every test green — demonstrated
 * by planting the spelling and watching the arch suite stay green. This block is
 * the ban half (absence) plus the presence half (E25): the five corrected facts
 * asserted as text, so a rewrite that DELETES the corrected sentences fails too.
 * Needles are built dynamically so this guard file never contains the banned
 * strings itself. Shape copied from terminology-foreign-source.test.ts.
 */
const RETIRED_WIRE_NEEDLES = [
  ["replace", "with"].join("_"),
  ["copy", "from"].join("_"),
  ["delete", "source"].join("_"),
];

// WHY: key-shaped, never bare. Prose like "no `op` field"
// (src/payload-contract.ts) must stay green; only a payload key trips this.
// The discriminator arm below pins both sides.
const OP_KEY_NEEDLE = /[{,]\s*("op"|'op'|op)\s*:/;

// WHY (E26): each carve-out states its reason as a fact about the artifact.
// (a1) src/edit.ts documents the removal: `replaceWithSchema` REMOVED, no
// fold for the retired spelling. (a2) src/hashline/apply.ts sweep note names
// the retired spellings it swept. No carve-out for `op` prose: the key-shaped
// needle does not match it (pinned by the quiet arm). ADR/CHANGELOG history
// is out of the ban scope, so no baseline entries exist here.
const RETIRED_WIRE_CARVE_OUT = new Set(["src/edit.ts", "src/hashline/apply.ts"]);

function retiredWireScope(): string[] {
  return ["README.md", "CONTEXT.md", ...allFiles("prompts", ".md"), ...srcFiles()].filter(
    (file) => !RETIRED_WIRE_CARVE_OUT.has(file),
  );
}

function retiredWireViolations(): string[] {
  const out: string[] = [];
  for (const file of retiredWireScope()) {
    const text = readFileSync(file, "utf-8");
    if (RETIRED_WIRE_NEEDLES.some((needle) => text.includes(needle)) || OP_KEY_NEEDLE.test(text)) {
      out.push(file);
    }
  }
  return out;
}

describe("retired wire spellings stay banned and corrected facts stay present (ticket-07)", () => {
  it("names no retired wire spelling in README, CONTEXT, prompts or src (carve-outs excluded)", () => {
    // WHY: a silently empty scope would pass by construction (E21) — the
    // scope itself is asserted non-empty before the ban is checked.
    expect(retiredWireScope().length).toBeGreaterThan(0);
    expect(retiredWireViolations()).toEqual([]);
  });

  it("keeps the carve-outs needed: each still documents the removal it excuses", () => {
    // WHY: shrink-only honesty — the moment a file stops documenting the
    // removal, its carve-out is a hole and must be removed.
    expect(readFileSync("src/edit.ts", "utf-8")).toContain("REMOVED");
    expect(readFileSync("src/hashline/apply.ts", "utf-8")).toContain("retired");
  });

  it("planted-term self-test: needles see planted occurrences and stay quiet otherwise", () => {
    // WHY: a text guard that cannot be seen failing proves nothing. Planted
    // spellings are checked against the needles, and the canonical wire
    // sample plus the `op` prose stay quiet — the discriminator that keeps
    // the key-shaped needle honest.
    const planted = `{ ${RETIRED_WIRE_NEEDLES[0]}: "x" }`;
    expect(RETIRED_WIRE_NEEDLES.some((needle) => planted.includes(needle))).toBe(true);
    expect(
      RETIRED_WIRE_NEEDLES.some((needle) => '{ "anchor_from": "a", "text": "T" }'.includes(needle)),
    ).toBe(false);
    expect(OP_KEY_NEEDLE.test('{ anchor_from: "a", op: "replace" }')).toBe(true);
    expect(OP_KEY_NEEDLE.test('{"op": "replace"}')).toBe(true);
    expect(OP_KEY_NEEDLE.test("there is no `op` field and no verbs")).toBe(false);
    expect(OP_KEY_NEEDLE.test("a legacy key, an `op` field")).toBe(false);
  });

  it("presence: the delete spelling is taught as text", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain('`""` deletes the range when placed in-place');
    expect(readme).toContain("[W_NOOP_INSERT]` as a no-op");
  });

  it("presence: at defaults to in-place and the underscore spelling is refused", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain('Omitted means `"in-place"`');
    expect(readme).toContain('"in_place"` is refused');
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
  });

  it("presence: foreign-source copy vocabulary, not cross-file", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain("foreign-source copy");
    expect(readme).toContain('(never called "cross-file" here');
  });
});
