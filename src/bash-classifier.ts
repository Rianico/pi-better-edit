/**
 * AST-guarded classification of bash commands into slice-accurate file views.
 *
 * Every guard here is an AST predicate (docs/.archive_adrs/0033-bash-view-interception.md D1/D2/D5),
 * which keeps the module pure: unit-testable without fixtures or the pi runtime, with the lifecycle
 * layer applying the result to the disk re-read rather than to the filesystem. Because the parse is
 * the oracle, fail-closed is the absence of a proof rather than the absence of a pattern that matched.
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
 * A content filter cannot fold over `LineInterval[]` — that algebra is count-based, so keep/drop
 * needs the line bytes. These ops carry the filter through the ordered stage array; the lifecycle
 * layer folds them over `(true line, stream text)` pairs and byte-gates the recomputed output against
 * observed stdout. Matching is literal substring, so a regex-looking pattern fails that gate and
 * passes through raw.
 *
 * `sortUnique`, `uniq` and `count` are the line-SET consumers: `sortUnique` dedupes by text keeping
 * the FIRST occurrence's true line, then orders by raw bytes; `uniq` collapses ADJACENT equal runs
 * keeping each run head; `count` consumes the whole stream, emits its length, and is terminal —
 * `parseViewSegment` refuses any stage after it; both reordering ops keep every lease on its true line.
 */
type ContentOp =
  | { kind: "keep"; pattern: string }
  | { kind: "drop"; pattern: string }
  | { kind: "sortUnique" }
  | { kind: "uniq" }
  | { kind: "count" };

/**
 * One ordered pipeline stage: the fold is left over this array, which is what keeps `grep|head` and
 * `head|grep` distinguishable by position. `SliceOp` is a structural subset of this union.
 */
export type ViewOp = SliceOp | ContentOp;

/**
 * A total split, not a hand-rolled predicate: every arm is named here, so a new `ViewOp` kind fails
 * `pnpm run typecheck` at this switch instead of being classified as a slice and folded through the
 * interval algebra by accident.
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

/**
 * The closed display-transform set (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
 * D2). The transform is never served: the lifecycle re-runs it over the re-read raw slice to prove
 * the observed stdout, then serves the raw rows and leases only those rows. `cat -vet` is the
 * BSD/GNU-portable spelling of `cat -A`; both are admitted because the oracle compares the actual
 * transform bytes.
 */
type DisplayTransformKind = "cat-A" | "cat-vet" | "od-c" | "xxd" | "hexdump-C";
export interface DisplayTransform {
  kind: DisplayTransformKind;
  label: string;
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
  /** (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D2) terminal display transform over this view; absent for a plain view. */
  display?: DisplayTransform;
}

/**
 * The window one search asked `grep`/`rg` to print around every match
 * (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3): `-B` /
 * `--before-context` lines before it, `-A` / `--after-context` after it, `-C` / `--context` both.
 * The seam carries the window, not just "context was requested", because every served context row
 * must fall inside SOME match's window — that membership check is the search's own prediction half
 * (D1) evaluated against the re-read file.
 */
export interface BashSearchContext {
  /** Context lines printed BEFORE each match (`-B N` / `--before-context`); 0 when unasked. */
  before: number;
  /** Context lines printed AFTER each match (`-A N` / `--after-context`); 0 when unasked. */
  after: number;
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
  /** Slice ops from a trailing `head`/`tail` pipeline (docs/.archive_adrs/0039-compound-bash-view-interception.md D3); absent for a bare search. */
  sliceOps?: SliceOp[];
  /** Resolution base for a single pre-view literal `cd` — the view rule verbatim (docs/.archive_adrs/0033-bash-view-interception.md D1). */
  baseDir?: string;
  /**
   * Present only when the search asked for a context window
   * (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3). Absent keeps
   * every Tier-1 `toEqual` literal byte-identical and the stdout geometry strictly `LINE:content`.
   */
  context?: BashSearchContext;
}

/** The only two intercepted search programs (spec §3.2). */
export type SearchProgram = "grep" | "rg";

