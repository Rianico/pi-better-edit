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
import type { Command, Pipeline, Statement, Word } from "unbash";
import { BASH_SEARCH_MAX_FILES } from "./constants.js";
import { decide } from "./bash-conversion/decide.js";
import type { Decision } from "./bash-conversion/decide.js";
import { assertNever } from "./utils.js";

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

/**
 * WHY: (item 9) a content filter cannot fold over `LineInterval[]` — that algebra is
 * WHY: count-based over a line count, so a keep/drop stage needs the line bytes. These ops
 * WHY: carry the filter through the ordered stage array; the lifecycle layer folds them over
 * WHY: `(true line, stream text)` pairs left to right and byte-gates the recomputed output
 * WHY: against the observed stdout. Matching is literal substring, so a regex-looking
 * WHY: pattern simply fails that gate and passes through raw.
 *
 * WHY: (item 11) `sortUnique`, `uniq` and `count` are the line-SET consumers. `sortUnique`
 * WHY: (`sort -u`) dedupes by text keeping the FIRST occurrence's true line, then orders by
 * WHY: raw bytes; `uniq` collapses ADJACENT equal runs keeping each run head; `count`
 * WHY: (`wc -l`) is terminal — it consumes the whole stream and emits its length, so
 * WHY: `parseViewSegment` refuses any stage after it. The first two reorder the stream, which
 * WHY: is why the render states the order in its header while every lease keeps the true file
 * WHY: coordinate it was folded from.
 */
type ContentOp =
  | { kind: "keep"; pattern: string }
  | { kind: "drop"; pattern: string }
  | { kind: "sortUnique" }
  | { kind: "uniq" }
  | { kind: "count" };

/**
 * WHY: (item 9) one ordered pipeline stage. A single fold-left array keeps `grep|head` and
 * WHY: `head|grep` distinguishable by position; `SliceOp` is a structural subset, so every
 * WHY: Tier-1/2 `toEqual` literal still matches.
 */
export type ViewOp = SliceOp | ContentOp;

/**
 * WHY: (item 11) the union split is a total function, not a hand-rolled predicate: every arm is
 * WHY: named here, so a new `ViewOp` kind fails `pnpm run typecheck` at this switch instead of
 * WHY: being classified as a slice and folded through the interval algebra by accident.
 */
export function isContentOp(viewOp: ViewOp): viewOp is ContentOp {
  switch (viewOp.kind) {
    case "keep":
    case "drop":
    case "sortUnique":
    case "uniq":
    case "count":
      return true;
    case "first":
    case "last":
    case "dropLast":
    case "from":
    case "range":
      return false;
    default:
      return assertNever(viewOp);
  }
}

/** The complement of `isContentOp`, derived from it so the split has one authority. */
export function isSliceOp(viewOp: ViewOp): viewOp is SliceOp {
  return !isContentOp(viewOp);
}

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
  /** Ordered stages in stream order; see `ViewOp` — folded left, so order matters. */
  ops: ViewOp[];
  /** Present-and-true only for `cat -n FILE` / `nl -ba FILE`; absent means unnumbered. Optional so Tier-1 `toEqual` literals keep passing. */
  lineNumbered?: boolean;
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
  /** Slice ops from a trailing `head`/`tail` pipeline (ADR-0039 D3); absent for a bare search. */
  sliceOps?: SliceOp[];
  /** Resolution base for a single pre-view literal `cd` — the view rule verbatim (ADR-0033 D1). */
  baseDir?: string;
}

/** The only two intercepted search programs (spec §3.2). */
export type SearchProgram = "grep" | "rg";

/**
 * WHY: (item 10) `grep`/`rg PATTERN FILE...` — two or more explicit files, no recursion flag.
 * WHY: Every operand is a FILE, so the stdout geometry is the `FILE:LINE:content` triple that
 * WHY: its own serve seam parses; the single-file `BashSearch` above is left byte-identical.
 */
export interface BashMultiSearch {
  program: SearchProgram;
  /** Match pattern exactly as written; same `-`-leading/`-e` rules as `BashSearch`. */
  pattern: string;
  /** Every file operand exactly as written, in operand order; 2..`BASH_SEARCH_MAX_FILES`. */
  filePaths: string[];
  lineNumbered: boolean;
  baseDir?: string;
}

/** WHY: (item 10) `grep -r PATTERN DIR` — exactly one explicit dir (or file) operand. */
export interface BashRecursiveSearch {
  program: SearchProgram;
  pattern: string;
  /** The one operand exactly as written; a file operand recurses over just that file. */
  dirPath: string;
  lineNumbered: boolean;
  baseDir?: string;
}

/** WHY: (item 10) `rg --files [DIR]` — an anchorless, existence-checked path list. */
export interface BashFilesList {
  program: "rg";
  /** Optional explicit list root exactly as written; absent means the effective cwd. */
  dirPath?: string;
  baseDir?: string;
}

/**
 * WHY: (item 10) the admitted search family, tagged by stdout geometry so each shape gets its
 * WHY: own serve seam. `pureSearch` is the Tier-1/2 single-file shape and keeps its exact
 * WHY: `toEqual` contract; the three new tags never reshape it.
 */
export type SearchFamily =
  | { kind: "pureSearch"; search: BashSearch }
  | { kind: "pureMultiSearch"; search: BashMultiSearch }
  | { kind: "pureRecursiveSearch"; search: BashRecursiveSearch }
  | { kind: "pureFilesList"; search: BashFilesList };

