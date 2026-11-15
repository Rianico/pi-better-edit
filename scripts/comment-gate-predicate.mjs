/**
 * Settled comment grammar, in one module, for every consumer.
 *
 * The gate (`scripts/oxlint-plugin-comment-gate.js`) and the baseline generator
 * (`scripts/comment-gate-baseline.mjs`) must agree on what a violation is, or the
 * suppression file and the rule that reads it are two sources of truth. Both import
 * this module: the plugin adapts oxlint's `sourceCode` into `AstFacts`, the generator
 * adapts `@babel/parser` into the same shape, and the classification below is shared.
 *
 * Provenance: docs/agents/verification-standards.md (the gate's enforcement site).
 * The governance record is pending (Stage 6); this header cites no ADR number because
 * no record for this grammar exists yet.
 *
 * Baseline key (canonical, `baselineKey`): `(path, text, occurrence)` where `path` is
 * repo-relative POSIX, `text` is the comment's raw `value` with no normalization, and
 * `occurrence` is the 0-based index of that exact text among the file's *violations*,
 * in source order. Counting violations rather than all comments keeps a key stable when
 * an allowed duplicate with the same text appears beside a rejected one.
 */

/** Tags that make a `//` or `/* *\/` comment carry a reason instead of prose. */
export const ALLOWLIST_RE =
  /WHY:|SAFETY:|Invariant:|See ADR-|via https:\/\/|TODO\(#\d+\):|HACK:|Ref: docs\/[\w./-]+/;

/** Gherkin steps: Title Case keyword plus a mandatory trailing space. Case-sensitive. */
export const GHERKIN_STEP_RE = /^(Given|When|Then|And|But) /;

/** Gherkin headings: Title Case keyword plus a colon. `Background`/`Scenario Outline` are out. */
export const GHERKIN_HEADING_RE = /^(Feature|Scenario):/;

/** A `/** *\/` block longer than this many lines must become an ADR plus one `// Ref:` line. */
export const MAX_BLOCK_LINES = 12;

/**
 * Function node types that own a body, spelled for BOTH parsers. oxlint spells a class or object
 * method as `MethodDefinition` holding a `FunctionExpression`; Babel spells them `ClassMethod` and
 * `ObjectMethod`. The union is required: the plugin never emits the last two, but the generator's
 * parser would miss a docblock inside a method body without them, and the arch suite's parity
 * corpus caught exactly that divergence before this comment existed.
 */
export const FUNCTION_KINDS = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "ObjectMethod",
];
/**
 * The only node kinds a `// SAFETY:` run may guard. There is deliberately no
 * callee-name arm: no live site needs one, and a name list would be guessed from
 * comment text rather than derived from the AST.
 */
export const GUARD_KINDS = ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression"];

/** Repo-relative location of the suppression file. */
export const BASELINE_PATH = "test/arch/comment-gate-baseline.json";

/** The command that regenerates the suppression file. Named in the missing-baseline error. */
export const BASELINE_COMMAND = "node scripts/comment-gate-baseline.mjs --update";

/** Violation keys. The plugin maps each to a message; the generator writes them as data. */
export const RULE = {
  prose: "prose",
  bodyDoc: "bodyDoc",
  blockCap: "blockCap",
  safetyPosition: "safetyPosition",
};

/**
 * A `/** *\/` block: oxlint reports `type: "Block"` and the value keeps the second star,
 * so every JSDoc value starts with `*`.
 * @param {{ type: string, value: string }} comment
 */
export function isJSDoc(comment) {
  return comment.type === "Block" && comment.value.startsWith("*");
}

/**
 * Tag, reference or Gherkin? The value is trimmed at the start only: every `//` comment
 * value begins with the space after the slashes, and Gherkin's mandatory trailing space
 * is the point being enforced.
 * @param {string} rawValue
 */
export function isAllowedText(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === "") return true;
  if (ALLOWLIST_RE.test(rawValue)) return true;
  const unindented = trimmed.trimStart();
  return GHERKIN_STEP_RE.test(unindented) || GHERKIN_HEADING_RE.test(unindented);
}

/** @param {{ type: string, value: string }} comment */
function isSafetyLine(comment) {
  return comment.type === "Line" && /SAFETY:/.test(comment.value);
}

/**
 * The first non-blank source line strictly after `line`, or `null` at end of file.
 * @param {ReadonlyArray<string>} sourceLines 1-indexed by `line - 1`
 * @param {number} line
 */
export function nextNonBlankLine(sourceLines, line) {
  for (let candidate = line + 1; candidate <= sourceLines.length; candidate += 1) {
    const text = sourceLines[candidate - 1] ?? "";
    if (text.trim() !== "") return candidate;
  }
  return null;
}

/**
 * The last line of the `// SAFETY:` run that starts at or contains `line`.
 * @param {ReadonlySet<number>} safetyLines
 * @param {number} line
 */
