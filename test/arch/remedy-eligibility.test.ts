import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_REGISTRY,
  WARNING_REGISTRY,
  type DomainErrorCode,
  type DomainWarningCode,
  type ErrorPayloadMap,
} from "../../src/domain-errors.js";
import { batchAbortFor, batchAbortForMany } from "../../src/edit-response.js";

/**
 * Options-disclosure oracle (ADR-0047). Facts are the default: every rejection
 * renders what happened. A served `Options:` section is the exception, and it is
 * pinned to a curated set, shaped as a list of admissible moves — never a single
 * directive, because one suggestion biases the model's next call.
 *
 * This replaces the remedy-eligibility oracle: the old `remedy` string was
 * declared per code and rendered by no path, so the six defects found in it were
 * invisible and unenforced. An unserved action cannot be kept honest.
 *
 * Falsifiability: `optionProblems` fails a one-item list, a duplicate, a
 * terminal period, a harmful verb and a preference adverb (negative controls
 * below), and the curated-set check fails any code that declares options
 * without joining the set.
 */

type OptionsCode = "E_SUSPICIOUS_TEXT" | "E_BATCH_ABORT" | "E_UNDO_UNAVAILABLE";
type FreeCode = Exclude<DomainErrorCode, OptionsCode>;

const OPTIONS_CODES: readonly OptionsCode[] = [
  "E_SUSPICIOUS_TEXT",
  "E_BATCH_ABORT",
  "E_UNDO_UNAVAILABLE",
];

// WHY: two arms for the suspicious code (text vs content) — the branch is the
// WHY: reason the options are a function there. Two blocks for BATCH_ABORT so
// WHY: the options line is rendered after both a served block and its absence.
const OPTIONS_FIXTURES: { [K in OptionsCode]: ErrorPayloadMap[K][] } = {
  E_SUSPICIOUS_TEXT: [
    { target: "edit", path: "src/a.ts", line: 2, hash: "aB3x", servedLine: 1, count: 1 },
    { target: "write", path: "src/a.ts", line: 2, hash: "aB3x", servedLine: 1, count: 2 },
  ],
  E_BATCH_ABORT: [
    {
      earlierIndex: 0,
      laterIndex: 1,
      earlierStart: 1,
      earlierEnd: 3,
      laterStart: 2,
      laterEnd: 4,
      path: "a.py",
      servedBlock: "aB3x│alpha",
    },
    {
      earlierIndex: 0,
      laterIndex: 1,
      earlierStart: 1,
      earlierEnd: 3,
      laterStart: 2,
      laterEnd: 4,
      path: "a.py",
      servedBlock: "",
    },
  ],
  E_UNDO_UNAVAILABLE: [{ path: "a.py" }],
};

