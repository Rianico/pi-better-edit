/**
 * Bash conversion as data (ADR: #151): the `classifyBash` guard chain, transcribed rule by rule
 * into one ordered table instead of an inline `if` ladder.
 *
 * WHY a table: array order is precedence — a new rule is inserted at its altitude and every guard
 * it can shadow is visible above it, which is exactly what the inline chain made expensive
 * (the #135 gate and the declined compounds both turned on shadowing). Each rule cites the source
 * line it was transcribed from (pre-extraction `src/bash-classifier.ts`) and the ADR it implements.
 *
 * WHY the phases: the chain has loop-carried state (statements feed segments feed blocks), so a
 * flat pass cannot express it. `decide` runs each phase's entries in array order — pre, then one
 * statement walk (guards plus the structural segment push), then the chain ceiling, then one
 * segment walk, then the conversion tail. Inside a walk, `run` returns `ADVANCE` to move to the
 * next statement/segment (the transcribed `continue`) or a `Decision` to stop; `undefined` from
 * `fireRule` means no rule fired. Accumulation (glue admission, `cd` recording, block recording)
 * lives inside the entries because the source interleaves it with the guards.
 *
 * Scope note: `Decision` mirrors the established `BashClass` union (including the `passThrough`
 * kind spelling) rather than inventing new block types — S1 is zero behaviour change, and the
 * serve seams already switch on those kinds.
 */
import { parse } from "unbash";
import type { AndOr, Command, ParsedScript, Pipeline, Statement } from "unbash";
import {
  BASH_VIEW_MAX_CHAIN_SEGMENTS,
  classifySegment,
  isRedundantCd,
  isSemicolonStatementChain,
  parseGlueSegment,
  parseInertTail,
} from "../bash-classifier.js";
import type {
  BashClass,
  CompoundSegment,
  SearchFamily,
  SearchSeg,
  SearchProgram,
  Segment,
  ViewSeg,
} from "../bash-classifier.js";

/** Box for the line-number injection offsets (ADR-0033 D5): the terminal search records its program token end while the chain walk runs, so the rewriter splices without re-deriving. */
export interface LocatedBox {
  searchNameEnds?: Array<{ end: number; program: SearchProgram; lineNumbered: boolean }>;
}

/** Closed decline vocabulary: every user-visible reason string, byte-identical to the chain. */
export type DeclineReason =
  | "empty"
  | "parse-error"
  | "multi-statement"
  | "background"
  | "non-and-chain"
  | "compound-top"
  | "chain-too-long"
  | "compound-segment"
  | "non-literal-command"
  | `unsupported-command:${string}`
  | "unsupported-pipeline"
  | "post-block-cd"
  | "post-view-cd"
  | "multi-cd"
  | "multi-view"
  | "no-view";

/** The conversion verdict: the `BashClass` shapes with the reason vocabulary closed. */
export type Decision =
  | { kind: "passThrough"; reason: DeclineReason }
  | Extract<BashClass, { kind: "pureView" }>
  | Extract<BashClass, { kind: "pureSearch" }>
  | Extract<BashClass, { kind: "pureMultiSearch" }>
  | Extract<BashClass, { kind: "pureRecursiveSearch" }>
  | Extract<BashClass, { kind: "pureFilesList" }>
  | Extract<BashClass, { kind: "pureCompound" }>;

/** `run` returns this to stop rule evaluation for the current statement/segment and advance the walk (the transcribed `continue`). */
const ADVANCE = "advance" as const;

export type RulePhase = "pre" | "statement" | "presegment" | "segment" | "post";

export interface ConversionRule {
  /** Stable tag; the table test pins uniqueness and the documented order. */
  id: string;
  /** Authority: ADR citation where one exists, else the structural source line. */
  why: string;
  phase: RulePhase;
  when(ctx: RuleContext): boolean;
  /** A `Decision` stops the walk; `ADVANCE` moves to the next statement/segment. */
  run(ctx: RuleContext): Decision | typeof ADVANCE;
}

interface SegmentNode {
  node: Command | Pipeline;
  prefixPosition: boolean;
}

