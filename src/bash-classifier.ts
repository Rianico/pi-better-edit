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
  /** Single pre-view literal `cd` target, if any (resolution base). Multi-`cd` and
   * post-view-`cd` chains fail closed to pass-through (`multi-cd` / `post-view-cd`)
   * because bash resolves each `cd` against the directory in effect at that point —
   * applying only one of them out of order would lease a path never viewed. */
  baseDir?: string;
  /** Slice ops in stream order, folded by `applySliceOps` over the line count. */
  ops: SliceOp[];
}

/**
 * One admitted single-file search: `grep`/`rg` over an allowlisted flag set (spec §3.2).
 * The pattern and file are the operands exactly as written (unquoted by the parser) so the
 * lifecycle layer resolves the same path bash did, and the `-n` injection is a pure splice.
 */
export interface BashSearch {
  program: SearchProgram;
  /** Match pattern exactly as written; may begin with `-` only after a `--` separator. */
  pattern: string;
  /** The single file operand exactly as written (relative or absolute). */
  filePath: string;
  /** True when the model already asked for line numbers (`-n` / `--line-number`). */
  lineNumbered: boolean;
  /** Resolution base for a single pre-view literal `cd` — the view rule verbatim (ADR-0033 D1). */
  baseDir?: string;
}

/** The only two intercepted search programs (spec §3.2). */
export type SearchProgram = "grep" | "rg";

export type BashClass =
  | { kind: "pureView"; view: BashView }
  | { kind: "pureSearch"; search: BashSearch }
  | { kind: "passThrough"; reason: string };

