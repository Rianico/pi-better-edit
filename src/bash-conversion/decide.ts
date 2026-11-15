/**
 * Bash conversion as data (ADR: #151): the `classifyBash` guard chain, transcribed rule by rule into
 * one ordered table. WHY a table: array order is precedence — a rule sits at its altitude with every
 * guard it can shadow visible above it, the cost the inline chain paid (the #135 gate turned on
 * shadowing); each entry cites the source line in pre-extraction `src/bash-classifier.ts` and the
 * ADR it implements. WHY phases: statements feed segments feed blocks, so a flat pass cannot carry
 * that state — `decide` runs pre, statement walk, chain ceiling, segment walk and conversion tail
 * in array order; `run` returns `ADVANCE` (the transcribed `continue`) or a `Decision`, `undefined`
 * from `fireRule` means no rule fired, and accumulation (glue admission, `cd` recording, block
 * recording) lives inside the entries. Scope: `Decision` mirrors the `BashClass` union (including
 * `passThrough`) rather than new block types — S1 is zero behaviour change.
 */
// Ref: docs/.archive_adrs/0033-bash-view-interception.md
// Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
// Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
// Ref: docs/.archive_adrs/0049-multi-file-bash-views.md
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
  BashMultiView,
  CompoundSegment,
  SearchFamily,
  SearchSeg,
  SearchProgram,
  Segment,
  ViewSeg,
} from "../bash-classifier.js";

/** Box for the line-number injection offsets (docs/.archive_adrs/0033-bash-view-interception.md D5): the terminal search records its program token end while the chain walk runs, so the rewriter splices without re-deriving. */
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
  | "compound-andor-operand"
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
  | Extract<BashClass, { kind: "pureMultiView" }>
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
  /** docs/.archive_adrs/0049-multi-file-bash-views.md M1: the standalone multi-file view, recorded only when the chain carries nothing else. */
  multiView: BashMultiView | undefined;
  searchSeg: SearchFamily | undefined;
  baseDir: string | undefined;
  effCwd: string | undefined;
  sawGlue: boolean;
  compoundSegs: CompoundSegment[];
  /** Relaxation A (docs/.archive_adrs/0039-compound-bash-view-interception.md D10): set by the head rule once the leading block is admitted — only inert tails may follow. */
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
 * WHY: (item 10) one application point — a search family added later cannot ship without the
 * resolution base it must carry.
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

/**
 * WHY: a multi-file view keeps the chain's single pre-view `cd` — bash resolved its operands under
 * it — so the base rides the same field.
 */