interface RuleContext {
  readonly command: string;
  parseFailed: boolean;
  script: ParsedScript | undefined;
  statements: readonly Statement[];
  segments: SegmentNode[];
  hasGlue: boolean;
  located: LocatedBox;
  stmtIndex: number;
  segIndex: number;
  /** The current segment's classification, computed once per walk step (source: one call). */
  current: Segment | undefined;
  view: ViewSeg | undefined;
  searchSeg: SearchFamily | undefined;
  baseDir: string | undefined;
  effCwd: string | undefined;
  sawGlue: boolean;
  compoundSegs: CompoundSegment[];
  /** Relaxation A (ADR-0039 D10): set by the head rule once the leading block is admitted — only inert tails may follow. */
  tailMode: boolean;
}

function statementOf(ctx: RuleContext): Statement {
  const statement = ctx.statements[ctx.stmtIndex];
  if (statement === undefined)
    throw new Error(`[151] unreachable: statement ${ctx.stmtIndex} missing`);
  return statement;
}

function segmentOf(ctx: RuleContext): SegmentNode {
  const segment = ctx.segments[ctx.segIndex];
  if (segment === undefined) throw new Error(`[151] unreachable: segment ${ctx.segIndex} missing`);
  return segment;
}

function currentOf(ctx: RuleContext): Segment {
  if (ctx.current === undefined) throw new Error("[151] unreachable: segment not classified");
  return ctx.current;
}

/** Trailing-else semantics (source: the view arm is the fallthrough past unsafe/silent/search). */
function isViewTerminal(segment: Segment): boolean {
  return segment.kind !== "unsafe" && segment.kind !== "silent" && segment.kind !== "search";
}

/**
 * WHY: (item 10) one place applies the chain's single pre-view `cd` to whichever search family
 * WHY: shape won — moved verbatim with the chain so the resolution base cannot be remembered for
 * WHY: one shape and forgotten for another.
 */
function applyBaseDir(family: SearchFamily, baseDir: string | undefined): Decision {
  if (baseDir === undefined) return family;
  switch (family.kind) {
    case "pureSearch":
      return { kind: "pureSearch", search: { ...family.search, baseDir } };
    case "pureMultiSearch":
      return { kind: "pureMultiSearch", search: { ...family.search, baseDir } };
    case "pureRecursiveSearch":
      return { kind: "pureRecursiveSearch", search: { ...family.search, baseDir } };
    case "pureFilesList":
      return { kind: "pureFilesList", search: { ...family.search, baseDir } };
  }
}

