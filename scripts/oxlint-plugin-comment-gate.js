/**
 * `harness/no-comments` — the settled comment grammar, as a deterministic CI gate.
 *
 * Grammar and baseline keying live in `scripts/comment-gate-predicate.mjs`, shared with the
 * baseline generator so the rule and its suppression file cannot drift.
 *
 * Allowed: WHY:, SAFETY:, Invariant:, See ADR-, via https://, TODO(#<issue>):, HACK:,
 * `Ref: docs/<repo-path>`, strict Gherkin (Given|When|Then|And|But + space, Feature:|Scenario:),
 * and `/** *\/` documentation at module scope within 12 lines.
 * Rejected: prose, an in-body `/** *\/`, an over-cap block, and a `SAFETY:` run that does not
 * guard a cast or non-null assertion.
 *
 * Provenance: docs/agents/verification-standards.md. ADR pending (Stage 6) — no record for this
 * grammar exists yet, so no ADR number is cited here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_COMMAND,
  BASELINE_PATH,
  FUNCTION_KINDS,
  GUARD_KINDS,
  RULE,
  baselineKey,
  collectViolations,
  parseBaseline,
} from "./comment-gate-predicate.mjs";

const MESSAGES = {
  [RULE.prose]:
    "Comment carries no allowlisted tag. Prefix it with WHY:, SAFETY:, Invariant:, See ADR-, via https://, TODO(#<issue>):, HACK: or Ref: docs/<repo-path>; a Gherkin step is Given /When /Then /And /But (capitalized, trailing space) or a Feature:/Scenario: heading. Prefer deleting the comment until the code explains itself.",
  [RULE.bodyDoc]:
    "`/** */` block sits inside a function body (the body starts at line {{line}}). Documentation belongs at module scope, on the declaration it describes: rename or extract until the code explains itself, and put the reason in a `//` tag comment.",
  [RULE.blockCap]:
    "`/** */` block spans {{lines}} lines, over the {{max}}-line cap. Move the rationale into an ADR under docs/adr/ and cite it on one line: `// Ref: docs/adr/<NNNN>-<slug>.md`.",
  [RULE.safetyPosition]:
    "`SAFETY:` guards nothing: the next non-blank line ({{line}}) is not a TSAsExpression, TSTypeAssertion or TSNonNullExpression. Move the comment directly above the cast or non-null assertion it justifies, or use `WHY:` when it explains a reason instead of an unchecked byte-level claim.",
  baselineMissing:
    "Comment gate baseline is {{reason}} at {{path}}, so no violation can be classified. Regenerate it with: {{command}}",
};

/** Walk up from the plugin file to the package root, so the baseline path is cwd-independent. */
function findRepoRoot(startDirectory) {
  let directory = startDirectory;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return startDirectory;
    directory = parent;
  }
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** Loaded once per process: the suppression file is one small read, not one per linted file. */
let baselineLoad;

function loadBaseline() {
  if (baselineLoad !== undefined) return baselineLoad;
  const absolute = join(REPO_ROOT, BASELINE_PATH);
  let raw;
  try {
    raw = readFileSync(absolute, "utf-8");
  } catch {
    baselineLoad = { ok: false, reason: "unreadable" };
    return baselineLoad;
  }
  baselineLoad = parseBaseline(raw);
  return baselineLoad;
}

/** Reporter for the one baseline error: once per process, never once per file. */
let baselineErrorReported = false;

/** @param {string} filename */
function relativePath(filename) {
  return relative(REPO_ROOT, filename).split(sep).join("/");
}

/** @param {any} sourceCode */
function sourceLinesOf(sourceCode) {
  if (typeof sourceCode.getLines === "function") return sourceCode.getLines();
  const text = typeof sourceCode.text === "string" ? sourceCode.text : "";
  return text.split(/\r\n|[\r\n\u2028\u2029]/u);
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "enforce the settled comment grammar (docs/agents/verification-standards.md)",
      url: "https://github.com/Rianico/pi-better-edit/blob/main/scripts/oxlint-plugin-comment-gate.js",
    },
    schema: [],
    messages: MESSAGES,
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode?.();
    const filename = context.filename ?? context.physicalFilename ?? context.getFilename?.() ?? "";
    const functionBodies = [];
    const guardLines = [];

    const visitors = {
      "Program:exit"() {
        const allComments =
          typeof sourceCode.getAllComments === "function" ? sourceCode.getAllComments() : [];
        const facts = { functionBodies, guardLines, sourceLines: sourceLinesOf(sourceCode) };
        const violations = collectViolations(allComments, facts);

        const baseline = loadBaseline();
        if (!baseline.ok) {
          if (baselineErrorReported) return;
          baselineErrorReported = true;
          context.report({
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            messageId: "baselineMissing",
            data: {
              reason: baseline.reason,
              path: BASELINE_PATH,
              command: BASELINE_COMMAND,
            },
          });
          return;
        }

        const path = relativePath(filename);
        for (const violation of violations) {
          const key = baselineKey(path, violation.text, violation.occurrence);
          if (baseline.keys.has(key)) continue;
          context.report({
            loc: violation.comment.loc,
            messageId: violation.rule,
            data: violation.data,
          });
        }
      },
    };

    for (const kind of FUNCTION_KINDS) {
      visitors[kind] = (node) => {
        const body = node.body;
        if (body?.type === "BlockStatement" && body.loc) {
          functionBodies.push([body.loc.start.line, body.loc.end.line]);
        }
      };
    }
    for (const kind of GUARD_KINDS) {
      visitors[kind] = (node) => {
        if (node.loc) guardLines.push(node.loc.start.line);
      };
    }

    return visitors;
  },
};

const plugin = {
  meta: { name: "harness" },
  rules: { "no-comments": rule },
};

export default plugin;