/** A static glue segment: a literal print or silent env command with parse-time expected bytes. */
export interface GlueSegment {
  /** Program exactly as written (`"echo"`, `"printf"`, `"export"`, `"set"`). */
  program: "echo" | "printf" | "export" | "set";
  /** Exact stdout contribution, computed at parse time and verified during peeling. */
  expectedText: string;
  /** UTF-8 byte length of `expectedText`. */
  expectedBytes: number;
}
/** One admitted segment of a compound, in encounter order (`:`/`true` drop out, `cd` to base). */
export type CompoundSegment =
  | ViewSeg
  | SearchSeg
  | { kind: "glue"; glue: GlueSegment }
  | { kind: "raw"; command: string };
export type BashClass =
  | { kind: "pureView"; view: BashView }
  | { kind: "pureSearch"; search: BashSearch }
  | { kind: "pureMultiSearch"; search: BashMultiSearch }
  | { kind: "pureRecursiveSearch"; search: BashRecursiveSearch }
  | { kind: "pureFilesList"; search: BashFilesList }
  | {
      kind: "pureCompound";
      /** Ordered admitted segments; silent prefixes are absorbed (`cd` into `baseDir`). */
      segments: CompoundSegment[];
      /** Chain-level resolution base (single pre-block literal `cd`), if any. */
      baseDir?: string;
    }
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

/** The flags a search may carry verbatim (spec §3.2). The value-taking match-limit forms
 * (`-m N`, `--max-count=N`) are parsed in `parseSearchStage` instead. Everything else —
 * output-altering (`-c -v -o -A -B -C -l -L -q -s -b -H -h`), rg's display shapes
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
  "-w",
  "--word-regexp",
  "-x",
  "--line-regexp",
  // WHY: only the `never` value is admitted — `--color` alone, `--color=auto` and
  // WHY: `--color=always` all change or fail to change the row geometry unpredictably.
  "--color=never",
  "--colour=never",
]);

/** The letters a bundled single-dash cluster may contain (spec §3.2). Any digit or unknown
 * letter anywhere in the cluster fails closed, so `-n5`, `-inQ` and `-x5` stay raw bash.
 * `m` and `e` are special-cased: each may only close the cluster and consumes the next
 * argument (`-nm 3`, `-ine pat`), while the attached `-m` forms (`-m3`, `-nm3`) fail closed.
 * (`-ePAT` never reaches the cluster loop: any token starting `-e` is the attached
 * explicit-pattern form and is handled before decomposition.) */
const SEARCH_SHORT_LETTERS: ReadonlySet<string> = new Set(["n", "i", "F", "E", "w", "x", "m", "e"]);

/** Long grep recursion markers (`-R`'s long form is `--dereference-recursive`). */
const SEARCH_GREP_RECURSIVE_FLAGS: ReadonlySet<string> = new Set([
  "-r",
  "-R",
  "--recursive",
  "--dereference-recursive",
]);

/** The attached long match-limit form only: `--max-count=N`. A bare `--max-count` (value as
 * a separate argument) fails closed — spec §3.2 admits the separate-argument spelling for
 * the short `-m` alone. */
const SEARCH_MAX_COUNT_LONG = /^--max-count=(\d+)$/;

/** A run of ASCII digits: the only spelling an admitted `-m`/`--max-count` value may take. */
const SEARCH_COUNT_VALUE = /^\d+$/;
/** The two spellings that already request line numbers, so injection is skipped. */
const SEARCH_LINE_NUMBER_FLAGS: ReadonlySet<string> = new Set(["-n", "--line-number"]);

/** The one admitted match-limit value: `N` strictly positive, so `-m 0` and `-m 00` fail
 * closed alongside `-m -1` and `-m abc`. A missing argument is `undefined` at runtime. */
function isPositiveCount(value: string | undefined): boolean {
  if (value === undefined || !SEARCH_COUNT_VALUE.test(value)) return false;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0;
}

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
  lineNumbered?: boolean;
}