/**
 * `grep`/`rg PATTERN FILE...` — two or more explicit files, no recursion flag. Every operand is a
 * FILE, so the stdout geometry is the `FILE:LINE:content` triple its own serve seam parses; the
 * single-file `BashSearch` above is left byte-identical.
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

/** `grep -r PATTERN DIR` — exactly one explicit dir (or file) operand. */
export interface BashRecursiveSearch {
  program: SearchProgram;
  pattern: string;
  /** The one operand exactly as written; a file operand recurses over just that file. */
  dirPath: string;
  lineNumbered: boolean;
  baseDir?: string;
}

/** `rg --files [DIR]` — an anchorless, existence-checked path list. */
export interface BashFilesList {
  program: "rg";
  /** Optional explicit list root exactly as written; absent means the effective cwd. */
  dirPath?: string;
  baseDir?: string;
}

/**
 * A standalone multi-file view (docs/.archive_adrs/0049-multi-file-bash-views.md M1): `cat FILE...`,
 * `cat -n FILE...`, `nl -ba FILE...`, or `sed -n RANGE FILE...` over two or more newline-terminated
 * text files. Operands stay exactly as written (one page each, in operand order) so the lifecycle
 * layer resolves the same paths bash opened; `lineNumbered` names the numbering transform and `ops`
 * fold over the STREAM (files laid end to end) — how a `sed -n` range spanning files needs no byte path.
 *
 * Its own tag rather than a widened `BashView`: one `filePath` cannot describe N pages, and the
 * serve seam that proves line-count boundaries is a different seam; the single-file shape keeps
 * its exact `toEqual` contract.
 */
export interface BashMultiView {
  /** The program exactly as written (`cat`, `nl`, or `sed`). */
  program: "cat" | "nl" | "sed";
  /** Every file operand in operand order, exactly as written; 2 or more.
   * The file COUNT cap is a configured policy (docs/.archive_adrs/0049-multi-file-bash-views.md M6), enforced at the serve seam. */
  filePaths: string[];
  /** Numeric print selection, folded over the concatenated stream; empty means every line. */
  ops: SliceOp[];
  /** `cat -n` / `nl -ba`: the stdout is the continuous numbering transform (docs/.archive_adrs/0049-multi-file-bash-views.md M3). */
  lineNumbered?: boolean;
  /** Resolution base for a single pre-view literal `cd` — the view rule verbatim (docs/.archive_adrs/0033-bash-view-interception.md D1). */
  baseDir?: string;
}

