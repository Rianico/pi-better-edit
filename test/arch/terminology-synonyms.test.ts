import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * `GLOSSARY.md` bans three synonyms the resolution seams used to carry (#101): `anchor identity`
 * (identity is a line's `line_id`), `range staleness` (canonical `served-range staleness`), and
 * `echo` for served feedback rows (canonical only inside `served hash echo`). The guard keeps the
 * rename from creeping back in (#108, #114) across `src/`, test titles and the binding docs.
 *
 * Every scope strips the canonical family first — `findServedHashEcho`, `ServedHashEchoError`,
 * `ServedHashEcho`, `servedHashEchoDenial`, `E_SUSPICIOUS_TEXT` (renamed per ADR-0019, no
 * alias), the glossary phrase, the quoted shell-builtin homonym, and a cited `docs/*.md` path
 * whose file exists — then asserts no bare `/echo/i` remains. `findEditHashEcho` /
 * `EditHashEchoError` are retired (#125) and must not reappear.
 */
function srcFiles(dir = "src", out: string[] = []): string[] {
  return allFiles(dir, ".ts", out);
}

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

const CANONICAL_ALLOWLIST = new Set<string>([]);

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
  out = out.replace(/served[\s\-_]*hash[\s\-_]*echo/gi, "");
  out = out.replace(/served-echo check bypassed by literal declaration/gi, "");
  out = out.replace(/"echo"|'echo'|`echo`/gi, "");
  out = out.replace(/docs\/[\w./-]+\.md/gi, (literal) => (existsSync(literal) ? "" : literal));
  return out;
}

/** Non-allowlisted source files still containing `/echo/i` after canonical stripping. */
function filesWithNonCanonicalEcho(): string[] {
  return files
    .filter((file) => !CANONICAL_ALLOWLIST.has(file))
    .filter((file) => /echo/i.test(stripCanonical(readFileSync(file, "utf-8"))));
}

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

//
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

const HISTORICAL_BASELINE: HistoricalBaselineEntry[] = [];

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
  const docs = ["GLOSSARY.md", ...allFiles("docs/adr", ".md")];
  return docs.filter((file) => {
    const text = readFileSync(file, "utf-8");
    const withoutAvoid = text
      .split("\n")
      .filter((line) => !/^\s*_Avoid_:/.test(line))
      .join("\n");
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

describe("path allowance — a cited record is provenance, not vocabulary", () => {
  it("allows the banned token inside a cited docs/ record path", () => {
    const cited = "// Ref: docs/.archive_adrs/0009-bounded-hash-echo-guard.md";
    expect(/echo/i.test(stripCanonical(cited))).toBe(false);
    const linked = "per [the guard](../../docs/.archive_adrs/0009-bounded-hash-echo-guard.md)";
    expect(/echo/i.test(stripCanonical(linked))).toBe(false);
  });

  it("flags a path-shaped decoy that backs no record", () => {
    const decoy = "// Ref: docs/.archive_adrs/9999-no-such-record-echo.md";
    expect(/echo/i.test(stripCanonical(decoy))).toBe(true);
  });

  it("still flags the same token as prose", () => {
    const prose =
      "// WHY: the echo of a served row names the feedback, which is banned vocabulary.";
    expect(/echo/i.test(stripCanonical(prose))).toBe(true);
  });
});

describe("GLOSSARY.md terminology — forbidden synonyms stay out of src/", () => {
  it("names no `anchor identity`: identity belongs to a line_id, not a presentation anchor", () => {
    expect(matching(/anchor identity|AnchorIdentity/)).toEqual([]);
  });

  it("names no `range staleness`: the canonical term is served-range staleness", () => {
    const violations = files.filter((file) => {
      const stripped = readFileSync(file, "utf-8").replace(/served-range staleness/gi, "");
      return /range staleness/i.test(stripped);
    });
    expect(violations).toEqual([]);
  });

  it("names served feedback as serve, not the avoided synonym, tree-wide (canonical family stripped)", () => {
    expect(filesWithNonCanonicalEcho()).toEqual([]);
  });

  it("keeps the canonical served hash echo family and the line-identity rename", () => {
    const apply = readFileSync("src/hashline/apply.ts", "utf-8");
    expect(apply).toContain("E_SUSPICIOUS_TEXT");
    expect(apply).toContain("findServedHashEcho");
    expect(apply).not.toContain("findEditHashEcho");
    expect(readFileSync("src/served-session/serve-render.ts", "utf-8")).toContain(
      "ServedHashEchoError",
    );
    expect(readFileSync("src/served-session/serve-render.ts", "utf-8")).not.toContain(
      "EditHashEchoError",
    );
    expect(readFileSync("src/hashline/resolve.ts", "utf-8")).toContain("resolveLineIdentity");
    expect(readFileSync("src/served-session/serve-render.ts", "utf-8")).toMatch(
      /served-range[\s*]+staleness/,
    );
  });
});

describe("quoted homonym strip stays narrow (option c)", () => {
  const fails = (sample: string): boolean => /echo/i.test(stripCanonical(sample));
  it("strips the three quoted homonym forms so they pass", () => {
    expect(fails('the static-print builtin "echo" prints a line')).toBe(false);
    expect(fails("the static-print builtin 'echo' prints a line")).toBe(false);
    expect(fails("the static-print builtin `echo` prints a line")).toBe(false);
  });
  it("a bare homonym mention still fails", () => {
    expect(fails("the static-print builtin echo prints a line")).toBe(true);
  });
  it("an identifier carrying the letters still fails", () => {
    expect(fails("function recordEchoRows() {")).toBe(true);
    expect(fails("const myEcho = 1;")).toBe(true);
  });
});

describe("GLOSSARY.md terminology — forbidden synonyms stay out of test titles/", () => {
  it("keeps test titles free of the avoided synonym for served feedback (canonical family stripped)", () => {
    expect(testTitleViolations()).toEqual([]);
  });
});

describe("GLOSSARY.md terminology — forbidden synonyms stay out of binding docs/", () => {
  it("keeps the binding domain docs free of the avoided synonym for served feedback (canonical family stripped)", () => {
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
    expect(names).not.toContain("GLOSSARY.md");
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
    definedIn: "GLOSSARY.md",
  },
  {
    term: "unknown anchor",
    avoids: ["unserved anchor", "missing anchor", "stale anchor"],
    supersededCode: "E_STALE_ANCHOR",
    definedIn: "GLOSSARY.md",
  },
  {
    term: "foreign anchor",
    avoids: ["cross-file anchor", "wrong-file anchor", "leaked anchor"],
    supersededCode: "E_STALE_ANCHOR",
    definedIn: "GLOSSARY.md",
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
 * ticket-07 — the retired wire spellings get a witness: the ban half asserts absence in README,
 * GLOSSARY, prompts, src, scripts and docs/reference, and the presence half pins the corrected
 * sentences as text, so a rewrite that deletes them fails too. The needles below are built
 * dynamically; no banned spelling appears as a literal here.
 *
 * The `op` class is closed to decorated key shapes in both scopes: markers around `op` and any
 * non-letter prefix count as key-shaped, while a colon-less mention (a table value cell) is
 * outside the contract. Camel, hyphen and upper-case variants are different tokens, out of the
 * contract. Scope is an allow-list; the carve-out is shrink-only, and the exemption masks only
 * leading-marker comment lines with no live code after them.
 */
const RETIRED_WIRE_NEEDLES = [
  ["replace", "with"].join("_"),
  ["copy", "from"].join("_"),
  ["delete", "source"].join("_"),
];

const OP_KEY_NEEDLE =
  /(^|[^A-Za-z_])["'`*_\u201c\u201d\u2018\u2019]*op["'`*_\u201c\u201d\u2018\u2019]*\s*:/;

const RETIRED_WIRE_CARVE_OUT = new Set(["src/edit.ts"]);

function retiredWireScope(): string[] {
  return [
    "README.md",
    "GLOSSARY.md",
    ...allFiles("prompts", ".md"),
    ...srcFiles(),
    ...allFiles("docs/reference", ".md"),
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
    const scope = retiredWireScope();
    expect(scope.length).toBeGreaterThan(0);
    for (const required of ["README.md", "GLOSSARY.md"]) expect(scope).toContain(required);
    for (const f of walkFiles("prompts").filter((f) => f.endsWith(".md")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f);
    for (const f of walkFiles("src").filter((f) => f.endsWith(".ts")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f);
    for (const f of walkFiles("scripts").filter((f) => !f.endsWith(".pyc")))
      if (!RETIRED_WIRE_CARVE_OUT.has(f)) expect(scope).toContain(f);
    for (const f of walkFiles("docs/reference").filter((f) => f.endsWith(".md")))
      expect(scope).toContain(f);
    expect(scope).toContain("scripts/runtime-edge-test.mjs");
    expect(scope).not.toContain("src/edit.ts");
    expect([...RETIRED_WIRE_CARVE_OUT]).toEqual(["src/edit.ts"]);
    expect(retiredWireViolations()).toEqual([]);
  });

  it("pins the needle set's members: all three retired spellings stay banned", () => {
    expect(RETIRED_WIRE_NEEDLES).toEqual([
      ["replace", "with"].join("_"),
      ["copy", "from"].join("_"),
      ["delete", "source"].join("_"),
    ]);
  });

  it("composition: retiredWireViolations lists planted bytes through the real loop", () => {
    const fixture = "scripts/__retired-wire-fixture.tmp";
    writeFileSync(fixture, "anchor_from\n" + ["replace", "with"].join("_") + "\n");
    try {
      expect(retiredWireViolations()).toContain(fixture);
    } finally {
      unlinkSync(fixture);
    }
  });

  it("keeps the carve-outs needed: each still documents the removal it excuses", () => {
    const edit = readFileSync("src/edit.ts", "utf-8");
    expect(edit).toContain("REMOVED");
    expect(edit).toContain(["replace", "with"].join("_"));
    const apply = readFileSync("src/hashline/apply.ts", "utf-8");
    expect(apply).not.toContain(["copy", "from"].join("_"));
    expect(apply).not.toContain(["delete", "source"].join("_"));
  });

  it("carved files carry the spellings only inside a leading-marker comment line", () => {
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
    const context = readFileSync("GLOSSARY.md", "utf-8");
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