/** Stages that consume the source file: `cat FILE`, or a file-direct filter. */
function parseSourceStage(shape: StageShape): SourceStage | undefined {
  // WHY: the `rtk` unwrap lives here (and only here) so every source position —
  // WHY: bare commands, `&&` segments, pipeline stage zero — accepts it uniformly,
  // WHY: while filter stages (`parseFilterStage`) and silent commands never do.
  const stage = unwrapViewWrapper(shape);
  if (!stage) return undefined;
  if (stage.name === "cat") {
    // WHY: (item 8) the numbered spelling is exactly `cat -n FILE`. A second flag,
    // WHY: a long `--number`, an attached `-nFILE`, or a `-`-leading file all fail closed.
    if (stage.args.length === 2 && stage.args[0] === "-n" && !stage.args[1].startsWith("-")) {
      return { filePath: stage.args[1], ops: [], lineNumbered: true };
    }
    if (stage.args.length !== 1 || stage.args[0].startsWith("-")) return undefined;
    return { filePath: stage.args[0], ops: [] };
  }
  // WHY: (item 8) the only admitted `nl` spelling is exactly `nl -ba FILE` (number all
  // WHY: lines, the `cat -n` geometry). `-ba` attached differently (`-b a`,
  // WHY: `--body-numbering=a`, `-bn`, `-bp`, `-bt`, `-v`, `-i`, `-s`, `-w`, `-n*`) and any
  // WHY: extra operand all fail closed.
  if (stage.name === "nl") {
    if (stage.args.length !== 2 || stage.args[0] !== "-ba" || stage.args[1].startsWith("-")) {
      return undefined;
    }
    return { filePath: stage.args[1], ops: [], lineNumbered: true };
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
 * WHY: (item 10) `rg --files [DIR]` — the anchorless path list. The shape is exactly the flag
 * WHY: plus zero or one non-`-` root; any other token (a pattern, another flag) fails closed,
 * WHY: because this shape has no match rows and therefore no `LINE:content` geometry at all.
 */
function parseFilesListStage(stage: StageShape): BashFilesList | undefined {
  if (stage.name !== "rg") return undefined;
  if (stage.args.length === 0 || stage.args.length > 2) return undefined;
  if (stage.args[0] !== "--files") return undefined;
  const root = stage.args[1];
  if (root !== undefined && root.startsWith("-")) return undefined;
  return { program: "rg", ...(root !== undefined ? { dirPath: root } : {}) };
}

/**
 * `grep`/`rg` single-file search selector (spec §3.2). Strict default-deny: only the
 * allowlisted flags above survive and the shape must be exactly
 * `[flags] PATTERN [flags] FILE [flags]`. Flags are admitted at any position before `--` —
 * before the pattern, between pattern and file, and after the file — because GNU grep/rg
 * accept post-operand options and the benchmark issues them (`grep pat -i f`). A bundled
 * single-dash cluster (`-in`, `-wF`) is decomposed and EVERY letter must be admitted; the
 * value-taking `m` may only close it (`-nm 3`). The explicit-pattern `-e` is admitted in
 * three spellings — separate (`-e PAT`), attached (`-ePAT`, handled before cluster
 * decomposition since `PAT` letters are not admitted), and cluster-close (`-ine PAT`,
 * mirroring `m`: must close, consumes the next argument) — exactly once; its value becomes
 * THE pattern so the operands must then be exactly `[FILE]`. `--` ends flag parsing, so
 * `grep pat -- -n` names the file `-n`. Fail closed: attached short values (`-m3`, `-nm3`),
 * any digit in a cluster (`-n5`), an unknown letter (`-inQ`), every `=`-long form but
 * `--max-count=N` (`--line-number=x`, `--color=always`), a value that is not a strictly
 * positive integer or not exactly `never`, `-f` (stays denied: file-input patterns break
 * the single-`PATTERN FILE` geometry), `-e` with no value, `-e` twice, a pattern both via
 * `-e` and positionally, a `-`-leading pattern with no `--` (unless given via `-e`), zero
 * operands (stdin), and more than `BASH_SEARCH_MAX_FILES` file operands.
 * Globs, tildes and expansions never reach here because `stageShape`/`literalValue` reject
 * them first.
 * WHY: (item 10) the operand arity now spans four shapes — `[PATTERN FILE]` (single-file),
 * WHY: `[PATTERN FILE...]` (multi-file), `grep -r PATTERN DIR` (recursive walk) and
 * WHY: `rg --files [DIR]` (anchorless list). Their stdout geometries differ (`LINE:content`,
 * WHY: `FILE:LINE:content`, a path list), so the family is returned as a tagged union rather
 * WHY: than one widened interface. Directory operands are still NOT detected here: this module
 * WHY: is pure and zero-fs, so the lifecycle layer re-checks the resolved file kind — and
 * WHY: upgrades an `rg` directory operand (rg recurses by default) while a `grep` directory
 * WHY: operand stays raw (native grep errors without `-r`).
 */
function parseSearchStage(stage: StageShape): SearchFamily | undefined {
  const filesList = parseFilesListStage(stage);
  if (filesList) return { kind: "pureFilesList", search: filesList };
  if (!SEARCH_PROGRAMS.has(stage.name)) return undefined;
  const program = stage.name as SearchProgram;
  const isGrep = program === "grep";
  const args = stage.args;
  const operands: string[] = [];
  let lineNumbered = false;
  let separatorSeen = false;
  let recursive = false;
  let explicitPattern: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!separatorSeen && arg === "--") {
      separatorSeen = true;
      continue;
    }
    if (!separatorSeen && arg.startsWith("-")) {
      if (SEARCH_ALLOWED_FLAGS.has(arg)) {
        if (SEARCH_LINE_NUMBER_FLAGS.has(arg)) lineNumbered = true;
        continue;
      }
      const attachedMaxCount = SEARCH_MAX_COUNT_LONG.exec(arg);
      if (attachedMaxCount !== null) {
        // WHY: `--max-count=N` is the only admitted `=`-long form and N must be a strictly
        // WHY: positive integer literal — `--max-count=0` and `--max-count=` fail closed.
        if (!isPositiveCount(attachedMaxCount[1])) return undefined;
        continue;
      }
      // WHY: (item 10) grep's long recursion markers; rg's `--files` was handled whole above,
      // WHY: so it can only reach here in a shape that fails the list gate and must stay denied.
      if (isGrep && SEARCH_GREP_RECURSIVE_FLAGS.has(arg)) {
        recursive = true;
        continue;
      }
      // WHY: every other `--…` token is an unlisted long option (`--json`, `--color=always`).
      if (arg.startsWith("--")) return undefined;
      // WHY: explicit `-e` takes its pattern separately (`-e PAT`): exactly once, must have
      // WHY: a next argument, which becomes THE pattern (so operands must then be `[FILE]`).
      // WHY: a `-`-leading value is admitted here — that is the point of `-e`.
      if (arg === "-e") {
        if (explicitPattern !== undefined) return undefined;
        const value = args.at(index + 1);
        if (value === undefined) return undefined;
        explicitPattern = value;
        index += 1;
        continue;
      }
      // WHY: attached `-ePAT` is handled BEFORE letter decomposition: `PAT...` letters are
      // WHY: not admitted flags, so decomposing would misread the pattern as a cluster
      // WHY: (`-efoo` is pattern `foo`, not flags `e`+`f`+`o`+`o`).
      if (arg.startsWith("-e")) {
        if (explicitPattern !== undefined) return undefined;
        explicitPattern = arg.slice(2);
        continue;
      }
      // WHY: a single-dash token is a short cluster: every letter must be admitted, and the
      // WHY: value-taking `m`/`e` may only close it, each consuming the next argument
      // WHY: (`-nm 3`, `-ine pat`).
      const cluster = arg.slice(1).split("");
      if (cluster.length === 0) return undefined;
      for (let position = 0; position < cluster.length; position++) {
        const letter = cluster[position];
        // WHY: (item 10) `r`/`R` are grep's recursion markers and may sit anywhere in a cluster
        // WHY: (`-rn`); for rg the same letters are `--replace` and stay denied.
        if (letter === "r" || letter === "R") {
          if (!isGrep) return undefined;
          recursive = true;
          continue;
        }
        if (!SEARCH_SHORT_LETTERS.has(letter)) return undefined;
        if (letter === "n") lineNumbered = true;
        if (letter === "m") {
          if (position !== cluster.length - 1) return undefined;
          if (!isPositiveCount(args.at(index + 1))) return undefined;
          index += 1;
        }
        if (letter === "e") {
          if (position !== cluster.length - 1) return undefined;
          if (explicitPattern !== undefined) return undefined;
          const value = args.at(index + 1);
          if (value === undefined) return undefined;
          explicitPattern = value;
          index += 1;
        }
      }
      continue;
    }
    operands.push(arg);
  }
  // WHY: (item 10) operand arity. Without `-e` the first operand is the PATTERN and the rest
  // WHY: are FILES; with `-e` the value IS the pattern, so EVERY operand is a file. Counts
  // WHY: beyond `BASH_SEARCH_MAX_FILES` fail closed HERE (never silent-truncate, invariant 3);
  // WHY: the total matched-line budget is enforced at serve time against `SEARCH_MAX_MATCHES`.
  const fileOperands = explicitPattern === undefined ? operands.slice(1) : [...operands];
  const pattern = explicitPattern ?? operands[0];
  if (pattern === undefined) return undefined;
  if (recursive) {
    // WHY: grep's recursion marker takes exactly one operand — the dir (or file) to walk.
    // WHY: Recursion and multi-file never mix (`grep -r pat a b` fails the whole stage closed).
    if (fileOperands.length !== 1) return undefined;
    const dirPath = fileOperands[0];
    if (dirPath === undefined) return undefined;
    return { kind: "pureRecursiveSearch", search: { program, pattern, dirPath, lineNumbered } };
  }
  // WHY: zero file operands is a stdin search (`grep pat`) — still denied, unchanged.
  if (fileOperands.length === 0 || fileOperands.length > BASH_SEARCH_MAX_FILES) return undefined;
  if (fileOperands.length === 1) {
    const filePath = fileOperands[0];
    if (filePath === undefined) return undefined;
    return { kind: "pureSearch", search: { program, pattern, filePath, lineNumbered } };
  }
  return {
    kind: "pureMultiSearch",
    search: { program, pattern, filePaths: [...fileOperands], lineNumbered },
  };
}

