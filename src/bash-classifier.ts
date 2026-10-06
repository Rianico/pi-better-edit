/**
 * AST-guarded classification of bash commands into slice-accurate file views.
 *
 * WHY a pure module: the chain rule, the slice algebra, and every adversarial
 * guard (ADR-0033 D1/D2/D5) are pure AST predicates — unit-testable without
 * fixtures, stores, or the pi runtime. The lifecycle layer applies the result
 * to the disk re-read; this module never touches the filesystem.
 *
 * WHY unbash instead of regex: a regex cannot tell `cat f > g` (mutation)
 * from `cat f` (view), nor `cat $F` (expansion) from `cat f` (literal). The
 * typed AST makes every dangerous shape structural: redirects, heredocs,
 * substitutions, and expansions are nodes, so fail-closed is the absence of
 * a proof rather than the presence of a pattern.
 */
import { parse } from "unbash";
import type { AndOr, Command, ParsedScript, Pipeline, Statement, Word } from "unbash";

/** Maximum pipeline stages in one view segment (source + filters). */
export const BASH_VIEW_MAX_PIPELINE_STAGES = 4;
/** Maximum `&&` segments in one classified chain. */
export const BASH_VIEW_MAX_CHAIN_SEGMENTS = 8;

/**
 * One exact line-window filter, stream-relative and 1-indexed. Every op is
 * total over any input length: out-of-range selections yield no lines, never
 * an error, so `applySliceOps` needs no failure channel.
 */
export type SliceOp =
  | { kind: "first"; n: number }
  | { kind: "last"; n: number }
  | { kind: "dropLast"; n: number }
  | { kind: "from"; n: number }
  | { kind: "range"; from: number; to: number };

/** Ordered disjoint 1-indexed inclusive line intervals over `[1..L]`. */
export interface LineInterval {
  lo: number;
  hi: number;
}

export interface BashView {
  /** File path exactly as written (relative or absolute). */
  filePath: string;
  /** Last literal `cd` target in the chain, if any (resolution base). */
  baseDir?: string;
  /** Slice ops in stream order, folded by `applySliceOps` over the line count. */
  ops: SliceOp[];
}

export type BashClass =
  | { kind: "pureView"; view: BashView }
  | { kind: "passThrough"; reason: string };