// WHY: one payload per fact-only code. The assertion is per-code and total —
// WHY: every non-curated code renders zero `Options:` lines. Distinct arms are
// WHY: other tests' business; this matrix polices the disclosure set.
// WHY: ordered arms per code, not one payload each. The #128 lesson: a multi-arm renderer
// WHY: checked on one arm leaves every other arm unpoliced. Single-arm codes still carry one.
const FACT_ONLY_FIXTURES: { [K in FreeCode]: ErrorPayloadMap[K][] } = {
  E_BAD_PAYLOAD: [{ message: "probe refused." }, { message: "probe refused.", subject: "read" }],
  E_EMPTY_RANGE: [{}],
  E_STALE_ANCHOR: [
    {
      headline: "line 1 no longer resolves to the line identity it was served with.",
      servedRows: [{ position: 0, hash: "aB3x" }],
      servedBlock: "aB3x│alpha",
      cause: "retirement",
    },
    {
      headline: "no rows are served for this rejection.",
      servedRows: [],
      servedBlock: "",
      cause: "never-served",
    },
  ],
  E_UNKNOWN_ANCHOR: [
    { path: "a.py", anchors: ["ZZZ"] },
    { path: "a.py", anchors: [] },
    { path: "a.py", anchors: ["ZZZ", "wUp"] },
  ],
  E_FOREIGN_ANCHOR: [
    { path: "a.py", anchors: ["wUp"], homes: ["b.py"] },
    { path: "a.py", anchors: ["wUp", "ZZZ"], homes: ["b.py", "c.py"] },
    { path: "a.py", anchors: ["wUp"], homes: [] },
    { path: "a.py", anchors: ["wUp"], homes: ["b.py", "c.py", "d.py", "e.py"] },
  ],
  E_STALE_RANGE: [
    {
      headline: "line 1 differs from what was served.",
      servedRows: [{ position: 0, hash: "aB3x" }],
      servedBlock: "aB3x│alpha",
      cause: "served-range staleness",
    },
    {
      headline: "no rows are served for this rejection.",
      servedRows: [],
      servedBlock: "",
      cause: "served-range staleness",
    },
  ],
  E_TARGET_LOST: [
    { servedLine: 3, path: "a.py", cause: "retirement" },
    { servedLine: 3, cause: "retirement" },
  ],
  E_UNVERIFIED_RANGE: [
    {
      headline: "bound 1 no longer resolves.",
      servedRows: [{ position: 0, hash: "aB3x" }],
      servedBlock: "aB3x│alpha",
      cause: "retirement",
    },
    { servedRows: [], servedBlock: "", cause: "retirement" },
  ],
  E_MALFORMED_ANCHOR: [
    { rawAnchor: "aB3x│alpha", reason: "Expected a 4-char anchor" },
    { rawAnchor: "aB3x", reason: "Expected a 4-char anchor." },
  ],
  E_NOOP_LOOP: [
    {
      ref: "edit[0] (a.py)",
      removeFrom: "aB3x",
      removeTo: "cD4e",
      count: 3,
      batch: false,
      servedRows: [{ position: 0, hash: "aB3x" }],
      servedBlock: "aB3x│alpha",
    },
    {
      ref: "edit[0] (a.py)",
      removeFrom: "aB3x",
      removeTo: "cD4e",
      count: 3,
      batch: true,
      servedRows: [{ position: 0, hash: "aB3x" }],
      servedBlock: "aB3x│alpha",
    },
  ],
  E_UNSUPPORTED_FILE: [
    { path: "a", kind: "directory" },
    { path: "a", kind: "image" },
    { path: "a", kind: "binary", description: "UTF-16LE" },
  ],
  E_ACCESS: [
    { path: "a", kind: "denied" },
    { path: "a", kind: "denied", access: "write" },
    { path: "a", kind: "symlink-loop" },
    { path: "a", kind: "unreachable" },
  ],
  E_NOT_FOUND: [{ path: "a.py" }],
  E_UNDO_STALE: [
    { path: "a.py", reason: "deleted" },
    { path: "a.py", reason: "modified" },
  ],
  E_LOSSY_TEXT: [{ path: "a.py" }],
  E_UNDO_REVERT_FAILED: [{ path: "a.py" }],
  E_UNKNOWN: [{ errorName: "Error", message: "boom" }],
  E_LARGE_FILE: [
    { path: "big.log", limitKind: "lines", lineCount: 250000, limit: 200000 },
    { path: "big.log", limitKind: "hash-space", limit: 14766336 },
  ],
  E_INTERNAL_INVARIANT: [
    { message: "Path contains null byte" },
    { message: "Path contains null byte", subject: "read" },
  ],
};

const FREE_CODES = Object.keys(FACT_ONLY_FIXTURES) as FreeCode[];

// WHY: an intent-guessing suggestion steers the next call, so a fact-only code
// WHY: must not render an imperative in its own text either.
const IMPERATIVE = /\b(retry|use|run|execute|omit|declare|choose|merge|pass|send|fix)\b/i;

// WHY: a served option must be non-destructive and non-coercive; "prefer" words
// WHY: turn a list of choices back into a recommendation.
const HARMFUL = [
  "delete",
  "destroy",
  "ignore",
  "bypass",
  "force",
  "override",
  "proceed",
  "skip",
  "maybe",
  "probably",
  "might",
  "guess",
];
const BIASED = /\b(should|must|best|just|simply|always|never)\b/i;

/** The `Options:` line of a rendered message, or undefined when none is served. */
function optionsLine(message: string): string | undefined {
  return message.split("\n").find((line) => line.startsWith("Options: "));
}