/**
 * Downstream pipe stages: selectors with no file operand (stdin only). The `rtk`
 * unwrap applies here too (ADR-0033 D8 as amended): the field issues
 * `rtk`-prefixed filters (`... | rtk tail -n 4`), and the D9 stdout gate keeps
 * the transparency claim honest per call. Single unwrap, view commands only —
 * `rtk` around anything else stays `unsafe` via the unchanged rules below.
 */
function parseFilterStage(shape: StageShape): ViewOp[] | undefined {
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
  return parseContentFilter(stage);
}

/**
 * WHY: (item 9) stdin content filters — `grep PATTERN` keeps, `grep -v PATTERN` drops,
 * WHY: `rg -N PATTERN` keeps. Exact shapes only: no other flag, exactly one positional
 * WHY: pattern, and a `-`-leading pattern fails closed (there is no `--` separator
 * WHY: downstream). Patterns arrive through `stageShape`/`literalValue`, so quoting and
 * WHY: expansion rules match search patterns. `-v`/`-N` are admitted HERE ONLY —
 * WHY: `parseSearchStage` and `SEARCH_ALLOWED_FLAGS` are untouched, so `grep -v pat f` and
 * WHY: `rg -N pat f` stay `unsupported-command:*` at source position.
 */
function parseContentFilter(stage: StageShape): ViewOp[] | undefined {
  if (stage.name === "grep") {
    const [first, second] = stage.args;
    if (stage.args.length === 1) {
      if (first === undefined || first.startsWith("-")) return undefined;
      return [{ kind: "keep", pattern: first }];
    }
    if (stage.args.length === 2 && first === "-v") {
      if (second === undefined || second.startsWith("-")) return undefined;
      return [{ kind: "drop", pattern: second }];
    }
    return undefined;
  }
  // WHY: `rg -N` is the one spelling that pins the no-number geometry; bare `rg PAT` keeps
  // WHY: its default numbering, which the classifier refuses to guess at.
  if (stage.name === "rg") {
    const [first, second] = stage.args;
    if (stage.args.length === 2 && first === "-N") {
      if (second === undefined || second.startsWith("-")) return undefined;
      return [{ kind: "keep", pattern: second }];
    }
    return undefined;
  }
  // WHY: (item 11) the three line-set consumers, each admitted in exactly ONE spelling: `sort
  // WHY: -u` is the dedupe (bare `sort`, `-n`, `-r`, `-o FILE`, a file operand and every
  // WHY: combined flag fail closed), `uniq` takes no flag or operand (adjacent-only, literal),
  // WHY: and `wc -l` is the count (bare `wc`, `-c`, `-w` and any operand fail closed).
  if (stage.name === "sort") {
    return stage.args.length === 1 && stage.args[0] === "-u" ? [{ kind: "sortUnique" }] : undefined;
  }
  if (stage.name === "uniq") {
    return stage.args.length === 0 ? [{ kind: "uniq" }] : undefined;
  }
  if (stage.name === "wc") {
    return stage.args.length === 1 && stage.args[0] === "-l" ? [{ kind: "count" }] : undefined;
  }
  return undefined;
}