/** `sed -n` numeric print only — locks out `w`/`e`/`r`/`s`/`;`/`{}`/`/` (R4). */
const SED_NUMERIC_PRINT = /^(\d+)(,(\d+))?p$/;
/** Bare `-N` shorthand (`head -20`), corpus-dominant per R2. */
const BARE_COUNT = /^-(\d+)$/;
/** Attached `-n` forms (`-n20`, `-n+55`, `-n-5`). */
const ATTACHED_COUNT = /^-n(\+?-?\d+)$/;
/** Unquoted glob metachars — unbash exposes globs as plain words (ADR-0033 D5). */
const UNQUOTED_GLOB = /[*?[]/;

/**
 * The statically-known value of a word, or `undefined` when the word can mean
 * anything other than its spelling at runtime: expansions, substitutions,
 * globs, brace expansion, locale/`$''` quoting, leading `~`, or emptiness.
 * Fully-quoted words keep their spelling (quoting disables every expansion).
 */
function literalValue(word: Word | undefined): string | undefined {
  if (!word) return undefined;
  // WHY: `parts` is a lazy prototype getter (R5) — read it directly once,
  // WHY: never spread or `Object.keys` the word.
  const parts = word.parts;
  if (parts === undefined) {
    if (UNQUOTED_GLOB.test(word.value)) return undefined;
    if (word.value.startsWith("~")) return undefined;
    return word.value === "" ? undefined : word.value;
  }
  if (parts.length === 0) return undefined;
  if (parts[0].type === "Literal" && word.value.startsWith("~")) return undefined;
  let out = "";
  for (const part of parts) {
    if (part.type === "Literal") {
      if (UNQUOTED_GLOB.test(part.value)) return undefined;
      out += part.value;
    } else if (part.type === "SingleQuoted") {
      out += part.value;
    } else if (part.type === "DoubleQuoted") {
      for (const child of part.parts) {
        if (child.type !== "Literal") return undefined;
        out += child.value;
      }
    } else {
      return undefined;
    }
  }
  return out === "" ? undefined : out;
}

function isWord(node: unknown): node is Word {
  return typeof node === "object" && node !== null && (node as { type?: unknown }).type === "Word";
}

interface StageShape {
  name: string;
  args: string[];
}

/** Structural shape gate: no prefix assignments, no redirects, literal name. */
function stageShape(cmd: Command): StageShape | undefined {
  if (cmd.prefix.length > 0) return undefined;
  if (cmd.redirects.length > 0) return undefined;
  const name = literalValue(cmd.name);
  if (name === undefined) return undefined;
  const args: string[] = [];
  for (const arg of cmd.args) {
    if (!isWord(arg)) return undefined;
    const value = literalValue(arg);
    if (value === undefined) return undefined;
    args.push(value);
  }
  return { name, args };
}

function positiveInt(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

interface CountSelection {
  ops: SliceOp[];
  file?: string;
}

/**
 * `head`/`tail` count selector. Bare `-N` is the corpus-dominant shorthand
 * (R2); `-n N`, `-n+N`, `-n-N`, and attached `-nN` are accepted; `-c`, `-f`,
 * `-F`, `-q`, `-v`, `-z`, long flags, `--`, and lone `-` all fail closed.
 * Flags must precede the file; at most one positional; zero counts rejected.
 */
function parseCountSelector(name: "head" | "tail", args: string[]): CountSelection | undefined {
  let selector: SliceOp | undefined;
  let file: string | undefined;
  let positionalSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-n") {
      const count = args[i + 1];
      if (count === undefined || selector !== undefined) return undefined;
      const parsed = parseSignedCount(name, count);
      if (parsed === undefined) return undefined;
      selector = parsed;
      i++;
      continue;
    }
    const attached = ATTACHED_COUNT.exec(arg);
    if (attached) {
      if (selector !== undefined) return undefined;
      const parsed = parseSignedCount(name, attached[1]);
      if (parsed === undefined) return undefined;
      selector = parsed;
      continue;
    }
    const bare = BARE_COUNT.exec(arg);
    if (bare) {
      if (selector !== undefined) return undefined;
      const n = positiveInt(bare[1]);
      if (n === undefined) return undefined;
      selector = name === "head" ? { kind: "first", n } : { kind: "last", n };
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    if (positionalSeen) return undefined;
    positionalSeen = true;
    file = arg;
  }
  if (positionalSeen && args[args.length - 1] !== file) return undefined;
  const ops: SliceOp[] = selector ? [selector] : [defaultCount(name)];
  return file === undefined ? { ops } : { ops, file };
}

/** Signed `-n` counts: plain selects, `+N` starts (tail), `-N` drops (head). */
function parseSignedCount(name: "head" | "tail", text: string): SliceOp | undefined {
  if (text.startsWith("+")) {
    if (name !== "tail") return undefined;
    const n = positiveInt(text.slice(1));
    return n === undefined ? undefined : { kind: "from", n };
  }
  if (text.startsWith("-")) {
    if (name !== "head") return undefined;
    const n = positiveInt(text.slice(1));
    return n === undefined ? undefined : { kind: "dropLast", n };
  }
  const n = positiveInt(text);
  if (n === undefined) return undefined;
  return name === "head" ? { kind: "first", n } : { kind: "last", n };
}

function defaultCount(name: "head" | "tail"): SliceOp {
  return name === "head" ? { kind: "first", n: 10 } : { kind: "last", n: 10 };
}

interface SourceStage {
  filePath: string;
  ops: SliceOp[];
}

/** Stages that consume the source file: `cat FILE`, or a file-direct filter. */
function parseSourceStage(stage: StageShape): SourceStage | undefined {
  if (stage.name === "cat") {
    if (stage.args.length !== 1 || stage.args[0].startsWith("-")) return undefined;
    return { filePath: stage.args[0], ops: [] };
  }
  if (stage.name === "head" || stage.name === "tail") {
    const selection = parseCountSelector(stage.name, stage.args);
    if (!selection || selection.file === undefined) return undefined;
    return { filePath: selection.file, ops: selection.ops };
  }
  if (stage.name === "sed") {
    const selection = parseSedArgs(stage.args);
    if (!selection || selection.file === undefined) return undefined;
    return { filePath: selection.file, ops: selection.ops };
  }
  return undefined;
}

/** Downstream pipe stages: selectors with no file operand (stdin only). */
function parseFilterStage(stage: StageShape): SliceOp[] | undefined {
  if (stage.name === "head" || stage.name === "tail") {
    const selection = parseCountSelector(stage.name, stage.args);
    if (!selection || selection.file !== undefined) return undefined;
    return selection.ops;
  }
  if (stage.name === "sed") {
    const selection = parseSedArgs(stage.args);
    if (!selection || selection.file !== undefined) return undefined;
    return selection.ops;
  }
  return undefined;
}

/** Exactly `-n PROG [FILE]` with `PROG` numeric print (R4 strict regex). */
function parseSedArgs(args: string[]): { ops: SliceOp[]; file?: string } | undefined {
  if (args.length !== 2 && args.length !== 3) return undefined;
  if (args[0] !== "-n") return undefined;
  const printed = SED_NUMERIC_PRINT.exec(args[1]);
  if (!printed) return undefined;
  const from = Number(printed[1]);
  const to = printed[3] === undefined ? from : Number(printed[3]);
  const ops: SliceOp[] = [{ kind: "range", from, to }];
  return args.length === 3 ? { ops, file: args[2] } : { ops };
}

interface SilentSeg {
  kind: "silent";
  cdDir?: string;
}

interface ViewSeg {
  kind: "view";
  filePath: string;
  ops: SliceOp[];
}

type Segment = SilentSeg | ViewSeg | { kind: "unsafe"; reason: string };

/** `cd <literal>` (never `-`), `true`, `:` — the corpus-closed silent set (R3). */
function parseSilent(stage: StageShape): SilentSeg | undefined {
  if (stage.name === "cd") {
    if (stage.args.length !== 1 || stage.args[0] === "-") return undefined;
    return { kind: "silent", cdDir: stage.args[0] };
  }
  if ((stage.name === "true" || stage.name === ":") && stage.args.length === 0) {
    return { kind: "silent" };
  }
  return undefined;
}

function parseViewSegment(node: Command | Pipeline): ViewSeg | undefined {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return undefined;
    const source = parseSourceStage(stage);
    if (!source) return undefined;
    return { kind: "view", filePath: source.filePath, ops: source.ops };
  }
  if (node.operators.some((op) => op !== "|")) return undefined;
  if (node.commands.length < 2 || node.commands.length > BASH_VIEW_MAX_PIPELINE_STAGES) {
    return undefined;
  }
  const ops: SliceOp[] = [];
  let filePath: string | undefined;
  for (let index = 0; index < node.commands.length; index++) {
    const child = node.commands[index];
    // WHY: every stage must prove itself — a skipped failure here would serve
    // WHY: leases for lines the model never saw (e.g. a `grep` stage silently
    // WHY: dropped would misattribute filtered output to a head slice).
    if (child === undefined || child.type !== "Command") return undefined;
    const stage = stageShape(child);
    if (!stage) return undefined;
    if (index === 0) {
      const source = parseSourceStage(stage);
      if (!source) return undefined;
      filePath = source.filePath;
      ops.push(...source.ops);
      continue;
    }
    const filter = parseFilterStage(stage);
    if (!filter) return undefined;
    ops.push(...filter);
  }
  if (filePath === undefined || ops.length === 0) return undefined;
  return { kind: "view", filePath, ops };
}