export const RULES: readonly ConversionRule[] = [
  {
    id: "empty",
    why: "structural input guard (source src/bash-classifier.ts:1091 pre-extraction; no ADR — vacuously safe)",
    phase: "pre",
    when: (ctx) => ctx.command.trim() === "",
    run: () => ({ kind: "passThrough", reason: "empty" }),
  },
  {
    id: "parse-error",
    why: "structural input guard (source src/bash-classifier.ts:1096 throw and :1100 errors array pre-extraction; no ADR — unparseable means unprovable)",
    phase: "pre",
    when: (ctx) =>
      ctx.parseFailed || (ctx.script?.errors !== undefined && ctx.script.errors.length > 0),
    run: () => ({ kind: "passThrough", reason: "parse-error" }),
  },
  {
    id: "multi-statement",
    // WHY: D1/D9, amended 2026-10-09 (commit 7b78282): the `;`-chain gate lives here; every other
    // WHY: multi-statement script is the compound ceiling and stays pass-through (ADR-0033 D1).
    why: "ADR-0033 D1/D9 as amended (source src/bash-classifier.ts:1105-1110 pre-extraction)",
    phase: "pre",
    when: (ctx) =>
      ctx.statements.length !== 1 && !isSemicolonStatementChain(ctx.command, ctx.statements),
    run: () => ({ kind: "passThrough", reason: "multi-statement" }),
  },
  {
    id: "background",
    why: "ADR-0033 D1 (source src/bash-classifier.ts:1116 pre-extraction; a backgrounded statement is not the deterministic foreground shape)",
    phase: "statement",
    when: (ctx) => {
      const statement = statementOf(ctx);
      return statement.type !== "Statement" || statement.background === true;
    },
    run: () => ({ kind: "passThrough", reason: "background" }),
  },
  {
    id: "non-and-chain",
    why: "ADR-0033 D1 span-kind chain rule (source src/bash-classifier.ts:1125 pre-extraction; only `&&` sequences)",
    phase: "statement",
    when: (ctx) => {
      const top = statementOf(ctx).command;
      return top.type === "AndOr" && (top as AndOr).operators.some((op) => op !== "&&");
    },
    run: () => ({ kind: "passThrough", reason: "non-and-chain" }),
  },
  {
    id: "compound-top",
    why: "ADR-0033 D1 span-kind chain rule (source src/bash-classifier.ts:1133 pre-extraction; top must be AndOr/Command/Pipeline)",
    phase: "statement",
    when: (ctx) => {
      const type = statementOf(ctx).command.type;
      return type !== "AndOr" && type !== "Command" && type !== "Pipeline";
    },
    run: () => ({ kind: "passThrough", reason: "compound-top" }),
  },
  {
    id: "chain-too-long",
    why: "structural ceiling BASH_VIEW_MAX_CHAIN_SEGMENTS (source src/bash-classifier.ts:1137 pre-extraction; no ADR — bounded walk)",
    phase: "presegment",
    when: (ctx) => ctx.segments.length > BASH_VIEW_MAX_CHAIN_SEGMENTS,
    run: () => ({ kind: "passThrough", reason: "chain-too-long" }),
  },
  {
    id: "compound-segment",
    why: "structural type gate (source src/bash-classifier.ts:1153 pre-extraction; no ADR — defensive: the walker only pushes Command/Pipeline, so this is unreachable via parse)",
    phase: "segment",
    when: (ctx) => {
      const type = segmentOf(ctx).node.type;
      return type !== "Command" && type !== "Pipeline";
    },
    run: () => ({ kind: "passThrough", reason: "compound-segment" }),
  },
  {
    id: "admit-glue",
    // WHY: (ADR-0039 D6) static glue parses here so a compound can carry it — but only inside a
    // WHY: multi-segment chain and only beside an admitted block. Accumulation, not a verdict.
    why: "ADR-0039 D6 (source src/bash-classifier.ts:1165-1174 pre-extraction; glue admission)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      if (current.kind !== "unsafe") return false;
      const { node } = segmentOf(ctx);
      return (
        ctx.segments.length > 1 && node.type === "Command" && parseGlueSegment(node) !== undefined
      );
    },
    run: (ctx) => {
      const { node } = segmentOf(ctx);
      const glue = node.type === "Command" ? parseGlueSegment(node) : undefined;
      if (glue === undefined) throw new Error("[151] unreachable: glue re-parse diverged");
      ctx.sawGlue = true;
      ctx.compoundSegs.push({ kind: "glue", glue });
      return ADVANCE;
    },
  },
  {
    id: "inert-tail",
    // WHY: (ADR-0039 D10) an inert tail command contributes only its already-observed bytes —
    // WHY: no block, no anchors, no leases. It fires only inside tail mode (set by the head
    // WHY: rule), so a lone `wc` still declines via `unsafe` with its exact legacy reason.
    why: "ADR-0039 D10 (relaxation A; inert tail accumulation)",
    phase: "segment",
    when: (ctx) => ctx.tailMode && isInertTailNode(segmentOf(ctx).node),
    run: (ctx) => {
      const { node } = segmentOf(ctx);
      ctx.compoundSegs.push({ kind: "raw", command: ctx.command.slice(node.pos, node.end) });
      return ADVANCE;
    },
  },

  {
    id: "unsafe",
    // WHY: (ADR-0039 D6) a lone print keeps its own decline (F2: glue locates blocks; with no block
    // WHY: there is nothing to locate). The reason string flows through byte-identically.
    why: "ADR-0039 D6/F2 (source src/bash-classifier.ts:1162 pre-extraction; dynamic segment reason)",
    phase: "segment",
    when: (ctx) => currentOf(ctx).kind === "unsafe",
    run: (ctx) => {
      const current = currentOf(ctx);
      if (current.kind !== "unsafe") throw new Error("[151] unreachable: kind changed");
      return { kind: "passThrough", reason: current.reason as DeclineReason };
    },
  },
  {
    id: "skip-redundant-cd",
    // WHY: (ADR-0039 D7/D9) a redundant `cd` is inert — skipped, never counted toward the single
    // WHY: `cd` limit. Only base-independent dot forms and exact known-absolute repeats qualify.
    why: "ADR-0039 D7/D9 (source src/bash-classifier.ts:1173 pre-extraction; redundancy skip)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return (
        current.kind === "silent" &&
        current.cdDir !== undefined &&
        isRedundantCd(current.cdDir, ctx.effCwd)
      );
    },
    run: () => ADVANCE,
  },
  {
    id: "post-block-cd",
    // WHY: (commit 4) a non-redundant `cd` after an admitted block would misresolve that block
    // WHY: (`baseDir` attaches to later blocks only) — fail closed. Gated on glue presence so
    // WHY: single-block chains keep their exact current reasons.
    why: "commit 4 post-block gate (source src/bash-classifier.ts:1184 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return (
        current.kind === "silent" &&
        current.cdDir !== undefined &&
        ctx.hasGlue &&
        (ctx.view !== undefined || ctx.searchSeg !== undefined)
      );
    },
    run: () => ({ kind: "passThrough", reason: "post-block-cd" }),
  },
  {
    id: "post-view-cd",
    // WHY: bash resolves each `cd` against the directory in effect at that point, so only a single
    // WHY: pre-view `cd` applied to `ctx.cwd` is sound (ADR-0033 D1). A `cd` after the view ran too
    // WHY: late to affect it and fails closed.
    why: "ADR-0033 D1 (source src/bash-classifier.ts:1186 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return current.kind === "silent" && current.cdDir !== undefined && ctx.view !== undefined;
    },
    run: () => ({ kind: "passThrough", reason: "post-view-cd" }),
  },
  {
    id: "multi-cd",
    // WHY: chained `cd`s compose (`cd a && cd b` lands in `a/b`, not `b`) — applying only one out
    // WHY: of order would lease a path never viewed (ADR-0033 D1).
    why: "ADR-0033 D1 (source src/bash-classifier.ts:1187 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return current.kind === "silent" && current.cdDir !== undefined && ctx.baseDir !== undefined;
    },
    run: () => ({ kind: "passThrough", reason: "multi-cd" }),
  },
  {
    id: "record-cd",
    why: "ADR-0033 D1 single pre-view `cd` (source src/bash-classifier.ts:1188-1191 pre-extraction; accumulation: the resolution base for the winning shape)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return current.kind === "silent" && current.cdDir !== undefined;
    },
    run: (ctx) => {
      const current = currentOf(ctx);
      const dir = current.kind === "silent" ? current.cdDir : undefined;
      if (dir === undefined) throw new Error("[151] unreachable: cd vanished");
      ctx.baseDir = dir;
      if (dir.startsWith("/")) ctx.effCwd = dir;
      return ADVANCE;
    },
  },
  {
    id: "silent-skip",
    why: "structural (source src/bash-classifier.ts:1192 pre-extraction; `:`/`true`/prefix `pwd` carry no geometry — absorbed)",
    phase: "segment",
    when: (ctx) => currentOf(ctx).kind === "silent",
    run: () => ADVANCE,
  },
  {
    id: "inert-tail-head",
    // WHY: (ADR-0039 D10) relaxation A admits a compound with NO glue iff exactly one block
    // WHY: exists, it is the first segment, and every later segment is inert (checked by
    // WHY: classifying the remainder up front — pure functions, no walk state touched). It
    // WHY: preempts the prefix/second declines for that head only; anything else in the tail
    // WHY: falls through to the original guards with their original reasons. Glued chains
    // WHY: keep their exact legacy behavior (`!ctx.hasGlue`).
    why: "ADR-0039 D10 (relaxation A; single leading block with inert tail)",
    phase: "segment",
    when: (ctx) => {
      if (ctx.segIndex !== 0 || ctx.hasGlue) return false;
      if (ctx.view !== undefined || ctx.searchSeg !== undefined) return false;
      const current = currentOf(ctx);
      if (current.kind !== "search" && !isViewTerminal(current)) return false;
      const tail = ctx.segments.slice(1);
      return tail.length > 0 && tail.every((segment) => isInertTailNode(segment.node));
    },
    run: (ctx) => {
      const current = currentOf(ctx);
      if (current.kind === "search") recordSearchBlock(ctx, current);
      else if (current.kind === "view") recordViewBlock(ctx, current);
      else throw new Error("[152] unreachable: head is not a block");
      ctx.tailMode = true;
      return ADVANCE;
    },
  },

  {
    id: "search-prefix",
    // WHY: the search obeys the view's chain rule verbatim (ADR-0033 D1 as amended): only the
    // WHY: terminal statement may carry it — a prefix `grep` would be a compound chain the model
    // WHY: did not ask about, so it fails closed.
    why: "ADR-0033 D1 as amended (source src/bash-classifier.ts:1197 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return current.kind === "search" && segmentOf(ctx).prefixPosition && !ctx.hasGlue;
    },
    run: () => ({ kind: "passThrough", reason: "multi-statement" }),
  },
  {
    id: "search-second",
    why: "ADR-0033 D1 one view-or-search per command (source src/bash-classifier.ts:1198 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return (
        current.kind === "search" &&
        (ctx.view !== undefined || ctx.searchSeg !== undefined) &&
        !ctx.hasGlue
      );
    },
    run: () => ({ kind: "passThrough", reason: "multi-view" }),
  },
  {
    id: "record-search",
    why: "structural accumulation (source src/bash-classifier.ts:1201-1216 pre-extraction; records the family, the compound slot, and the line-number injection offsets)",
    phase: "segment",
    when: (ctx) => currentOf(ctx).kind === "search",
    run: (ctx) => {
      const current = currentOf(ctx);
      if (current.kind !== "search") throw new Error("[151] unreachable: kind changed");
      recordSearchBlock(ctx, current);
      return ADVANCE;
    },
  },
  {
    id: "view-prefix",
    // WHY: only the terminal statement may carry the view (ADR-0033 D1 as amended) — a view in a
    // WHY: prefix statement means the script is a compound chain the model did not ask about.
    why: "ADR-0033 D1 as amended (source src/bash-classifier.ts:1223 pre-extraction)",
    phase: "segment",
    when: (ctx) => isViewTerminal(currentOf(ctx)) && segmentOf(ctx).prefixPosition && !ctx.hasGlue,
    run: () => ({ kind: "passThrough", reason: "multi-statement" }),
  },
  {
    id: "view-second",
    why: "ADR-0033 D1 one view-or-search per command (source src/bash-classifier.ts:1225 pre-extraction)",
    phase: "segment",
    when: (ctx) =>
      isViewTerminal(currentOf(ctx)) &&
      (ctx.view !== undefined || ctx.searchSeg !== undefined) &&
      !ctx.hasGlue,
    run: () => ({ kind: "passThrough", reason: "multi-view" }),
  },
  {
    id: "record-view",
    why: "structural accumulation (source src/bash-classifier.ts:1227-1228 pre-extraction; the trailing else — every non-unsafe/silent/search segment is a view)",
    phase: "segment",
    when: () => true,
    run: (ctx) => {
      const current = currentOf(ctx);
      if (!isViewTerminal(current) || current.kind !== "view") {
        throw new Error("[151] unreachable: non-view reached the view arm");
      }
      recordViewBlock(ctx, current);
      return ADVANCE;
    },
  },
  {
    id: "compound",
    // WHY: F2-as-restated (ADR-0039): glue alone admits nothing — zero admitted BLOCKS means the
    // WHY: compound declines even if glue parsed. With a block, the admitted segments envelope.
    why: "ADR-0039 D1/D2/D4 + F2 (source src/bash-classifier.ts:1233-1239 pre-extraction)",
    phase: "post",
    when: (ctx) => ctx.sawGlue && (ctx.view !== undefined || ctx.searchSeg !== undefined),
    run: (ctx) => ({
      kind: "pureCompound",
      segments: ctx.compoundSegs,
      ...(ctx.baseDir === undefined ? {} : { baseDir: ctx.baseDir }),
    }),
  },
  {
    id: "inert-compound",
    // WHY: (ADR-0039 D10) the relaxation-A envelope: the leading block plus its raw tail.
    // WHY: No `baseDir` spread — the head fires only at segment zero, before any `cd` records.
    why: "ADR-0039 D10 (relaxation A; envelope for the leading block plus raw tail)",
    phase: "post",
    when: (ctx) => ctx.tailMode && ctx.compoundSegs.length > 0,
    run: (ctx) => ({
      kind: "pureCompound",
      segments: ctx.compoundSegs,
    }),
  },

  {
    id: "search",
    why: "item 10 single-base application (source src/bash-classifier.ts:1240 pre-extraction)",
    phase: "post",
    when: (ctx) => ctx.searchSeg !== undefined,
    run: (ctx) => {
      if (ctx.searchSeg === undefined) throw new Error("[151] unreachable: search vanished");
      return applyBaseDir(ctx.searchSeg, ctx.baseDir);
    },
  },
  {
    id: "no-view",
    why: "ADR-0039 F2-as-restated (source src/bash-classifier.ts:1241 pre-extraction; no admitted block — nothing to serve)",
    phase: "post",
    when: (ctx) => ctx.view === undefined,
    run: () => ({ kind: "passThrough", reason: "no-view" }),
  },
  {
    id: "view",
    why: "structural terminal conversion (source src/bash-classifier.ts:1243-1257 pre-extraction; the fallthrough that serves the admitted view)",
    phase: "post",
    when: () => true,
    run: (ctx) => {
      const view = ctx.view;
      if (view === undefined) throw new Error("[151] unreachable: view vanished");
      return {
        kind: "pureView",
        view:
          ctx.baseDir === undefined
            ? {
                filePath: view.filePath,
                ops: view.ops,
                ...(view.lineNumbered === true ? { lineNumbered: true } : {}),
              }
            : {
                filePath: view.filePath,
                baseDir: ctx.baseDir,
                ops: view.ops,
                ...(view.lineNumbered === true ? { lineNumbered: true } : {}),
              },
      } satisfies Extract<BashClass, { kind: "pureView" }>;
    },
  },
];