/**
 * Sort + merge 1-indexed inclusive print ranges into sorted non-overlapping
 * `SliceOp[]`. Overlap (`[1,5]+[3,7]`→`[1,7]`) and adjacency (`[1,3]+[4,5]`→`[1,5]`,
 * no gap between them so nothing unprinted is added) collapse; disjoint ranges
 * keep their order after sorting. Pure — no I/O, total over its input.
 */
function mergeRangeOps(ranges: ReadonlyArray<{ from: number; to: number }>): SliceOp[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const ops: SliceOp[] = [];
  for (const range of sorted) {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.kind === "range" && range.from <= last.to + 1) {
      if (range.to > last.to) last.to = range.to;
    } else {
      ops.push({ kind: "range", from: range.from, to: range.to });
    }
  }
  return ops;
}

/** `-n PROG [FILE]` or `-n -e PROG [-e PROG …] [FILE]`; every PROG numeric print (R4 strict regex, reused). */
function parseSedArgs(args: string[]): { ops: SliceOp[]; file?: string } | undefined {
  if (args.length < 2 || args[0] !== "-n") return undefined;
  if (args[1] !== "-e") {
    // WHY: legacy spelling keeps working byte-identically — contract.
    if (args.length !== 2 && args.length !== 3) return undefined;
    const printed = SED_NUMERIC_PRINT.exec(args[1]);
    if (!printed) return undefined;
    const from = Number(printed[1]);
    const to = printed[3] === undefined ? from : Number(printed[3]);
    if (to < from) return undefined; // WHY: reversed `10,1p` fails closed (strict-print spirit)
    const ops: SliceOp[] = [{ kind: "range", from, to }];
    return args.length === 3 ? { ops, file: args[2] } : { ops };
  }
  // WHY: multi-range shape `-n (-e PROG)+ [FILE]` — the loop consumes `-e PROG`
  // WHY: pairs; the first non-`-e` token (if any) is the optional trailing FILE,
  // WHY: which must also be the LAST token.
  const ranges: Array<{ from: number; to: number }> = [];
  let index = 1;
  while (index < args.length) {
    if (args[index] !== "-e") break;
    const prog = args[index + 1];
    if (prog === undefined) return undefined; // WHY: dangling `-e`
    const printed = SED_NUMERIC_PRINT.exec(prog);
    if (!printed) return undefined; // WHY: ANY unparseable spec fails the WHOLE stage — never partial
    const from = Number(printed[1]);
    const to = printed[3] === undefined ? from : Number(printed[3]);
    if (to < from) return undefined; // WHY: reversed `10,1p` fails closed (strict-print spirit)
    ranges.push({ from, to });
    index += 2;
  }
  if (ranges.length === 0) return undefined;
  const rest = args.length - index;
  if (rest !== 0 && rest !== 1) return undefined; // WHY: zero or one trailing token: the optional FILE
  const ops = mergeRangeOps(ranges);
  return rest === 1 ? { ops, file: args[index] } : { ops };
}

interface SilentSeg {
  kind: "silent";
  cdDir?: string;
}

export interface ViewSeg {
  kind: "view";
  filePath: string;
  ops: ViewOp[];
  lineNumbered?: boolean;
}

export interface SearchSeg {
  kind: "search";
  family: SearchFamily;
}

export type Segment = SilentSeg | ViewSeg | SearchSeg | { kind: "unsafe"; reason: string };

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

/** Programs admitted as static glue (exact standalone quoted literals; see the synonym gate). */