function applyMultiViewBaseDir(view: BashMultiView, baseDir: string | undefined): Decision {
  return { kind: "pureMultiView", view: baseDir === undefined ? view : { ...view, baseDir } };
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
    id: "compound-andor-operand",
    // WHY: `unbash` types AndOr.commands as Command[], but the parser puts ANY statement kind
    // WHY: there — `cd x && for …; do …; done` crashed the walk without this guard.
    why: "ADR-0033 D1 span-kind chain rule (structural: AndOr operands must be Command/Pipeline)",
    phase: "statement",
    when: (ctx) => {
      const top = statementOf(ctx).command;
      if (top.type !== "AndOr") return false;
      return (top as AndOr).commands.some(
        (node) => node.type !== "Command" && node.type !== "Pipeline",
      );
    },
    run: () => ({ kind: "passThrough", reason: "compound-andor-operand" }),
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
    // WHY: a raw tail carries no block, anchor or lease — only bytes bash already printed — and
    // WHY: tail mode keeps a lone `wc` on its exact legacy `unsafe` decline.
    why: "ADR-0039 D10 (relaxation A; inert tail accumulation)",
    phase: "segment",
    when: (ctx) => ctx.tailMode && isInertTailNode(segmentOf(ctx).node),
    run: pushRawTail,
  },
  {
    id: "inert-count-tail",
    // WHY: D4 admits a count tail only after the LAST verified block — two blocks recorded, every
    // WHY: remaining segment a count tail — so no block follows and none competes for attribution; D10's
    // WHY: second-block guard stays closed because this rule never admits a block.
    why: "ADR-0048 D4 (inert count tail after the last verified block)",
    phase: "segment",
    when: (ctx) => {
      if (!ctx.hasGlue || admittedBlockCount(ctx) < 2) return false;
      return ctx.segments
        .slice(ctx.segIndex)
        .every((segment) => isInertCountTailNode(segment.node));
    },
    run: pushRawTail,
  },

  {
    id: "unsafe",
    // WHY: (F2) with no block there is nothing to locate, so the segment keeps its own decline and its byte-identical reason.
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
    // WHY: an inert `cd` must not consume the single-`cd` budget, which belongs to the move that sets the base.
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
    // WHY: the base attaches to the blocks recorded after it, so a `cd` behind an admitted block
    // WHY: would misresolve that block — fail closed.
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
    // WHY: bash resolves each `cd` against the directory in effect at that point, so only one
    // WHY: pre-view `cd` applied to `ctx.cwd` is sound; one issued later is too late and fails closed.
    why: "ADR-0033 D1 (source src/bash-classifier.ts:1186 pre-extraction)",
    phase: "segment",
    when: (ctx) => {
      const current = currentOf(ctx);
      return (
        current.kind === "silent" &&
        current.cdDir !== undefined &&
        (ctx.view !== undefined || ctx.multiView !== undefined)
      );
    },
    run: () => ({ kind: "passThrough", reason: "post-view-cd" }),
  },
  {
    id: "multi-cd",
    // WHY: chained `cd`s compose (`cd a && cd b` lands in `a/b`), so applying one of them alone would
    // WHY: lease a path never viewed.
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
    // WHY: relaxation A exists for the shape the prefix declines would reject — one leading block
    // WHY: with an inert tail. Only that head is exempt; anything else falls through to the original
    // WHY: guards, and a glued chain keeps its legacy reasons.
    why: "ADR-0039 D10 (relaxation A; single leading block with inert tail)",
    phase: "segment",
    when: (ctx) => {
      if (ctx.segIndex !== 0 || ctx.hasGlue) return false;
      if (ctx.view !== undefined || ctx.searchSeg !== undefined) return false;
      const current = currentOf(ctx);
      if (current.kind === "multiView") return false;
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
    // WHY: a view or a search may ride only the terminal statement — a prefix one means a compound
    // WHY: chain the model did not ask about.
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
      // WHY: the multi-file view records into its own slot, never `compoundSegs` — it rides in no
      // WHY: compound envelope.
      if (current.kind === "multiView") {
        ctx.multiView = current.view;
        return ADVANCE;
      }
      if (!isViewTerminal(current) || current.kind !== "view") {
        throw new Error("[151] unreachable: non-view reached the view arm");
      }
      recordViewBlock(ctx, current);
      return ADVANCE;
    },
  },
  {
    id: "multi-view-chain",
    // WHY: the multi-file shape is STANDALONE: glue, a second block or an inert tail proves more
    // WHY: stream than the N pages this seam attributes, so the whole command passes through as
    // WHY: `multi-view` — the existing reason, not a new one.
    why: "ADR-0049 M1 (standalone only; a chained multi-file view has no admitted envelope)",
    phase: "post",
    when: (ctx) => ctx.multiView !== undefined && (ctx.sawGlue || ctx.compoundSegs.length > 0),
    run: () => ({ kind: "passThrough", reason: "multi-view" }),
  },
  {
    id: "multi-view",
    why: "ADR-0049 M1/M2 (single-base application for the standalone multi-file view)",
    phase: "post",
    when: (ctx) => ctx.multiView !== undefined,
    run: (ctx) => {
      if (ctx.multiView === undefined) throw new Error("[151] unreachable: multi view vanished");
      return applyMultiViewBaseDir(ctx.multiView, ctx.baseDir);
    },
  },

  {
    id: "display-compound",
    why: "ADR-0048 D2 (display tails are standalone; a compound envelope has no transform attribution)",
    phase: "post",
    when: (ctx) => ctx.view?.display !== undefined && (ctx.sawGlue || ctx.tailMode),
    run: () => ({ kind: "passThrough", reason: "unsupported-pipeline" }),
  },

  {
    id: "compound",
    // WHY: (F2-as-restated) glue alone admits nothing — with zero admitted BLOCKS the compound
    // WHY: declines even when glue parsed. With a block, the admitted segments form the envelope.
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
    // WHY: relaxation A's envelope is the leading block plus its raw tail, and it spreads no
    // WHY: `baseDir`: the head fires at segment zero, before any `cd` can record.
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
                ...(view.display === undefined ? {} : { display: view.display }),
              }
            : {
                filePath: view.filePath,
                baseDir: ctx.baseDir,
                ops: view.ops,
                ...(view.lineNumbered === true ? { lineNumbered: true } : {}),
                ...(view.display === undefined ? {} : { display: view.display }),
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
 * WHY: the line-number injection needs the search program token's source offset.
 * Shared by the plain and relaxation-A recording paths so both splices see one offset.
 */
function recordSearchBlock(ctx: RuleContext, current: SearchSeg): void {
  ctx.searchSeg = current.family;
  ctx.compoundSegs.push(current);
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

/**
 * WHY: the count-tail closed set is narrower than D10's inert set — `wc -l`/`-c` only, so `-w`/`-m`
 * stay out on this seam, and every other exclusion (stdin, `--` escapes, dash-led operands,
 * redirects, prefixes) is `parseInertTail`'s. Declining is fail-closed: widen this set here, not
 * with a new rule.
 */
function isInertCountTailNode(node: Command | Pipeline): boolean {
  if (node.type !== "Command") return false;
  const tail = parseInertTail(node);
  if (tail === undefined) return false;
  const flags = tail.args.filter((arg) => arg.startsWith("-"));
  return flags.length > 0 && flags.every((flag) => /^-[lc]+$/.test(flag));
}

/** Blocks recorded so far — the D4 tail is admitted only after a second one. */
function admittedBlockCount(ctx: RuleContext): number {
  return ctx.compoundSegs.filter((segment) => segment.kind === "view" || segment.kind === "search")
    .length;
}

/**
 * WHY: both inert-tail rules accumulate identically — the tail's own source bytes become a `raw`
 * segment, which the peel passes through as already-observed output (never a block, anchor, or lease).
 */
function pushRawTail(ctx: RuleContext): typeof ADVANCE {
  const { node } = segmentOf(ctx);
  ctx.compoundSegs.push({ kind: "raw", command: ctx.command.slice(node.pos, node.end) });
  return ADVANCE;
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
    multiView: undefined,
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
    // WHY: no unpushable statement can reach this push — the statement guards above declined every
    // WHY: other kind, so a fallback arm would be dead code.
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
  // WHY: the relaxations apply only when glue is present anywhere in the chain, so the walk reads one
  // WHY: boolean instead of re-deciding it per segment.
  ctx.hasGlue = ctx.segments.some(
    (segment) => segment.node.type === "Command" && parseGlueSegment(segment.node) !== undefined,
  );
  for (let index = 0; index < ctx.segments.length; index++) {
    ctx.segIndex = index;
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