function fireRule(rule: ConversionRule, ctx: RuleContext): Decision | typeof ADVANCE | undefined {
  if (!rule.when(ctx)) return undefined;
  return rule.run(ctx);
}

/**
 * WHY: (ADR-0033 D5) the line-number injection needs the search program token's source offset.
 * Shared by the plain and relaxation-A recording paths so the splice sees identical offsets.
 */
function recordSearchBlock(ctx: RuleContext, current: SearchSeg): void {
  ctx.searchSeg = current.family;
  ctx.compoundSegs.push(current);
  // WHY: the line-number injection must splice at the search program token's source offset, and
  // WHY: that offset is only known while the chain walk runs (transcribed with the walk).
  const { node } = segmentOf(ctx);
  if (node.type === "Command" && node.name?.end !== undefined) {
    const family = current.family;
    if (
      family.kind === "pureSearch" ||
      family.kind === "pureMultiSearch" ||
      family.kind === "pureRecursiveSearch"
    ) {
      if (ctx.located.searchNameEnds === undefined) ctx.located.searchNameEnds = [];
      ctx.located.searchNameEnds.push({
        end: node.name.end,
        program: family.search.program,
        lineNumbered: family.search.lineNumbered,
      });
    }
  }
}

function recordViewBlock(ctx: RuleContext, current: ViewSeg): void {
  ctx.view = current;
  ctx.compoundSegs.push(current);
}