/**
 * WHY: (ADR-0039 D10) the inert tail of a relaxation-A compound: a byte-count-style summary
 * WHY: that cannot transform the block, redirect output, or reach the network. Only `wc` with
 * WHY: counting flags and at least one file operand qualifies — no stdin reads (a bare `wc`
 * WHY: counts the harness stdin, which misattributes), no `--` escape hatches, no file operands
 * WHY: starting with `-`. `stageShape` already rejects prefixes, redirects, and non-literal
 * WHY: words, so what remains is a fixed program with fixed counting semantics. Extending this
 * WHY: set is a follow-up with its own safety case — add a name here, not a new rule.
 */
export function parseInertTail(
  node: Command | Pipeline,
): { program: "wc"; args: string[] } | undefined {
  if (node.type !== "Command") return undefined;
  const stage = stageShape(node);
  if (stage === undefined || stage.name !== "wc") return undefined;
  let files = 0;
  for (const arg of stage.args) {
    if (arg.startsWith("-")) {
      if (!/^-[lwcm]+$/.test(arg)) return undefined;
      continue;
    }
    files++;
  }
  if (files === 0) return undefined;
  return { program: "wc", args: stage.args };
}

const LITERAL_PRINT_PROGRAMS = new Set(["echo", "printf"]);
/**
 * WHY: (ADR-0039 D6) static glue for compounds: literal prints without dynamic expansions, plus
 * WHY: silent env commands. Expected content and byte length are computed at parse time and
 * WHY: verified during peeling; any form whose bytes cannot be predicted with certainty fails
 * WHY: closed here, because a wrong prediction must never produce a lease.
 */
export function parseGlueSegment(node: Command | Pipeline): GlueSegment | undefined {
  if (node.type !== "Command") return undefined;
  if (node.prefix.length > 0 || node.redirects.length > 0) return undefined;
  if (!isWord(node.name)) return undefined;
  const name = literalValue(node.name);
  if (name === undefined) return undefined;
  if (name === "export") return parseExportGlue(node);
  const stage = stageShape(node);
  if (!stage) return undefined;
  if (LITERAL_PRINT_PROGRAMS.has(stage.name)) return parsePrintGlue(stage);
  if (stage.name === "set") return parseSetGlue(stage);
  return undefined;
}
function parsePrintGlue(stage: { name: string; args: string[] }): GlueSegment | undefined {
  if (stage.args.length !== 1) return undefined;
  const arg = stage.args[0];
  if (arg === undefined || arg.startsWith("-")) return undefined;
  if (stage.name === "echo") {
    // WHY: the print builtin's backslash handling varies by shell; only backslash-free literals
    // WHY: have certain bytes. Escaped content belongs to `printf` (below), which owns escapes.
    if (arg.includes("\\")) return undefined;
    return makeGlue("echo", `${arg}\n`);
  }
  if (stage.name !== "printf") return undefined;
  if (arg.includes("%")) return undefined;
  const text = parsePrintfEscapes(arg);
  if (text === undefined) return undefined;
  return makeGlue("printf", text);
}
function parsePrintfEscapes(format: string): string | undefined {
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = format[i + 1];
    if (esc === "n") {
      out += "\n";
      i++;
    } else if (esc === "t") {
      out += "\t";
      i++;
    } else if (esc === "\\") {
      out += "\\";
      i++;
    } else {
      return undefined;
    }
  }
  return out;
}
function parseExportGlue(node: Command): GlueSegment | undefined {
  if (node.suffix.length !== 1) return undefined;
  const only = node.suffix[0];
  if (only === undefined) return undefined;
  if (isWord(only)) {
    const name = literalValue(only);
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    return makeGlue("export", "");
  }
  if (only.type !== "Assignment") return undefined;
  if (only.append === true || only.index !== undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(only.name)) return undefined;
  if (!isWord(only.value) || literalValue(only.value) === undefined) return undefined;
  return makeGlue("export", "");
}
function parseSetGlue(stage: { name: string; args: string[] }): GlueSegment | undefined {
  if (stage.args.length !== 1) return undefined;
  const flag = stage.args[0];
  if (flag !== "-e" && flag !== "+e") return undefined;
  return makeGlue("set", "");
}
function makeGlue(
  program: "echo" | "printf" | "export" | "set",
  expectedText: string,
): GlueSegment {
  return { program, expectedText, expectedBytes: Buffer.byteLength(expectedText, "utf-8") };
}
function parseViewSegment(node: Command | Pipeline): ViewSeg | SearchSeg | undefined {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return undefined;
    const source = parseSourceStage(stage);
    if (!source) return undefined;
    return {
      kind: "view",
      filePath: source.filePath,
      ops: source.ops,
      ...(source.lineNumbered === true ? { lineNumbered: true } : {}),
    };
  }
  // WHY: the signature says Command | Pipeline, but `unbash` puts every statement kind in
  // WHY: AndOr.commands; a compound operand has neither `operators` nor `commands` and must
  // WHY: fail closed here instead of throwing out of the tool_result hook.
  const pipelineShape = node as { operators?: unknown; commands?: unknown };
  if (!Array.isArray(pipelineShape.operators) || !Array.isArray(pipelineShape.commands)) {
    return undefined;
  }
  if (node.operators.some((op) => op !== "|")) return undefined;
  if (node.commands.length < 2 || node.commands.length > BASH_VIEW_MAX_PIPELINE_STAGES) {
    return undefined;
  }
  const ops: ViewOp[] = [];
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
      if (source) {
        // WHY: (item 8) the numbered geometry is full-file display only; any downstream
        // WHY: filter would silently drop numbered rows while claiming full-file leases.
        // WHY: (item 9) Tier 3 does NOT lift this guard.
        if (source.lineNumbered === true) return undefined;
        filePath = source.filePath;
        ops.push(...source.ops);
        continue;
      }
      // WHY: (item 9) stage 0 may be a search (`grep pat f | head -5`). An UNNUMBERED
      // WHY: search proves exactly what a `keep` filter proves — the file's lines matching
      // WHY: the pattern — so it is translated into one and the content seam byte-gates the
      // WHY: fold against the observed stdout.
      // WHY: [ADR-0039 D3, superseding the numbered-search decline] A NUMBERED single-file search
      // WHY: piped into `head`/`tail` is admitted as `pureSearch` with the slice ops attached.
      // WHY: Admission is safe because the slice is a pure line-count truncation evaluated on
      // WHY: already-resolved rows: original file line numbers are preserved as identifiers, and
      // WHY: leases cover only the survivors shown. Any other downstream stage (sort, uniq,
      // WHY: count, keep, sed ranges) still fails closed here, like the item-8 numbered-view guard.
      const searchSource = parseSearchStage(stage);
      // WHY: (item 10) only the SINGLE-file, unnumbered shape has bare-content stdout that one
      // WHY: `keep` over ONE file can model; multi-file and recursive stdout carry `FILE:LINE:`
      // WHY: prefixes and `rg --files` carries paths, so those compose with nothing downstream.
      if (searchSource?.kind !== "pureSearch") {
        return undefined;
      }
      if (searchSource.search.lineNumbered) {
        // WHY: [ADR-0039 D3] collect the trailing head/tail slices; anything else fails closed.
        const sliceOps: SliceOp[] = [];
        for (let s = 1; s < node.commands.length; s++) {
          const downstream = node.commands[s];
          if (downstream === undefined || downstream.type !== "Command") return undefined;
          const downstreamStage = stageShape(downstream);
          if (!downstreamStage) return undefined;
          const filter = parseFilterStage(downstreamStage);
          if (!filter) return undefined;
          for (const op of filter) {
            if (op.kind !== "first" && op.kind !== "last") return undefined;
            sliceOps.push(op);
          }
        }
        if (sliceOps.length === 0) return undefined;
        return {
          kind: "search",
          family: {
            kind: "pureSearch",
            search: { ...searchSource.search, sliceOps },
          },
        };
      }
      filePath = searchSource.search.filePath;
      ops.push({ kind: "keep", pattern: searchSource.search.pattern });
      continue;
    }
    const filter = parseFilterStage(stage);
    if (!filter) return undefined;
    ops.push(...filter);
  }
  // WHY: (item 11) `wc -l` is TERMINAL: its stdout is the count, so nothing may consume the
  // WHY: rows after it (`... | wc -l | head -2` would head a number). The classifier refuses
  // WHY: the whole pipeline rather than admit a stage order the fold cannot model.
  const countAt = ops.findIndex((op) => op.kind === "count");
  if (countAt !== -1 && countAt !== ops.length - 1) return undefined;
  if (filePath === undefined || ops.length === 0) return undefined;
  return { kind: "view", filePath, ops };
}