/**
 * The admitted search family, tagged by stdout geometry so each shape gets its own serve seam.
 * `pureSearch` is the Tier-1/2 single-file shape and keeps its exact `toEqual` contract; the
 * three multi/recursive/files tags never reshape it.
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
  | { kind: "pureMultiView"; view: BashMultiView }
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
/** Unquoted glob metachars — unbash exposes globs as plain words (docs/.archive_adrs/0033-bash-view-interception.md D5). */
const UNQUOTED_GLOB = /[*?[]/;

/** The only two intercepted search programs (spec §3.2). */
const SEARCH_PROGRAMS: ReadonlySet<string> = new Set(["grep", "rg"]);

/** The flags a search may carry verbatim (spec §3.2). The value-taking match-limit forms
 * (`-m N`, `--max-count=N`) are parsed in `parseSearchStage` instead. Everything else —
 * output-altering (`-c -v -o -l -L -q -s -b -H -h`), rg's display shapes
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

/** The context options' value kind: `-B` prints before a match, `-A` after it, `-C` both. */
type SearchContextKind = "before" | "after" | "both";

/**
 * The short context letters and what each selects
 * (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3). They are NOT in
 * `SEARCH_SHORT_LETTERS`: each takes a value from the NEXT argument, exactly like `m`/`e`, and the
 * cluster loop special-cases them below. D3 names `grep -A/-B/-C` and `rg -C` only, so rg's equally
 * valid `-A`/`-B` stay denied. */
const SEARCH_CONTEXT_SHORT_LETTERS: ReadonlyMap<string, SearchContextKind> = new Map([
  ["A", "after"],
  ["B", "before"],
  ["C", "both"],
]);

/**
 * `--after-context`, `--before-context`, `--context` — the long context spellings, granted to `grep`
 * alone because docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3 states
 * them inside the `grep` clause and grants `rg` only `-C`. Both value spellings (`--context 3` and
 * `--context=3`) are the same option, so both are admitted. */
const SEARCH_CONTEXT_LONG_FLAGS: ReadonlyMap<string, SearchContextKind> = new Map([
  ["--after-context", "after"],
  ["--before-context", "before"],
  ["--context", "both"],
]);

/** The attached long spelling only: `--context=3`. An empty or non-numeric value fails closed. */
const SEARCH_CONTEXT_LONG_ATTACHED = /^--(after-context|before-context|context)=(.*)$/;

/**
 * Fold one context option into the window already read, or `undefined` when the option is not
 * admissible. `-A`/`-B` are the two sides, so they COMPOSE (`-B 2 -A 1` is one window), while `-C`
 * sets both and therefore never composes: it cannot follow a side option and no side option can
 * follow it. Repeating a side is refused too. A zero side always means "unasked" here, because the
 * value itself must be strictly positive.
 */
function mergeContext(
  current: BashSearchContext | undefined,
  kind: SearchContextKind | undefined,
  value: string | undefined,
): BashSearchContext | undefined {
  if (kind === undefined || !isPositiveCount(value)) return undefined;
  const n = Number(value);
  if (current === undefined) {
    if (kind === "before") return { before: n, after: 0 };
    if (kind === "after") return { before: 0, after: n };
    return { before: n, after: n };
  }
  if (kind === "both") return undefined;
  if (kind === "before")
    return current.before === 0 ? { before: n, after: current.after } : undefined;
  return current.after === 0 ? { before: current.before, after: n } : undefined;
}

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
  const stage = unwrapViewWrapper(shape);
  if (!stage) return undefined;
  if (stage.name === "cat") {
    if (stage.args.length === 2 && stage.args[0] === "-n" && !stage.args[1].startsWith("-")) {
      return { filePath: stage.args[1], ops: [], lineNumbered: true };
    }
    if (stage.args.length !== 1 || stage.args[0].startsWith("-")) return undefined;
    return { filePath: stage.args[0], ops: [] };
  }
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
 * `rg --files [DIR]` — the anchorless path list. The shape is exactly the flag plus zero or one
 * non-`-` root; any other token (a pattern, another flag) fails closed, because this shape has no
 * match rows and therefore no `LINE:content` geometry at all.
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
 * allowlisted flags above survive, in the exact shape `[flags] PATTERN [flags] FILE [flags]`,
 * admitted anywhere before `--`. A bundled cluster is decomposed and EVERY letter must be
 * admitted; `m` may only close it. `-e` has three spellings — separate, attached and
 * cluster-close — exactly once, its value becoming THE pattern, so operands are exactly
 * `[FILE]`; `--` ends flag parsing. Fail closed: attached short values, any digit in a cluster,
 * an unknown letter, every `=`-long form but `--max-count=N`, a value not a strictly positive
 * integer or not exactly `never`, `-f` (file-pattern input), `-e` with no value or twice, a
 * pattern both ways, a `-`-leading pattern with no `--`, zero operands, over `BASH_SEARCH_MAX_FILES`;
 * globs, tildes and expansions never reach here (`stageShape`/`literalValue` reject them).
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
  let context: BashSearchContext | undefined;
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
        if (!isPositiveCount(attachedMaxCount[1])) return undefined;
        continue;
      }
      if (isGrep && SEARCH_GREP_RECURSIVE_FLAGS.has(arg)) {
        recursive = true;
        continue;
      }
      // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3
      if (arg.startsWith("--")) {
        if (!isGrep) return undefined;
        const attached = SEARCH_CONTEXT_LONG_ATTACHED.exec(arg);
        if (attached !== null) {
          const parsed = mergeContext(
            context,
            SEARCH_CONTEXT_LONG_FLAGS.get(`--${attached[1] ?? ""}`),
            attached[2],
          );
          if (parsed === undefined) return undefined;
          context = parsed;
          continue;
        }
        const longKind = SEARCH_CONTEXT_LONG_FLAGS.get(arg);
        if (longKind !== undefined) {
          const parsed = mergeContext(context, longKind, args.at(index + 1));
          if (parsed === undefined) return undefined;
          context = parsed;
          index += 1;
          continue;
        }
        return undefined;
      }
      if (arg === "-e") {
        if (explicitPattern !== undefined) return undefined;
        const value = args.at(index + 1);
        if (value === undefined) return undefined;
        explicitPattern = value;
        index += 1;
        continue;
      }
      if (arg.startsWith("-e")) {
        if (explicitPattern !== undefined) return undefined;
        explicitPattern = arg.slice(2);
        continue;
      }
      const cluster = arg.slice(1).split("");
      if (cluster.length === 0) return undefined;
      for (let position = 0; position < cluster.length; position++) {
        const letter = cluster[position];
        if (letter === "r" || letter === "R") {
          if (!isGrep) return undefined;
          recursive = true;
          continue;
        }
        const contextKind = SEARCH_CONTEXT_SHORT_LETTERS.get(letter);
        if (contextKind !== undefined) {
          if (!isGrep && contextKind !== "both") return undefined;
          if (position !== cluster.length - 1) return undefined;
          const parsed = mergeContext(context, contextKind, args.at(index + 1));
          if (parsed === undefined) return undefined;
          context = parsed;
          index += 1;
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
  const fileOperands = explicitPattern === undefined ? operands.slice(1) : [...operands];
  const pattern = explicitPattern ?? operands[0];
  if (pattern === undefined) return undefined;
  if (recursive) {
    if (fileOperands.length !== 1) return undefined;
    // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3
    if (context !== undefined) return undefined;
    const dirPath = fileOperands[0];
    if (dirPath === undefined) return undefined;
    return { kind: "pureRecursiveSearch", search: { program, pattern, dirPath, lineNumbered } };
  }
  if (fileOperands.length === 0 || fileOperands.length > BASH_SEARCH_MAX_FILES) return undefined;
  if (fileOperands.length === 1) {
    const filePath = fileOperands[0];
    if (filePath === undefined) return undefined;
    return {
      kind: "pureSearch",
      search: {
        program,
        pattern,
        filePath,
        lineNumbered,
        ...(context === undefined ? {} : { context }),
      },
    };
  }
  // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3
  if (context !== undefined) return undefined;

  return {
    kind: "pureMultiSearch",
    search: { program, pattern, filePaths: [...fileOperands], lineNumbered },
  };
}

/**
 * Downstream pipe stages: selectors with no file operand (stdin only). The `rtk` unwrap applies
 * here too (docs/.archive_adrs/0033-bash-view-interception.md D8 as amended): the field issues
 * `rtk`-prefixed filters (`... | rtk tail -n 4`), and the D9 stdout gate keeps the transparency
 * claim honest per call. Single unwrap, view commands only — `rtk` around anything else stays
 * `unsafe` via the unchanged rules below.
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
 * stdin content filters: `grep PATTERN` keeps, `grep -v PATTERN` drops, `rg -N PATTERN` keeps.
 * Exact shapes only: no other flag, exactly one positional pattern, and a `-`-leading pattern fails
 * closed (there is no `--` separator downstream). Patterns arrive through
 * `stageShape`/`literalValue`, so quoting and expansion rules match search patterns. `-v`/`-N` are
 * admitted HERE ONLY — `parseSearchStage` and `SEARCH_ALLOWED_FLAGS` are untouched, so
 * `grep -v pat f` and `rg -N pat f` stay `unsupported-command:*` at source position.
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
  if (stage.name === "rg") {
    const [first, second] = stage.args;
    if (stage.args.length === 2 && first === "-N") {
      if (second === undefined || second.startsWith("-")) return undefined;
      return [{ kind: "keep", pattern: second }];
    }
    return undefined;
  }
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

/**
 * The numeric-print spec of a `sed` stage, with EVERY trailing file operand (docs/.archive_adrs/0049-multi-file-bash-views.md M1/M5).
 *
 * One grammar for both shapes: a multi-file `sed -n '2,4p' a b` and the settled single-file
 * `sed -n '2,4p' a` must admit the same program text or the two would drift — so the range grammar
 * lives here once and the single-file arity rule stays in `parseSedArgs` (its exact contract).
 */
function parseSedPrintSpec(args: string[]): { ops: SliceOp[]; files: string[] } | undefined {
  if (args.length < 2 || args[0] !== "-n") return undefined;
  if (args[1] !== "-e") {
    const printed = SED_NUMERIC_PRINT.exec(args[1]);
    if (!printed) return undefined;
    const from = Number(printed[1]);
    const to = printed[3] === undefined ? from : Number(printed[3]);
    if (to < from) return undefined;
    return { ops: [{ kind: "range", from, to }], files: args.slice(2) };
  }
  const ranges: Array<{ from: number; to: number }> = [];
  let index = 1;
  while (index < args.length) {
    if (args[index] !== "-e") break;
    const prog = args[index + 1];
    if (prog === undefined) return undefined;
    const printed = SED_NUMERIC_PRINT.exec(prog);
    if (!printed) return undefined;
    const from = Number(printed[1]);
    const to = printed[3] === undefined ? from : Number(printed[3]);
    if (to < from) return undefined;
    ranges.push({ from, to });
    index += 2;
  }
  if (ranges.length === 0) return undefined;
  return { ops: mergeRangeOps(ranges), files: args.slice(index) };
}

/**
 * The admitted multi-file view shapes and nothing else (docs/.archive_adrs/0049-multi-file-bash-views.md
 * M1): `head`/`tail` are excluded because their `==> FILE <==` headers are not file bytes; stdin
 * (`-`), redirects, prefixes, display transforms and pipelines never reach here; and a `-`-leading
 * operand fails closed because option parsing is over.
 *
 * The operand count is NOT capped here: the classifier is pure and zero-fs, so the file cap is
 * operator policy resolved at the serve seam (M6); this gate only requires the shape. The `rtk`
 * unwrap applies because docs/.archive_adrs/0033-bash-view-interception.md D8 makes it a transparent
 * view wrapper and the D9 stdout gate verifies that claim per call — same view either way.
 */
function parseMultiViewStage(shape: StageShape): BashMultiView | undefined {
  const stage = unwrapViewWrapper(shape);
  if (!stage) return undefined;
  const files = (args: readonly string[]): string[] | undefined => {
    if (args.length < 2) return undefined;
    if (args.some((arg) => arg.startsWith("-") || arg === "")) return undefined;
    return [...args];
  };
  if (stage.name === "cat") {
    if (stage.args[0] === "-n") {
      const filePaths = files(stage.args.slice(1));
      if (filePaths === undefined) return undefined;
      return { program: "cat", filePaths, ops: [], lineNumbered: true };
    }
    const filePaths = files(stage.args);
    return filePaths === undefined ? undefined : { program: "cat", filePaths, ops: [] };
  }
  if (stage.name === "nl") {
    if (stage.args[0] !== "-ba") return undefined;
    const filePaths = files(stage.args.slice(1));
    if (filePaths === undefined) return undefined;
    return { program: "nl", filePaths, ops: [], lineNumbered: true };
  }
  if (stage.name === "sed") {
    const spec = parseSedPrintSpec(stage.args);
    if (spec === undefined) return undefined;
    const filePaths = files(spec.files);
    return filePaths === undefined ? undefined : { program: "sed", filePaths, ops: spec.ops };
  }
  return undefined;
}

/** `-n PROG [FILE]` or `-n -e PROG [-e PROG …] [FILE]`; every PROG numeric print (R4 strict regex, reused). */
function parseSedArgs(args: string[]): { ops: SliceOp[]; file?: string } | undefined {
  const spec = parseSedPrintSpec(args);
  if (spec === undefined) return undefined;
  if (args[1] !== "-e" && args.length !== 2 && args.length !== 3) return undefined;
  const [file] = spec.files;
  if (file === undefined) return spec.files.length === 0 ? { ops: spec.ops } : undefined;
  return spec.files.length === 1 ? { ops: spec.ops, file } : undefined;
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
  display?: DisplayTransform;
}

/** A multi-file view segment (docs/.archive_adrs/0049-multi-file-bash-views.md M1). It is
 * deliberately NOT a `ViewSeg`: the compound chain does not compose multi-file views (M1), and the
 * serve seam proves N pages from line counts. */
interface MultiViewSeg {
  kind: "multiView";
  view: BashMultiView;
}

export interface SearchSeg {
  kind: "search";
  family: SearchFamily;
}

export type Segment =
  | SilentSeg
  | ViewSeg
  | MultiViewSeg
  | SearchSeg
  | { kind: "unsafe"; reason: string };

/**
 * `cd <literal>` (never a `-`-leading operand), `true`, `:` — the corpus-closed silent set (R3).
 * A `-`-leading operand is an option, not a directory: bash consumes `cd --`/`cd -P`/`cd -L` and,
 * with no operand left, cds to `$HOME` — taking the flag as the target resolves a path never
 * viewed.
 *
 * `prefixPosition`: every statement before the terminal view of a `;` chain must be silent, and the
 * field writes that prefix `pwd` as often as `cd`. `pwd` prints the working directory, so it is
 * admitted *only* there: the position proves the sequencing is deterministic, and D9 still
 * byte-checks stdout, which carries the directory line and never matches the slice — the lease is
 * refused at serve time. Outside a prefix position (an `&&` chain) the set stays the three above.
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
 * `rtk` transparent wrapper (docs/.archive_adrs/0033-bash-view-interception.md D8): unwraps to the inner view command in
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
 * The inert tail of a relaxation-A compound (docs/.archive_adrs/0039-compound-bash-view-interception.md
 * D10): a byte-count-style summary that cannot transform the block, redirect output, or reach the
 * network. Only `wc` with counting flags and at least one file operand qualifies — no stdin reads (a
 * bare `wc` counts the harness stdin, which misattributes), no `--` escape hatches, no file operands
 * starting with `-`. `stageShape` already rejects prefixes, redirects and non-literal words, so what
 * remains is a fixed program with fixed counting semantics. Extending this set is a follow-up with
 * its own safety case — add a name here, not a new rule.
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
 * Static glue for compounds (docs/.archive_adrs/0039-compound-bash-view-interception.md D6): literal
 * prints without dynamic expansions, plus silent env commands. Expected content and byte length are
 * computed at parse time and verified during peeling; any form whose bytes cannot be predicted with
 * certainty fails closed here, because a wrong prediction must never produce a lease.
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
/**
 * A terminal display-only stage (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
 * D2). The stage has no operand and no redirect (`stageShape` already rejected those); it is the LAST
 * pipeline stage, so nothing can consume its transformed bytes. `rtk cat -A` is deliberately not
 * admitted: the wrapper is a different command, and the bare transform is the only spelling whose
 * bytes this oracle can reproduce.
 */
function parseDisplayTransform(stage: StageShape): DisplayTransform | undefined {
  switch (stage.name) {
    case "cat":
      if (stage.args.length !== 1) return undefined;
      if (stage.args[0] === "-A") return { kind: "cat-A", label: "cat -A" };
      if (stage.args[0] === "-vet") return { kind: "cat-vet", label: "cat -vet" };
      return undefined;
    case "od":
      return stage.args.length === 1 && stage.args[0] === "-c"
        ? { kind: "od-c", label: "od -c" }
        : undefined;
    case "xxd":
      return stage.args.length === 0 ? { kind: "xxd", label: "xxd" } : undefined;
    case "hexdump":
      return stage.args.length === 1 && stage.args[0] === "-C"
        ? { kind: "hexdump-C", label: "hexdump -C" }
        : undefined;
    default:
      return undefined;
  }
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
  const pipelineShape = node as { operators?: unknown; commands?: unknown };
  if (!Array.isArray(pipelineShape.operators) || !Array.isArray(pipelineShape.commands)) {
    return undefined;
  }
  if (node.operators.some((op) => op !== "|")) return undefined;
  if (node.commands.length < 2 || node.commands.length > BASH_VIEW_MAX_PIPELINE_STAGES) {
    return undefined;
  }
  const lastIndex = node.commands.length - 1;
  const last = node.commands[lastIndex];
  if (last === undefined || last.type !== "Command") return undefined;
  const lastStage = stageShape(last);
  if (!lastStage) return undefined;
  const display = parseDisplayTransform(lastStage);
  const headEnd = display === undefined ? node.commands.length : lastIndex;
  if (display !== undefined && headEnd < 1) return undefined;

  const ops: ViewOp[] = [];
  let filePath: string | undefined;
  for (let index = 0; index < headEnd; index++) {
    const child = node.commands[index];
    if (child === undefined || child.type !== "Command") return undefined;
    const stage = stageShape(child);
    if (!stage) return undefined;
    if (index === 0) {
      const source = parseSourceStage(stage);
      if (source) {
        if (source.lineNumbered === true) return undefined;
        filePath = source.filePath;
        ops.push(...source.ops);
        continue;
      }
      const searchSource = parseSearchStage(stage);
      if (searchSource?.kind !== "pureSearch") {
        return undefined;
      }
      if (searchSource.search.lineNumbered) {
        if (display !== undefined) return undefined;
        // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md D3
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
  const countAt = ops.findIndex((op) => op.kind === "count");
  if (countAt !== -1 && countAt !== ops.length - 1) return undefined;
  if (filePath === undefined) return undefined;
  if (display !== undefined) {
    if (ops.some(isContentOp)) return undefined;
    return { kind: "view", filePath, ops, display };
  }
  if (ops.length === 0) return undefined;
  return { kind: "view", filePath, ops };
}

export function classifySegment(node: Command | Pipeline, prefixPosition = false): Segment {
  if (node.type === "Command") {
    const stage = stageShape(node);
    if (!stage) return { kind: "unsafe", reason: "non-literal-command" };
    const silent = parseSilent(stage, prefixPosition);
    if (silent) return silent;
    const multiView = parseMultiViewStage(stage);
    if (multiView) return { kind: "multiView", view: multiView };
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
 * [docs/.archive_adrs/0033-bash-view-interception.md D1, amended] A `;`-separated statement chain is admitted only when
 * every boundary between adjacent statements is an unconditional `;`.
 *
 * The separator text decides: `unbash` reports a `;` and a newline as the same statement boundary,
 * so the parse alone cannot tell the sanctioned `cd dir; cat file` shape from a newline-separated
 * script. Only the `;` form is the deterministic prefix shape this decision authorises; the newline
 * form stays pass-through rather than riding in on the same parse shape.
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
 * Redundancy without a known cwd (docs/.archive_adrs/0039-compound-bash-view-interception.md D7/D9).
 * Dot-forms (relative, no `..`, normalizing to self) resolve to the base for EVERY base, so they
 * need no tracked state. An absolute target matches only a known-absolute tracked dir exactly (D9
 * lexical; the `realpath` fallback belongs to the lifecycle, which has fs access). Everything else
 * counts normally — sound because an unproven `cd` is treated as a real change, never a no-op.
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
 * Interval algebra (docs/.archive_adrs/0033-bash-view-interception.md D2): folds stream-relative slice ops over the
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
 * Content-aware fold over `(line, text)` pairs, left in stage order. Slice stages reuse the interval
 * algebra over stream positions, mapped back to entries so a multi-interval `sed -n -e` stage keeps
 * its exact shape; `keep`/`drop` narrow by literal substring. Total and pure — an empty result means
 * the caller passes through with zero leases, the same contract `applySliceOps` has.
 *
 * The fold is a `switch` over the whole union with no fall-through slice arm, so the three line-set
 * consumers are handled where they are declared and an unknown kind is refused (`assertNever`)
 * instead of silently degrading to a slice.
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
        return assertNever(op);
    }
    if (stream.length === 0) return [];
  }
  return stream;
}

/**
 * `sort -u` dedupes by text keeping the FIRST occurrence's true line — the anchor that travels with
 * the row is a real file coordinate, never a renumbered one — then orders by raw bytes, the C/POSIX
 * collation `sort` uses under `LC_ALL=C`. A host whose locale collation reorders the set
 * (case-folding, accents) folds differently, fails the whole-stdout byte gate and passes through
 * raw, never a wrong order.
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
 * `uniq` is ADJACENT-only and literal: each run of equal text collapses to its head, so the same
 * text may survive at two non-adjacent positions, each keeping its own true line. Sorting is never
 * part of it.
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
