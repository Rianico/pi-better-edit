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
  | "E_NOOP_LOOP";

const REMEDY_FREE: RemedyFreeCode[] = [
  "E_UNKNOWN",
  "E_UNKNOWN_ANCHOR",
  "E_FOREIGN_ANCHOR",
  "E_UNVERIFIED_RANGE",
  "E_STALE_RANGE",
  "E_NOOP_LOOP",
];

const FREE_EXAMPLES: { [K in RemedyFreeCode]: ErrorPayloadMap[K] } = {
  E_UNKNOWN: { errorName: "Error", message: "boom" },
  E_UNKNOWN_ANCHOR: { path: "a.py", anchors: ["ZZZ"] },
  E_FOREIGN_ANCHOR: { path: "a.py", anchors: ["wUp"], homes: ["b.py"] },
  E_UNVERIFIED_RANGE: {
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
    cause: "retirement",
  },
  E_STALE_RANGE: {
    headline: "line 1 differs from what was served.",
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
    cause: "served-range staleness",
  },
  E_NOOP_LOOP: {
    ref: "edit[0] (probe.ts)",
    removeFrom: "abc",
    removeTo: "def",
    count: 3,
    batch: false,
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
  },
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