export function classifySegment(node: Command | Pipeline, prefixPosition = false): Segment {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return { kind: "unsafe", reason: "non-literal-command" };
    const silent = parseSilent(stage, prefixPosition);
    if (silent) return silent;
    const source = parseSourceStage(stage);
    if (source)
      return {
        kind: "view",
        filePath: source.filePath,
        ops: source.ops,
        ...(source.lineNumbered === true ? { lineNumbered: true } : {}),
      };
    const search = parseSearchStage(stage);
    if (search) return { kind: "search", family: search };
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
export function isSemicolonStatementChain(
  command: string,
  statements: readonly Statement[],
): boolean {
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
/**
 * WHY: (ADR-0039 D7/D9) redundancy without a known cwd. Dot-forms (relative, no `..`,
 * WHY: normalizing to self) resolve to the base for EVERY base, so they need no tracked state.
 * WHY: An absolute target matches only a known-absolute tracked dir exactly (D9 lexical; the
 * WHY: `realpath` fallback belongs to the lifecycle, which has fs access). Everything else counts
 * WHY: normally — sound because an unproven `cd` is treated as a real change, never a no-op.
 */
export function isRedundantCd(target: string, effCwd: string | undefined): boolean {
  if (!target.startsWith("/") && target.split("/").every((part) => part === "" || part === ".")) {
    return true;
  }
  if (effCwd !== undefined && effCwd.startsWith("/") && target === effCwd) {
    return true;
  }
  return false;
}
export function classifyBashCommand(command: string): Decision {
  return decide(command, {});
}

/**
 * WHY the chain lives in `src/bash-conversion/decide.ts` (#151): the guards are data there
 * WHY: (RULES in array order = precedence). This keeps its name and out-param contract for the
 * WHY: line-number splice (`withSearchLineNumbers` below passes a live box); the table owns the walk.
 */
function classifyBash(
  command: string,
  located: {
    searchNameEnds?: Array<{ end: number; program: SearchProgram; lineNumbered: boolean }>;
  },
): Decision {
  return decide(command, located);
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

/** One stream line in a content fold: its TRUE 1-indexed file line and the text stages see. */
export interface ContentLine {
  line: number;
  text: string;
}

/**
 * WHY: (item 9) content-aware fold over `(line, text)` pairs, left in stage order. Slice
 * WHY: stages reuse the interval algebra over stream positions, mapped back to entries so a
 * WHY: multi-interval `sed -n -e` stage keeps its exact shape; `keep`/`drop` narrow by
 * WHY: literal substring. Total and pure — an empty result means the caller passes through
 * WHY: with zero leases, the same contract `applySliceOps` has.
 *
 * WHY: (item 11) the fold is a `switch` over the whole union with no fall-through slice arm, so
 * WHY: the three line-set consumers are handled where they are declared and an unknown kind is
 * WHY: refused (`assertNever`) instead of silently degrading to a slice.
 */
export function applyViewOps(ops: readonly ViewOp[], lines: readonly ContentLine[]): ContentLine[] {
  let stream = [...lines];
  for (const op of ops) {
    switch (op.kind) {
      case "keep":
        stream = stream.filter((entry) => entry.text.includes(op.pattern));
        break;
      case "drop":
        stream = stream.filter((entry) => !entry.text.includes(op.pattern));
        break;
      case "sortUnique":
        stream = sortUniqueLines(stream);
        break;
      case "uniq":
        stream = collapseAdjacentRuns(stream);
        break;
      case "count":
        // WHY: (item 11) `wc -l` is terminal: the stream IS the counted set and its length is
        // WHY: the number, so this arm leaves the rows for the lifecycle layer to lease. No op
        // WHY: folds after it (`parseViewSegment` refuses one).
        break;
      case "first":
      case "last":
      case "dropLast":
      case "from":
      case "range": {
        const intervals = applySliceOps([op], stream.length);
        const next: ContentLine[] = [];
        for (const iv of intervals) next.push(...stream.slice(iv.lo - 1, iv.hi));
        stream = next;
        break;
      }
      default:
        // WHY: (item 11) an unknown op kind must never silently become a slice; the `never`
        // WHY: binding is what keeps `pnpm run typecheck` exhaustive over `ViewOp`.
        return assertNever(op);
    }
    if (stream.length === 0) return [];
  }
  return stream;
}

/**
 * WHY: (item 11) `sort -u` dedupes by text keeping the FIRST occurrence's true line — the
 * WHY: anchor that travels with the row is a real file coordinate, never a renumbered one —
 * WHY: then orders by raw bytes — the C/POSIX collation `sort` uses under `LC_ALL=C`. A host
 * WHY: whose locale collation reorders the set (case-folding, accents) folds differently, fails
 * WHY: the whole-stdout byte gate and passes through raw, never a wrong order.
 */
function sortUniqueLines(stream: ContentLine[]): ContentLine[] {
  const firstByText = new Map<string, ContentLine>();
  for (const entry of stream) {
    if (!firstByText.has(entry.text)) firstByText.set(entry.text, entry);
  }
  return [...firstByText.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.text, "utf8"), Buffer.from(right.text, "utf8")),
  );
}

/**
 * WHY: (item 11) `uniq` is ADJACENT-only and literal: each run of equal text collapses to its
 * WHY: head, so the same text may survive at two non-adjacent positions, each keeping its own
 * WHY: true line. Sorting is never part of it.
 */
function collapseAdjacentRuns(stream: ContentLine[]): ContentLine[] {
  const out: ContentLine[] = [];
  for (const entry of stream) {
    const head = out[out.length - 1];
    if (head === undefined || head.text !== entry.text) out.push(entry);
  }
  return out;
}

/**
 * [spec §3.3] The pure `tool_call` rewrite: inject the line-number flag immediately after the
 * search program name — before any `--` separator, so `grep -- -pat f` becomes
 * `grep -n -- -pat f` — and return the command byte-identically unchanged for everything the
 * allowlist does not admit (a denied flag, a non-search command, or an already numbered
 * search). WHY no pipeline rewrite (item 9): a search-led pipeline is served from the
 * model's own command's output — an unnumbered source is translated into a `keep` filter and
 * a numbered one composes with nothing — so injecting `-n` would change what a downstream
 * content filter sees. Zero filesystem access: the rewrite is decided from the AST alone, and
 * the `tool_result` side re-parses the mutated command instead of sharing state with this hook.
 */
export function withSearchLineNumbers(command: string): string {
  const located: {
    searchNameEnds?: Array<{ end: number; program: SearchProgram; lineNumbered: boolean }>;
  } = {};
  const classification = classifyBash(command, located);
  // WHY: (item 10 + ADR-0039 D5) only search families (bare or compound segments) take the splice;
  // WHY: views, file lists, and declined commands return unchanged. Unnumbered offsets splice
  // WHY: right-to-left so earlier offsets stay valid; already-numbered need nothing.
  if (
    classification.kind !== "pureSearch" &&
    classification.kind !== "pureMultiSearch" &&
    classification.kind !== "pureRecursiveSearch" &&
    classification.kind !== "pureCompound"
  ) {
    return command;
  }
  let rewritten = command;
  const injections = [...(located.searchNameEnds ?? [])]
    .filter((injection) => !injection.lineNumbered)
    .sort((a, b) => b.end - a.end);
  for (const { end, program } of injections) {
    const flag = program === "rg" ? "--line-number" : "-n";
    rewritten = `${rewritten.slice(0, end)} ${flag}${rewritten.slice(end)}`;
  }
  return rewritten;
}