function classifySegment(node: Command | Pipeline): Segment {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return { kind: "unsafe", reason: "non-literal-command" };
    const silent = parseSilent(stage);
    if (silent) return silent;
    const source = parseSourceStage(stage);
    if (source) return { kind: "view", filePath: source.filePath, ops: source.ops };
    return { kind: "unsafe", reason: `unsupported-command:${stage.name}` };
  }
  const view = parseViewSegment(node);
  if (view) return view;
  return { kind: "unsafe", reason: "unsupported-pipeline" };
}

/**
 * Span-kind chain rule (ADR-0033 D1): `&&`-only top level, exactly one `view`,
 * all others `silent`, undetermined is `unsafe`. Returns the view with its
 * resolution base (last literal `cd`, if any).
 */
export function classifyBashCommand(command: string): BashClass {
  if (command.trim() === "") return { kind: "passThrough", reason: "empty" };
  let script;
  try {
    script = parse(command);
  } catch {
    return { kind: "passThrough", reason: "parse-error" };
  }
  const parsed: ParsedScript = script;
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    return { kind: "passThrough", reason: "parse-error" };
  }
  if (parsed.commands.length !== 1) {
    return { kind: "passThrough", reason: "multi-statement" };
  }
  const statement = parsed.commands[0] as Statement;
  if (statement.type !== "Statement" || statement.background) {
    return { kind: "passThrough", reason: "background" };
  }
  const top = statement.command;
  let segments: Array<Command | Pipeline>;
  if (top.type === "AndOr") {
    const chain = top as AndOr;
    if (chain.operators.some((op) => op !== "&&")) {
      return { kind: "passThrough", reason: "non-and-chain" };
    }
    segments = chain.commands as Array<Command | Pipeline>;
  } else if (top.type === "Command" || top.type === "Pipeline") {
    segments = [top];
  } else {
    return { kind: "passThrough", reason: "compound-top" };
  }
  if (segments.length > BASH_VIEW_MAX_CHAIN_SEGMENTS) {
    return { kind: "passThrough", reason: "chain-too-long" };
  }
  let view: ViewSeg | undefined;
  let baseDir: string | undefined;
  for (const segment of segments) {
    if (segment.type !== "Command" && segment.type !== "Pipeline") {
      return { kind: "passThrough", reason: "compound-segment" };
    }
    const classified = classifySegment(segment);
    if (classified.kind === "unsafe") {
      return { kind: "passThrough", reason: classified.reason };
    }
    if (classified.kind === "silent") {
      if (classified.cdDir !== undefined) baseDir = classified.cdDir;
      continue;
    }
    if (view !== undefined) {
      return { kind: "passThrough", reason: "multi-view" };
    }
    view = classified;
  }
  if (!view) return { kind: "passThrough", reason: "no-view" };
  return {
    kind: "pureView",
    view:
      baseDir === undefined
        ? { filePath: view.filePath, ops: view.ops }
        : { filePath: view.filePath, baseDir, ops: view.ops },
  };
}