function safetyRunEnd(safetyLines, line) {
  let end = line;
  while (safetyLines.has(end + 1)) end += 1;
  return end;
}

/** @param {readonly [number, number]} body @param {{ loc: { start: { line: number }, end: { line: number } } }} comment */
function overlapsBody(body, comment) {
  return comment.loc.start.line <= body[1] && comment.loc.end.line >= body[0];
}

/**
 * Classify one comment.
 *
 * @param {GateComment} comment
 * @param {AstFacts} facts
 * @param {ReadonlySet<number>} safetyLines lines holding a `// SAFETY:` comment
 * @returns {{ rule: string, data?: Record<string, string | number> } | null} null when allowed
 */
export function classifyComment(comment, facts, safetyLines) {
  if (isJSDoc(comment)) {
    const body = facts.functionBodies.find((range) => overlapsBody(range, comment));
    if (body !== undefined) return { rule: RULE.bodyDoc, data: { line: body[0] } };
    const lines = comment.loc.end.line - comment.loc.start.line + 1;
    if (lines > MAX_BLOCK_LINES) {
      return { rule: RULE.blockCap, data: { lines, max: MAX_BLOCK_LINES } };
    }
    return null;
  }

  if (!isAllowedText(comment.value)) return { rule: RULE.prose };

  if (isSafetyLine(comment)) {
    const runEnd = safetyRunEnd(safetyLines, comment.loc.start.line);
    const guarded = nextNonBlankLine(facts.sourceLines, runEnd);
    if (guarded === null || !facts.guardLines.includes(guarded)) {
      return {
        rule: RULE.safetyPosition,
        data: { line: guarded === null ? "end of file" : guarded },
      };
    }
  }

  return null;
}

/**
 * Every violation in one file, in source order, each carrying its canonical baseline
 * occurrence index. `text` and `path` stay on the record so a caller can key it without
 * re-deriving the counting rule.
 *
 * @param {ReadonlyArray<GateComment>} comments
 * @param {AstFacts} facts
 * @returns {Array<{ comment: GateComment, rule: string, data: Record<string, string | number>, text: string, occurrence: number }>}
 */
export function collectViolations(comments, facts) {
  const safetyLines = new Set(
    comments.filter(isSafetyLine).map((comment) => comment.loc.start.line),
  );
  const occurrences = new Map();
  const violations = [];
  for (const comment of comments) {
    const verdict = classifyComment(comment, facts, safetyLines);
    if (verdict === null) continue;
    const text = comment.value;
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    violations.push({ comment, rule: verdict.rule, data: verdict.data ?? {}, text, occurrence });
  }
  return violations;
}

/**
 * The canonical suppression key. `\u0000` cannot appear in a comment value or a path,
 * so the join is unambiguous.
 * @param {string} path repo-relative POSIX path
 * @param {string} text raw comment `value`
 * @param {number} occurrence
 */
export function baselineKey(path, text, occurrence) {
  return `${path}\u0000${text}\u0000${occurrence}`;
}

/**
 * Parse a suppression file into its validated entries. The generator needs the entries (to diff
 * and rewrite them); the plugin needs only the keys, and `parseBaseline` derives those from here
 * so both consumers accept exactly the same bytes.
 *
 * @param {string} raw file contents
 * @returns {{ ok: true, entries: BaselineEntry[] } | { ok: false, reason: string }}
 */
export function parseBaselineEntries(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not valid JSON (${/** @type {Error} */ (error).message})` };
  }
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'no "entries" array' };
  }
  for (const entry of entries) {
    const { path, text, occurrence } = entry ?? {};
    if (typeof path !== "string" || typeof text !== "string" || typeof occurrence !== "number") {
      return {
        ok: false,
        reason: "an entry is missing a string path/text or a numeric occurrence",
      };
    }
  }
  return { ok: true, entries };
}

/**
 * Parse a suppression file into its key set.
 *
 * @param {string} raw file contents
 * @returns {{ ok: true, keys: Set<string> } | { ok: false, reason: string }}
 */
export function parseBaseline(raw) {
  const parsed = parseBaselineEntries(raw);
  if (!parsed.ok) return parsed;
  const keys = new Set();
  for (const { path, text, occurrence } of parsed.entries) {
    keys.add(baselineKey(path, text, occurrence));
  }
  return { ok: true, keys };
}

/**
 * @typedef {{ type: string, value: string, loc: { start: { line: number, column?: number }, end: { line: number, column?: number } } }} GateComment
 * @typedef {{ functionBodies: ReadonlyArray<readonly [number, number]>, guardLines: ReadonlyArray<number>, sourceLines: ReadonlyArray<string> }} AstFacts
 * @typedef {{ path: string, text: string, occurrence: number }} BaselineEntry
 */