/** Parse a rendered `Options: a; or b.` line into its alternatives. */
function parseOptions(message: string): string[] {
  const line = optionsLine(message);
  if (line === undefined) return [];
  const body = line.slice("Options: ".length);
  expect(body.endsWith("."), line).toBe(true);
  return body.slice(0, -1).split("; or ");
}

function optionProblems(options: readonly string[]): string[] {
  const problems: string[] = [];
  if (options.length < 2) problems.push("fewer-than-two");
  if (new Set(options).size !== options.length) problems.push("duplicate");
  for (const option of options) {
    if (option.length < 5 || option.length > 90) problems.push(`length:${option}`);
    if (/[.;]$/.test(option)) problems.push(`terminal:${option}`);
    const lower = option.toLowerCase();
    for (const token of HARMFUL) {
      if (lower.includes(token)) problems.push(`harmful:${token}`);
    }
    if (BIASED.test(option)) problems.push(`biased:${option}`);
  }
  return problems;
}

function renderFree(code: FreeCode): string[] {
  return FACT_ONLY_FIXTURES[code].map((payload) => new DomainError(code, payload).message);
}

function renderOptions(code: OptionsCode, payload: ErrorPayloadMap[OptionsCode]): string {
  return new DomainError(code, payload).message;
}

describe("options disclosure oracle: facts by default, neutral lists by exception", () => {
  it("declares options on exactly the curated three", () => {
    const declared = (Object.keys(ERROR_REGISTRY) as DomainErrorCode[])
      .filter((code) => ERROR_REGISTRY[code].options !== undefined)
      .sort();
    expect(declared).toEqual([...OPTIONS_CODES].sort());
  });

  it("no warning code declares options: formatWarning renders format only", () => {
    for (const code of Object.keys(WARNING_REGISTRY) as DomainWarningCode[]) {
      expect(WARNING_REGISTRY[code].options, code).toBeUndefined();
    }
  });

  it("indents an options block inside a batch item", () => {
    const error = new DomainError("E_SUSPICIOUS_TEXT", {
      target: "edit",
      path: "a.py",
      line: 2,
      hash: "aB3x",
      servedLine: 1,
      count: 1,
    });
    const single = batchAbortFor({ error, index: 1, path: "a.py" });
    const many = batchAbortForMany({ failures: [{ error, index: 1 }], path: "a.py" });
    for (const wrapped of [single, many]) {
      expect(wrapped.message).toContain("\n  Options: ");
      expect(wrapped.message).not.toMatch(/^Options: /m);
      expect(wrapped.message).not.toContain("then resubmit");
    }
  });

  it("every non-curated code renders facts only, in every arm", () => {
    for (const code of FREE_CODES) {
      for (const message of renderFree(code)) {
        expect(message, code).not.toContain("\nOptions:");
        expect(optionsLine(message), code).toBeUndefined();
        expect(IMPERATIVE.test(message), `${code}: ${message}`).toBe(false);
      }
    }
  });

  it("a served section is a list of two or more alternatives", () => {
    for (const code of OPTIONS_CODES) {
      for (const payload of OPTIONS_FIXTURES[code]) {
        const message = renderOptions(code, payload);
        const options = parseOptions(message);
        expect(options.length, message).toBeGreaterThanOrEqual(2);
        expect(new Set(options).size, message).toBe(options.length);
        expect(optionProblems(options), message).toEqual([]);
        expect((optionsLine(message) ?? "").length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("E_SUSPICIOUS_TEXT branches on the guarded field", () => {
    const [edit, write] = OPTIONS_FIXTURES.E_SUSPICIOUS_TEXT as [
      ErrorPayloadMap["E_SUSPICIOUS_TEXT"],
      ErrorPayloadMap["E_SUSPICIOUS_TEXT"],
    ];
    const editOptions = parseOptions(renderOptions("E_SUSPICIOUS_TEXT", edit)).join("; ");
    const writeOptions = parseOptions(renderOptions("E_SUSPICIOUS_TEXT", write)).join("; ");
    expect(editOptions).toContain("from text");
    expect(editOptions).not.toContain("from content");
    expect(writeOptions).toContain("from content");
    expect(writeOptions).not.toContain("from text");
    expect(editOptions).toContain('mode: "literal"');
    expect(writeOptions).toContain('mode: "literal"');
  });

  it("the literal disclosure is rendered exactly once", () => {
    const message = renderOptions("E_SUSPICIOUS_TEXT", OPTIONS_FIXTURES.E_SUSPICIOUS_TEXT[0]!);
    expect(message.match(/mode: "literal"/g)).toHaveLength(1);
  });

  it("the submission tally agrees with its count", () => {
    const first = renderOptions("E_SUSPICIOUS_TEXT", OPTIONS_FIXTURES.E_SUSPICIOUS_TEXT[0]!);
    const second = renderOptions("E_SUSPICIOUS_TEXT", OPTIONS_FIXTURES.E_SUSPICIOUS_TEXT[1]!);
    expect(first).toContain("(submission 1 time)");
    expect(first).not.toContain("1 times");
    expect(second).toContain("(submission 2 times)");
  });

  it("refuses the both-empty range pair at construction instead of a bare header (04b §12.2)", () => {
    expect(
      () =>
        new DomainError("E_STALE_RANGE", {
          headline: "",
          servedRows: [],
          servedBlock: "",
          cause: "served-range staleness",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new DomainError("E_UNVERIFIED_RANGE", {
          headline: "",
          servedRows: [],
          servedBlock: "",
          cause: "retirement",
        }),
    ).toThrow(TypeError);
  });

  it("negative control: one option fails the list shape", () => {
    expect(optionProblems(["retry the edit"])).toContain("fewer-than-two");
  });

  it("negative control: duplicates, terminal periods, harmful verbs and preference fail", () => {
    expect(optionProblems(["retry the edit", "retry the edit"])).toContain("duplicate");
    expect(optionProblems(["retry the edit.", "use write"])).toContain("terminal:retry the edit.");
    expect(optionProblems(["ignore the rows", "use write"])).toContain("harmful:ignore");
    expect(optionProblems(["just retry", "use write"])).toContain("biased:just retry");
  });
  it("negative control: a planted option on a real entry fails the set check", () => {
    const planted = {
      ...ERROR_REGISTRY,
      E_NOT_FOUND: { ...ERROR_REGISTRY.E_NOT_FOUND, options: ["first", "second"] },
    };
    const declared = (Object.keys(planted) as DomainErrorCode[])
      .filter((code) => planted[code].options !== undefined)
      .sort();
    expect(declared).not.toEqual([...OPTIONS_CODES].sort());
  });
});

/**
 * Producer half. The checks above read the registry as data; the strings real
 * producers pass are invisible to them. A fact-only code's producer `message:`
 * literal is model-facing too, so it must not smuggle an imperative back in.
 * The scanned set is derived from the registry, so a code that gains options
 * leaves the scan the moment it is declared.
 */

// WHY: comment prose talks ABOUT codes and options. Extraction therefore
// WHY: requires `new DomainError("<code>"`, slices that call's argument list,
// WHY: reads only the literal bound to `message:`, and strips comments first, so
// WHY: even a commented-out payload cannot match.
function skipLiteral(source: string, at: number): number {
  const quote = source[at];
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      index = skipBalanced(source, index + 1);
      continue;
    }
    index += 1;
  }
  return index;
}

function skipBalanced(source: string, at: number): number {
  let depth = 0;
  let index = at;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipLiteral(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = skipLiteral(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function callArguments(source: string, open: number): string {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipLiteral(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
    index += 1;
  }
  return source.slice(open + 1);
}

function literalText(source: string, at: number): string {
  const quote = source[at];
  let out = "";
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      out += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === quote) break;
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      index = skipBalanced(source, index + 1);
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function messageLiteral(payload: string): string | undefined {
  const clean = stripComments(payload);
  const match = /\bmessage\s*:\s*/.exec(clean);
  if (match === null) return undefined;
  const at = match.index + match[0].length;
  const quote = clean[at];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  return literalText(clean, at);
}

function producerMessages(
  source: string,
  codes: ReadonlySet<string>,
): { code: string; text: string }[] {
  const found: { code: string; text: string }[] = [];
  for (const match of source.matchAll(/new DomainError\(\s*"([A-Z_]+)"/g)) {
    const code = match[1];
    if (!codes.has(code)) continue;
    const open = source.indexOf("(", match.index);
    const text = messageLiteral(callArguments(source, open));
    if (text !== undefined) found.push({ code, text });
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

// WHY: derived from the registry, so the set cannot drift from the declaration it polices.
const FACT_ONLY_CODES: readonly DomainErrorCode[] = (
  Object.keys(ERROR_REGISTRY) as DomainErrorCode[]
).filter((code) => ERROR_REGISTRY[code].options === undefined);

// WHY: E_BAD_PAYLOAD admission text is a separate curated surface (ADR-0036 Option C, ADR-0047 (d)):
// WHY: the binary Choice A/B wire-shape choice and the required/optional null rule. `analyzeItem`
// WHY: returns those strings, so this scan cannot see them; test/tools/edit.wire-contract.test.ts
// WHY: pins them.

describe("fact-only producers carry no imperative", () => {
  const codes = new Set<string>(FACT_ONLY_CODES);

  it("scans every code the registry declares fact-only", () => {
    expect(FACT_ONLY_CODES).toHaveLength(19);
    expect(FACT_ONLY_CODES).not.toContain("E_SUSPICIOUS_TEXT");
    expect(FACT_ONLY_CODES).not.toContain("E_BATCH_ABORT");
    expect(FACT_ONLY_CODES).not.toContain("E_UNDO_UNAVAILABLE");
    expect(FACT_ONLY_CODES).toContain("E_INTERNAL_INVARIANT");
    expect(FACT_ONLY_CODES).toContain("E_UNDO_STALE");
    expect(new Set(FACT_ONLY_CODES).size).toBe(FACT_ONLY_CODES.length);
  });

  it("no producer message for a fact-only code contains an imperative", () => {
    const offenders: string[] = [];
    const perCode = new Map<string, number>();
    for (const file of sourceFiles("src")) {
      for (const { code, text } of producerMessages(readFileSync(file, "utf-8"), codes)) {
        perCode.set(code, (perCode.get(code) ?? 0) + 1);
        if (IMPERATIVE.test(text)) offenders.push(`${file} [${code}] ${text}`);
      }
    }
    // WHY: a scan that quietly stopped reading producers would satisfy the assertion below on an
    // WHY: empty corpus, so the corpus is pinned too. Measured today: 24 sites carry a literal
    // WHY: message, across `E_INTERNAL_INVARIANT` and `E_UNKNOWN`. The floor is deliberately below
    // WHY: that, because a legitimate removal must not fail this test, while a scan that stops
    // WHY: reading will.
    expect([...perCode.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(20);
    expect(perCode.size).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it("negative control: a planted tail at the real fs-write sites fails the scan", () => {
    const planted = readFileSync("src/fs-write.ts", "utf-8").replaceAll(
      "Path contains null byte.",
      "Path contains null byte. Pass a plain file string and retry.",
    );
    const offenders = producerMessages(planted, codes).filter(({ text }) => IMPERATIVE.test(text));
    expect(offenders).toHaveLength(3);
  });

  it("mechanism: comment prose quoting a removed remedy is never read as a payload", () => {
    const source = [
      "const codes: readonly string[] = [",
      '  "E_UNKNOWN_ANCHOR",',
      '  "E_FOREIGN_ANCHOR",',
      "];",
      "// WHY: never rewritten as E_STALE_ANCHOR with its",
      '// WHY: "The latest known status is in this rejection. Retry as it directs." remedy.',
      'throw new DomainError("E_INTERNAL_INVARIANT", { message: "Path contains null byte." });',
    ].join("\n");
    const naiveWindow = source.slice(0, source.indexOf("throw") + 600);
    expect(naiveWindow).toContain("E_UNKNOWN_ANCHOR");
    expect(IMPERATIVE.test(naiveWindow)).toBe(true);
    expect(producerMessages(source, codes)).toEqual([
      { code: "E_INTERNAL_INVARIANT", text: "Path contains null byte." },
    ]);
  });
});