function takeFirst(list: LineInterval[], n: number): LineInterval[] {
  const out: LineInterval[] = [];
  let remaining = n;
  for (const iv of list) {
    if (remaining <= 0) break;
    const take = Math.min(iv.hi - iv.lo + 1, remaining);
    out.push({ lo: iv.lo, hi: iv.lo + take - 1 });
    remaining -= take;
  }
  return out;
}

function takeLast(list: LineInterval[], n: number): LineInterval[] {
  const lengths = list.map((iv) => iv.hi - iv.lo + 1);
  const total = lengths.reduce((a, b) => a + b, 0);
  let skip = Math.max(total - n, 0);
  const out: LineInterval[] = [];
  list.forEach((iv, index) => {
    if (skip >= lengths[index]) {
      skip -= lengths[index];
      return;
    }
    out.push({ lo: iv.lo + skip, hi: iv.hi });
    skip = 0;
  });
  return out;
}

function selectRange(list: LineInterval[], from: number, to: number): LineInterval[] {
  if (to < 1 || from < 1 || to < from) return [];
  // WHY: stream positions are the concatenation of the intervals — walk once,
  // WHY: keeping positions inside [from, to]; clamping is automatic.
  const out: LineInterval[] = [];
  let pos = 0;
  for (const iv of list) {
    const len = iv.hi - iv.lo + 1;
    const start = pos + 1;
    const end = pos + len;
    const keepLo = Math.max(start, from);
    const keepHi = Math.min(end, to);
    if (keepLo <= keepHi) {
      out.push({ lo: iv.lo + (keepLo - start), hi: iv.lo + (keepHi - start) });
    }
    pos = end;
    if (pos >= to) break;
  }
  return out;
}

/**
 * Interval algebra (ADR-0033 D2): folds stream-relative slice ops over the
 * 1-indexed line space `[1..lineCount]`. Total and exact — out-of-range
 * selections yield `[]` (the caller passes through), never an error.
 */
export function applySliceOps(ops: readonly SliceOp[], lineCount: number): LineInterval[] {
  if (!Number.isInteger(lineCount) || lineCount <= 0) return [];
  let intervals: LineInterval[] = [{ lo: 1, hi: lineCount }];
  for (const op of ops) {
    switch (op.kind) {
      case "first":
        intervals = takeFirst(intervals, op.n);
        break;
      case "last":
        intervals = takeLast(intervals, op.n);
        break;
      case "dropLast": {
        const total = intervals.reduce((a, iv) => a + (iv.hi - iv.lo + 1), 0);
        intervals = takeFirst(intervals, total - op.n);
        break;
      }
      case "from":
        intervals = selectRange(intervals, op.n, Number.MAX_SAFE_INTEGER);
        break;
      case "range":
        intervals = selectRange(intervals, op.from, op.to);
        break;
    }
    if (intervals.length === 0) break;
  }
  return intervals;
}