/** A tail command is inert when it is exactly the D10 shape: `wc` with counting flags and file operands. */
function isInertTailNode(node: Command | Pipeline): boolean {
  return node.type === "Command" && parseInertTail(node) !== undefined;
}

function failUndecided(where: string): never {
  throw new Error(`[151] unreachable: no rule fired ${where} — RULES must end in a total rule`);
}

/**
 * WHY the out-param box: callers that splice line numbers (`withSearchLineNumbers`) need the
 * terminal search's program offset, which only exists mid-walk. Same contract as the chain.
 */
export function decide(command: string, located: LocatedBox = {}): Decision {
  let script: ParsedScript | undefined;
  let parseFailed = false;
  try {
    script = parse(command);
  } catch {
    parseFailed = true;
  }
  const ctx: RuleContext = {
    command,
    parseFailed,
    script,
    statements: parseFailed || script === undefined ? [] : (script.commands as Statement[]),
    segments: [],
    hasGlue: false,
    located,
    stmtIndex: -1,
    segIndex: -1,
    current: undefined,
    view: undefined,
    searchSeg: undefined,
    baseDir: undefined,
    effCwd: undefined,
    sawGlue: false,
    compoundSegs: [],
    tailMode: false,
  };
  for (const rule of RULES) {
    if (rule.phase !== "pre") continue;
    const out = fireRule(rule, ctx);
    if (out !== undefined) {
      if (out === ADVANCE) failUndecided("in pre phase");
      return out;
    }
  }
  for (let index = 0; index < ctx.statements.length; index++) {
    ctx.stmtIndex = index;
    for (const rule of RULES) {
      if (rule.phase !== "statement") continue;
      const out = fireRule(rule, ctx);
      if (out !== undefined) {
        if (out === ADVANCE) failUndecided("in statement phase");
        return out;
      }
    }
    // WHY: structural segment push (source src/bash-classifier.ts:1112-1135 pre-extraction) —
    // WHY: the statement guards above already declined anything unpushable, so the else arm is
    // WHY: unreachable here (the `compound-top` rule fired for it).
    const statement = statementOf(ctx);
    const prefixPosition = index < ctx.statements.length - 1;
    const top = statement.command;
    if (top.type === "AndOr") {
      for (const node of (top as AndOr).commands as Array<Command | Pipeline>) {
        ctx.segments.push({ node, prefixPosition });
      }
    } else if (top.type === "Command" || top.type === "Pipeline") {
      ctx.segments.push({ node: top, prefixPosition });
    }
  }
  for (const rule of RULES) {
    if (rule.phase !== "presegment") continue;
    const out = fireRule(rule, ctx);
    if (out !== undefined) {
      if (out === ADVANCE) failUndecided("in presegment phase");
      return out;
    }
  }
  // WHY: (commit 4) compound-aware relaxations apply only when glue is present anywhere in the
  // WHY: chain; computed once up front exactly as the chain did (source :1144 pre-extraction).
  ctx.hasGlue = ctx.segments.some(
    (segment) => segment.node.type === "Command" && parseGlueSegment(segment.node) !== undefined,
  );
  for (let index = 0; index < ctx.segments.length; index++) {
    ctx.segIndex = index;
    // WHY: one classification per segment (source src/bash-classifier.ts:1155 pre-extraction).
    ctx.current = classifySegment(segmentOf(ctx).node, segmentOf(ctx).prefixPosition);
    let advanced = false;
    for (const rule of RULES) {
      if (rule.phase !== "segment") continue;
      const out = fireRule(rule, ctx);
      if (out === undefined) continue;
      if (out === ADVANCE) {
        advanced = true;
        break;
      }
      return out;
    }
    if (!advanced) failUndecided("for a walked segment");
  }
  for (const rule of RULES) {
    if (rule.phase !== "post") continue;
    const out = fireRule(rule, ctx);
    if (out !== undefined) {
      if (out === ADVANCE) failUndecided("in post phase");
      return out;
    }
  }
  return failUndecided("at the conversion tail");
}
