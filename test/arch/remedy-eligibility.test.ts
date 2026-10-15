import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_REGISTRY,
  type DomainErrorCode,
  type ErrorPayloadMap,
} from "../../src/domain-errors.js";

/**
 * Remedy-eligibility oracle (review ruling: the check that encodes the
 * principle rather than trusting prose). The declared policy is read as
 * data from `src/domain-errors.ts` — the `remedy` field on each
 * `ERROR_REGISTRY` entry — so a future code handed a remedy without a
 * matching declaration fails here. Both directions are asserted: a
 * code declared remedy-free carries no remedy field and renders no
 * imperative suggestion in its model-facing text, while every declared
 * remedy satisfies the eligibility rule (helpful, unharmful,
 * fail-closed, evidence-pinned to a single cause).
 *
 * Falsifiability: `freeViolations` fails a planted remedy on a
 * remedy-free code and a planted imperative in its text, while
 * `remedyProblems` fails a planted ineligible remedy (see the
 * negative controls below).
 */

type RemedyFreeCode =
  | "E_UNKNOWN"
  | "E_UNKNOWN_ANCHOR"
  | "E_FOREIGN_ANCHOR"
  | "E_UNVERIFIED_RANGE"
  | "E_STALE_RANGE"
  | "E_NOOP_LOOP"
  | "E_INTERNAL_INVARIANT";

const REMEDY_FREE: RemedyFreeCode[] = [
  "E_UNKNOWN",
  "E_UNKNOWN_ANCHOR",
  "E_FOREIGN_ANCHOR",
  "E_UNVERIFIED_RANGE",
  "E_STALE_RANGE",
  "E_NOOP_LOOP",
  "E_INTERNAL_INVARIANT",
];

const FREE_EXAMPLES: { [K in RemedyFreeCode]: ErrorPayloadMap[K] } = {
  E_UNKNOWN: { errorName: "Error", message: "boom" },
  E_UNKNOWN_ANCHOR: { path: "a.py", anchors: ["ZZZ"] },
  E_FOREIGN_ANCHOR: { path: "a.py", anchors: ["wUp"], homes: ["b.py"] },
  E_UNVERIFIED_RANGE: {
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abcc│alpha",
    cause: "retirement",
  },
  E_STALE_RANGE: {
    headline: "line 1 differs from what was served.",
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abcc│alpha",
    cause: "served-range staleness",
  },
  E_NOOP_LOOP: {
    ref: "edit[0] (probe.ts)",
    removeFrom: "abc",
    removeTo: "def",
    count: 3,
    batch: false,
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abcc│alpha",
  },
  E_INTERNAL_INVARIANT: { message: "Path contains null byte" },
};

// WHY: an intent-guessing suggestion steers the model's next action, so a
// WHY: remedy-free payload must state the fact with no imperative clause.
// WHY: Checked against the rendered envelope (block content in the examples
// WHY: is benign, so a hit names real suggestion text, never file bytes).
const IMPERATIVE = /\b(retry|use|run|execute|omit|declare|choose|merge|pass|send|fix)\b/i;

// WHY: structural proxy for helpful, unharmful, fail-closed, and
// WHY: evidence-pinned: a remedy names one concrete next action on the
// WHY: evidence at hand, ends the thought, and never reaches for harm,
// WHY: dismissal, or guesswork.
const ACTION_TOKENS = [
  "retry",
  "read",
  "write",
  "file",
  "anchor",
  "range",
  "served",
  "edit",
  "call",
  "choose",
  "merge",
  "omit",
  "declare",
  "ls",
  "text",
  "permissions",
];

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

function freeViolations(args: {
  code: DomainErrorCode;
  remedy: string | undefined;
  message: string;
}): string[] {
  const problems: string[] = [];
  if (args.remedy !== undefined) problems.push(`${args.code} declares a remedy`);
  if (IMPERATIVE.test(args.message)) problems.push(`${args.code} renders an imperative`);
  return problems;
}

function remedyProblems(code: DomainErrorCode, remedy: string): string[] {
  const problems: string[] = [];
  if (remedy.length < 10 || remedy.length > 140) problems.push("length");
  if (!remedy.endsWith(".")) problems.push("terminal");
  const lower = remedy.toLowerCase();
  if (!ACTION_TOKENS.some((token) => lower.includes(token))) problems.push("no-action-token");
  for (const token of HARMFUL) {
    if (lower.includes(token)) problems.push(`harmful:${token}`);
  }
  if (lower.includes("no action is required")) problems.push("filler");
  if (problems.length > 0) problems.unshift(code);
  return problems;
}

describe("remedy eligibility oracle: both directions over the registry", () => {
  it("remedy-free codes declare no remedy in the registry", () => {
    for (const code of REMEDY_FREE) {
      expect(ERROR_REGISTRY[code].remedy).toBeUndefined();
    }
  });

  it("remedy-free codes render no imperative suggestion", () => {
    for (const code of REMEDY_FREE) {
      const rendered = new DomainError(code, FREE_EXAMPLES[code]).message;
      expect(
        freeViolations({ code, remedy: ERROR_REGISTRY[code].remedy, message: rendered }),
      ).toEqual([]);
    }
  });

  it("every declared remedy satisfies the eligibility rule", () => {
    const problems: string[][] = [];
    for (const code of Object.keys(ERROR_REGISTRY) as DomainErrorCode[]) {
      const remedy = ERROR_REGISTRY[code].remedy;
      if (remedy !== undefined) {
        const found = remedyProblems(code, remedy);
        if (found.length > 0) problems.push(found);
      }
    }
    expect(problems).toEqual([]);
  });

  it("negative control: a planted remedy on a free code fails the free check", () => {
    expect(
      freeViolations({
        code: "E_UNKNOWN",
        remedy: "Retry the edit.",
        message: "unexpected Error: boom",
      }),
    ).not.toEqual([]);
  });

  it("negative control: a planted imperative in free text fails the free check", () => {
    expect(
      freeViolations({
        code: "E_UNKNOWN_ANCHOR",
        remedy: undefined,
        message: 'a.py has not served the anchor "ZZZ"; retry with fresh anchors.',
      }),
    ).not.toEqual([]);
  });

  it("negative control: a planted ineligible remedy fails eligibility", () => {
    expect(remedyProblems("E_STALE_RANGE", "Just proceed and ignore the error.")).not.toEqual([]);
  });
});