/** `sed -n` numeric print only — locks out `w`/`e`/`r`/`s`/`;`/`{}`/`/` (R4). */
const SED_NUMERIC_PRINT = /^(\d+)(,(\d+))?p$/;
/** Bare `-N` shorthand (`head -20`), corpus-dominant per R2. */
const BARE_COUNT = /^-(\d+)$/;
/** Attached `-n` forms (`-n20`, `-n+55`, `-n-5`). */
const ATTACHED_COUNT = /^-n(\+?-?\d+)$/;
/** Unquoted glob metachars — unbash exposes globs as plain words (ADR-0033 D5). */
const UNQUOTED_GLOB = /[*?[]/;

/** The only two intercepted search programs (spec §3.2). */
const SEARCH_PROGRAMS: ReadonlySet<string> = new Set(["grep", "rg"]);

/** The ONLY flags a search may carry (spec §3.2). Everything else — output-altering
 * (`-c -v -o -A -B -C -l -L --color -m -q -s -w -x -b -H -h`), rg's display shapes
 * (`--column --heading --json --stats --files -r -0 --vimgrep -N`), and every other short
 * or long form — fails closed to raw bash by absence from this set. */
const SEARCH_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-F",
  "--fixed-strings",
  "-E",
  "--extended-regexp",
]);
/** The two spellings that already request line numbers, so injection is skipped. */
const SEARCH_LINE_NUMBER_FLAGS: ReadonlySet<string> = new Set(["-n", "--line-number"]);

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
function parseSourceStage(shape: StageShape): SourceStage | undefined {
  // WHY: the `rtk` unwrap lives here (and only here) so every source position —
  // WHY: bare commands, `&&` segments, pipeline stage zero — accepts it uniformly,
  // WHY: while filter stages (`parseFilterStage`) and silent commands never do.
  const stage = unwrapViewWrapper(shape);
  if (!stage) return undefined;
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

/**
 * `grep`/`rg` single-file search selector (spec §3.2). Strict default-deny: only the
 * allowlisted flags above survive, they must precede the operands, and the shape must be exactly
 * `PROGRAM [flags] [--] PATTERN FILE`. Flags after the pattern, bundled short flags (`-in`),
 * `=` long forms, `-e`/`-f`, a `-`-leading pattern with no `--`, zero operands (stdin) and
 * two-or-more operands (filename prefixes break the `^\d+:` geometry) all fail closed, as do
 * globs, tildes and expansions — those never reach here because `stageShape`/`literalValue`
 * reject them first. Directory operands are deliberately NOT detected here: this module is pure
 * and zero-fs, so the lifecycle layer re-checks the resolved file kind.
 */
function parseSearchStage(stage: StageShape): BashSearch | undefined {
  if (!SEARCH_PROGRAMS.has(stage.name)) return undefined;
  const operands: string[] = [];
  let lineNumbered = false;
  let separatorSeen = false;
  for (const arg of stage.args) {
    if (!separatorSeen && arg === "--") {
      separatorSeen = true;
      continue;
    }
    if (!separatorSeen && arg.startsWith("-")) {
      // WHY: GNU grep/rg permit post-operand options, but the tranche-1 selector contract
      // WHY: ("flags must precede the file") is the conservative reading and a mid-command
      // WHY: flag is not the benchmark shape — deny rather than guess.
      if (operands.length > 0) return undefined;
      if (!SEARCH_ALLOWED_FLAGS.has(arg)) return undefined;
      if (SEARCH_LINE_NUMBER_FLAGS.has(arg)) lineNumbered = true;
      continue;
    }
    operands.push(arg);
  }
  // WHY: exactly two operands — the pattern and the one file. `grep pat` searches stdin, and
  // WHY: `grep pat a b` prints `file:` prefixes, so both fail closed to raw bash.
  if (operands.length !== 2) return undefined;
  const [pattern, filePath] = operands;
  return { program: stage.name as SearchProgram, pattern, filePath, lineNumbered };
}

/** Downstream pipe stages: selectors with no file operand (stdin only). */
/**
 * Downstream pipe stages: selectors with no file operand (stdin only). The `rtk`
 * unwrap applies here too (ADR-0033 D8 as amended): the field issues
 * `rtk`-prefixed filters (`... | rtk tail -n 4`), and the D9 stdout gate keeps
 * the transparency claim honest per call. Single unwrap, view commands only —
 * `rtk` around anything else stays `unsafe` via the unchanged rules below.
 */
function parseFilterStage(shape: StageShape): SliceOp[] | undefined {
  const stage = unwrapViewWrapper(shape);
  if (!stage) return undefined;
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

interface SearchSeg {
  kind: "search";
  search: BashSearch;
}

type Segment = SilentSeg | ViewSeg | SearchSeg | { kind: "unsafe"; reason: string };

/**
 * `cd <literal>` (never a `-`-leading operand), `true`, `:` — the corpus-closed
 * silent set (R3). A `-`-leading operand is an option, not a directory: bash
 * consumes `cd --`/`cd -P`/`cd -L` and, with no operand left, cds to `$HOME`, so
 * taking the flag as the target would resolve a path the model never viewed.
 *
 * WHY `prefixPosition`: every statement before the terminal view of a `;` chain
 * must be silent, and the field writes that prefix `pwd` as often as `cd`.
 * `pwd` prints the working directory, so it is admitted *only* there: the
 * position proves the sequencing is deterministic, and D9 still byte-checks
 * stdout, which carries the directory line and therefore never matches the
 * slice — the lease is refused at serve time. Outside a prefix position (an
 * `&&` chain) the set stays exactly the three commands above.
 */
function parseSilent(stage: StageShape, prefixPosition = false): SilentSeg | undefined {
  if (prefixPosition && stage.name === "pwd" && stage.args.length === 0) {
    return { kind: "silent" };
  }
  if (stage.name === "cd") {
    if (stage.args.length !== 1 || stage.args[0].startsWith("-")) return undefined;
    return { kind: "silent", cdDir: stage.args[0] };
  }
  if ((stage.name === "true" || stage.name === ":") && stage.args.length === 0) {
    return { kind: "silent" };
  }
  return undefined;
}

/**
 * `rtk` transparent wrapper (ADR-0033 D8): unwraps to the inner view command in
 * source and pipe-filter positions, view commands only, single unwrap only.
 * `rtk` provably proxies the view class byte-identically today, but reputation is
 * not the safety story — the stdout-verification gate (D9) re-checks every
 * replacement against the observed bytes, so a future filtering `rtk` subcommand
 * fails closed instead of mis-serving. `rtk` anywhere else (wrapping a non-view,
 * carrying its own flags, around silent commands) stays `unsafe`.
 */
function unwrapViewWrapper(stage: StageShape): StageShape | undefined {
  if (stage.name !== "rtk") return stage;
  const [inner, ...rest] = stage.args;
  if (inner === undefined) return undefined;
  return { name: inner, args: rest };
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

function classifySegment(node: Command | Pipeline, prefixPosition = false): Segment {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return { kind: "unsafe", reason: "non-literal-command" };
    const silent = parseSilent(stage, prefixPosition);
    if (silent) return silent;
    const source = parseSourceStage(stage);
    if (source) return { kind: "view", filePath: source.filePath, ops: source.ops };
    const search = parseSearchStage(stage);
    if (search) return { kind: "search", search };
    return { kind: "unsafe", reason: `unsupported-command:${stage.name}` };
  }
  const view = parseViewSegment(node);
  if (view) return view;
  return { kind: "unsafe", reason: "unsupported-pipeline" };
}

/**
 * [ADR-0033 D1, amended] A `;`-separated statement chain is admitted only when
 * every boundary between adjacent statements is an unconditional `;`.
 *
 * WHY the separator text decides: `unbash` reports a `;` and a newline as the
 * same statement boundary, so the parse alone cannot tell the sanctioned
 * `cd dir; cat file` shape from a newline-separated script. Only the `;` form is
 * the deterministic prefix shape this decision authorises; the newline form
 * stays pass-through rather than riding in on the same parse shape.
 */
function isSemicolonStatementChain(command: string, statements: readonly Statement[]): boolean {
  if (statements.length < 2) return false;
  for (let index = 1; index < statements.length; index++) {
    const previous = statements[index - 1];
    const statement = statements[index];
    if (previous === undefined || statement === undefined) return false;
    if (!/^\s*;\s*$/.test(command.slice(previous.end, statement.pos))) return false;
  }
  return true;
}

/**
 * Span-kind chain rule (ADR-0033 D1, amended): `&&`-only within a statement,
 * exactly one `view`, all others `silent`, undetermined is `unsafe`. Returns the
 * view with its resolution base (the single pre-view literal `cd`, if any;
 * multi-`cd` and post-view-`cd` chains are `passThrough`).
 *
 * A `;`-separated statement chain is admitted under the same rule with one
 * addition: every statement before the terminal one must itself be a silent
 * prefix, so the view is the last statement and the sequencing before it is
 * deterministic (see `isSemicolonStatementChain`).
 */
export function classifyBashCommand(command: string): BashClass {
  return classifyBash(command, {});
}

/**
 * WHY the internal `located` out-parameter: the line-number injection must splice at the search
 * program token's source offset, and that offset is only known while the chain walk is running.
 * Classifying here and locating again in the rewriter would duplicate the whole `;`/`&&`/silent
 * chain gate, so the terminal search records its offset in the caller's box instead.
 */
function classifyBash(command: string, located: { searchNameEnd?: number }): BashClass {
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
  const statements = parsed.commands as Statement[];
  // D1/D9, amended 2026-10-09 (commit 7b78278): See ADR-0033. This site
  // WHY: implements D1's `;`-chain gate at the statement-chain check; D9's
  // WHY: symmetric stdout normalization lives in lifecycle-hooks.
  // WHY: a `;` chain is admitted only through the semicolon gate; every other
  // WHY: multi-statement script — newline-separated included — is the compound
  // WHY: ceiling and stays pass-through (ADR-0033 D1 as amended).
  if (statements.length !== 1 && !isSemicolonStatementChain(command, statements)) {
    return { kind: "passThrough", reason: "multi-statement" };
  }
  const segments: Array<{ node: Command | Pipeline; prefixPosition: boolean }> = [];
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index] as Statement;
    if (statement.type !== "Statement" || statement.background) {
      return { kind: "passThrough", reason: "background" };
    }
    // WHY: anything before the terminal statement is a prefix position — a view
    // WHY: there makes the script a compound chain, not a view (checked below).
    const prefixPosition = index < statements.length - 1;
    const top = statement.command;
    if (top.type === "AndOr") {
      const chain = top as AndOr;
      if (chain.operators.some((op) => op !== "&&")) {
        return { kind: "passThrough", reason: "non-and-chain" };
      }
      for (const node of chain.commands as Array<Command | Pipeline>) {
        segments.push({ node, prefixPosition });
      }
    } else if (top.type === "Command" || top.type === "Pipeline") {
      segments.push({ node: top, prefixPosition });
    } else {
      return { kind: "passThrough", reason: "compound-top" };
    }
  }
  if (segments.length > BASH_VIEW_MAX_CHAIN_SEGMENTS) {
    return { kind: "passThrough", reason: "chain-too-long" };
  }
  let view: ViewSeg | undefined;
  let searchSeg: BashSearch | undefined;
  let baseDir: string | undefined;
  for (const { node, prefixPosition } of segments) {
    if (node.type !== "Command" && node.type !== "Pipeline") {
      return { kind: "passThrough", reason: "compound-segment" };
    }
    const classified = classifySegment(node, prefixPosition);
    if (classified.kind === "unsafe") {
      return { kind: "passThrough", reason: classified.reason };
    }
    if (classified.kind === "silent") {
      if (classified.cdDir !== undefined) {
        // WHY: bash resolves each `cd` against the directory in effect at that
        // WHY: point, so only a single pre-view `cd` applied to `ctx.cwd` is sound.
        // WHY: A `cd` after the view ran too late to affect it (`cat f && cd sub`
        // WHY: viewed `./f`, not `sub/f`), and chained `cd`s compose (`cd a && cd b`
        // WHY: lands in `a/b`, not `b`) — both fail closed to pass-through rather
        // WHY: than lease a path the model never saw (ADR-0033 D1).
        if (view !== undefined) return { kind: "passThrough", reason: "post-view-cd" };
        if (baseDir !== undefined) return { kind: "passThrough", reason: "multi-cd" };
        baseDir = classified.cdDir;
      }
      continue;
    }
    if (classified.kind === "search") {
      // WHY: the search obeys the view's chain rule verbatim (ADR-0033 D1 as amended): only the
      // WHY: terminal statement may carry it, and one view-or-search per command — a prefix
      // WHY: `grep` would be a compound chain the model did not ask about, so it fails closed.
      if (prefixPosition) return { kind: "passThrough", reason: "multi-statement" };
      if (view !== undefined || searchSeg !== undefined) {
        return { kind: "passThrough", reason: "multi-view" };
      }
      searchSeg = classified.search;
      if (node.type === "Command" && node.name?.end !== undefined) {
        located.searchNameEnd = node.name.end;
      }
      continue;
    }
    // WHY: only the terminal statement may carry the view (ADR-0033 D1 as
    // WHY: amended) — a view in a prefix statement means the script is a
    // WHY: compound chain the model did not ask about, so it fails closed.
    if (prefixPosition) return { kind: "passThrough", reason: "multi-statement" };
    if (view !== undefined || searchSeg !== undefined) {
      return { kind: "passThrough", reason: "multi-view" };
    }
    view = classified;
  }
  if (searchSeg) {
    return {
      kind: "pureSearch",
      search: baseDir === undefined ? searchSeg : { ...searchSeg, baseDir },
    };
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

/**
 * [spec §3.3] The pure `tool_call` rewrite: inject the line-number flag immediately after the
 * search program name — before any `--` separator, so `grep -- -pat f` becomes
 * `grep -n -- -pat f` — and return the command byte-identically unchanged for everything the
 * allowlist does not admit (a denied flag, a pipeline, a non-search command, or an already
 * numbered search). Zero filesystem access: the rewrite is decided from the AST alone, and the
 * `tool_result` side re-parses the mutated command instead of sharing state with this hook.
 */
export function withSearchLineNumbers(command: string): string {
  const located: { searchNameEnd?: number } = {};
  const classification = classifyBash(command, located);
  if (classification.kind !== "pureSearch") return command;
  if (classification.search.lineNumbered) return command;
  const nameEnd = located.searchNameEnd;
  if (nameEnd === undefined) return command;
  const flag = classification.search.program === "rg" ? "--line-number" : "-n";
  return `${command.slice(0, nameEnd)} ${flag}${command.slice(nameEnd)}`;
}