/**
 * Producer half of the oracle (#125). The checks above read the registry as data — each code's
 * declared `remedy` and each remedy-free code's own example payload — so the strings real producers
 * pass are invisible to them: three `E_INTERNAL_INVARIANT` sites kept "Pass a plain file string and
 * retry." through #93 for exactly that reason, and `FREE_EXAMPLES` still carries the trimmed text
 * as its example. This half reads the producers themselves.
 *
 * The scanned set is derived from `ERROR_REGISTRY` entries with no `remedy` field rather than from a
 * literal list, so a code that becomes remedy-free is scanned the moment it is declared: the
 * hand-maintained `REMEDY_FREE` array above already misses one (`E_UNDO_STALE`), and every further
 * remedy-free code would inherit the same drift. The `W_*` codes are deliberately outside it: they
 * carry remedies in the registry and are rendered through `WARNING_REGISTRY` for a user audience,
 * where telling the reader what to do is the point.
 */

// WHY: comment prose talks ABOUT codes and remedies. `src/mutation-engine/pipeline.ts` lists the
// WHY: remedy-free `E_UNKNOWN_ANCHOR`/`E_FOREIGN_ANCHOR` strings and, a few lines later, quotes the
// WHY: *eligible* `E_STALE_ANCHOR`'s remedy ("… Retry as it directs.") inside a WHY comment, so any
// WHY: scan reading text near a code string reports innocent comments as offenders. Extraction
// WHY: therefore requires `new DomainError("<code>"`, slices that call's argument list, and reads
// WHY: only the literal bound to `message:` — the payload the producer actually builds — with
// WHY: comments removed from the slice first, so even a commented-out payload cannot match.

/** Index just past the string or template literal that starts at `at`. */
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

/** Index just past the balanced `{…}` group that starts at `at`. */
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

/** `source` with line and block comments removed; string and template literals preserved. */
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

/** The text between the parentheses of the call whose opening `(` sits at `open`. */
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

/** The static text from `at` to its closing quote; template holes are dropped. */
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

/** The literal a `message:` property is bound to, or undefined when it is not a literal. */
function messageLiteral(payload: string): string | undefined {
  const clean = stripComments(payload);
  const match = /\bmessage\s*:\s*/.exec(clean);
  if (match === null) return undefined;
  const at = match.index + match[0].length;
  const quote = clean[at];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  return literalText(clean, at);
}

/** Every `message` literal a producer passes for one of `codes`, in source order. */
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

/** Every `.ts` file under `dir`, recursively. */
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
const REMEDY_FREE_CODES: readonly DomainErrorCode[] = (
  Object.keys(ERROR_REGISTRY) as DomainErrorCode[]
).filter((code) => ERROR_REGISTRY[code].remedy === undefined);

describe("remedy-free producers carry no imperative (#125)", () => {
  const codes = new Set<string>(REMEDY_FREE_CODES);

  it("scans the registry-derived set, including codes the hand list skips", () => {
    expect(REMEDY_FREE_CODES).toContain("E_INTERNAL_INVARIANT");
    // WHY: the code the hand-maintained list above skips — the drift this derivation removes.
    expect(REMEDY_FREE_CODES).toContain("E_UNDO_STALE");
    // WHY: warning codes carry a registry remedy and render through `WARNING_REGISTRY`, so their
    // WHY: prose is a user-facing corpus, not model-facing text: not this oracle's subject.
    expect(REMEDY_FREE_CODES).not.toContain("W_REVERSED_ANCHORS");
    expect(new Set(REMEDY_FREE_CODES).size).toBe(REMEDY_FREE_CODES.length);
  });

  it("no producer message for a remedy-free code contains an imperative", () => {
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
    // WHY: message, across 2 of the 8 remedy-free codes — `E_INTERNAL_INVARIANT` (23, where the
    // WHY: #125 tails lived) and `E_UNKNOWN` (1). The floor is deliberately below that, because a
    // WHY: legitimate removal must not fail this test, while a scan that stops reading will. The
    // WHY: other six remedy-free codes pass structured payloads and no `message`, so their text is
    // WHY: the registry `format`'s business, which the format half above already pins.
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

  it("mechanism: comment prose quoting an eligible remedy is never read as a payload", () => {
    // WHY: the `pipeline.ts` shape verbatim — remedy-free code strings in a Set literal, then a WHY
    // WHY: comment quoting the eligible `E_STALE_ANCHOR`'s remedy, then one real payload. The naive
    // WHY: window is asserted as a control so this test shows the false positive it avoids.
    const source = [
      "const codes: readonly string[] = [",
      '  "E_UNKNOWN_ANCHOR",',
      '  "E_FOREIGN_ANCHOR",',
      "];",
      "// WHY: never rewritten as E_STALE_ANCHOR with its",
      '// WHY: "The latest known status is in this rejection. Retry as it directs."',
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
