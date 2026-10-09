import { describe, expect, it } from "vitest";
import {
  applySliceOps,
  BASH_VIEW_MAX_CHAIN_SEGMENTS,
  BASH_VIEW_MAX_PIPELINE_STAGES,
  classifyBashCommand,
  withSearchLineNumbers,
  type BashSearch,
  type BashView,
} from "../../src/bash-classifier";

function viewOf(command: string): BashView {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureView");
  if (result.kind !== "pureView") throw new Error(`not a view: ${command}`);
  return result.view;
}

function reasonOf(command: string): string {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("passThrough");
  if (result.kind !== "passThrough") throw new Error(`not pass-through: ${command}`);
  return result.reason;
}

function searchOf(command: string): BashSearch {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureSearch");
  if (result.kind !== "pureSearch") throw new Error(`not a search: ${command}`);
  return result.search;
}

describe("bash-classifier span matrix", () => {
  it("accepts bare single-file views", () => {
    expect(viewOf("cat f.txt")).toEqual({ filePath: "f.txt", ops: [] });
    expect(viewOf("cat ./sub/f.txt")).toEqual({ filePath: "./sub/f.txt", ops: [] });
    expect(viewOf("cat /abs/f.txt")).toEqual({ filePath: "/abs/f.txt", ops: [] });
    expect(viewOf('cat "my file.txt"')).toEqual({ filePath: "my file.txt", ops: [] });
    expect(viewOf("cat 'other file.txt'")).toEqual({ filePath: "other file.txt", ops: [] });
    expect(viewOf("cat '~/f.txt'")).toEqual({ filePath: "~/f.txt", ops: [] });
  });

  it("accepts head/tail selectors incl. bare shorthand and defaults", () => {
    expect(viewOf("head -20 f")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 20 }] });
    expect(viewOf("head -n 20 f")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 20 }] });
    expect(viewOf("head -n20 f")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 20 }] });
    expect(viewOf("head f")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 10 }] });
    expect(viewOf("head -n -5 f")).toEqual({ filePath: "f", ops: [{ kind: "dropLast", n: 5 }] });
    expect(viewOf("tail -5 f")).toEqual({ filePath: "f", ops: [{ kind: "last", n: 5 }] });
    expect(viewOf("tail -n 3 f")).toEqual({ filePath: "f", ops: [{ kind: "last", n: 3 }] });
    expect(viewOf("tail f")).toEqual({ filePath: "f", ops: [{ kind: "last", n: 10 }] });
    expect(viewOf("tail -n +55 f")).toEqual({ filePath: "f", ops: [{ kind: "from", n: 55 }] });
  });

  it("accepts sed -n numeric prints", () => {
    expect(viewOf("sed -n '20,128p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 20, to: 128 }],
    });
    expect(viewOf("sed -n '2p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 2, to: 2 }],
    });
    expect(viewOf("sed -n 5p f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 5, to: 5 }],
    });
  });

  it("accepts single pre-view cd and non-cd silent segments", () => {
    expect(viewOf("cd /ws && cat f.txt")).toEqual({ filePath: "f.txt", baseDir: "/ws", ops: [] });
    expect(viewOf("true && cat f")).toEqual({ filePath: "f", ops: [] });
    expect(viewOf("cat f && true")).toEqual({ filePath: "f", ops: [] });
    expect(viewOf("cd sub && : && cat f")).toEqual({ filePath: "f", baseDir: "sub", ops: [] });
    expect(viewOf(": && head -5 f")).toEqual({
      filePath: "f",
      ops: [{ kind: "first", n: 5 }],
    });
  });

  it("accepts `;`-chained silent prefixes before the view", () => {
    expect(viewOf("cd dir; cat file")).toEqual({ filePath: "file", baseDir: "dir", ops: [] });
    expect(viewOf("cd /ws; cat f.txt")).toEqual({ filePath: "f.txt", baseDir: "/ws", ops: [] });
    expect(viewOf("pwd; cat file")).toEqual({ filePath: "file", ops: [] });
    expect(viewOf("cd dir; pwd; cat file")).toEqual({ filePath: "file", baseDir: "dir", ops: [] });
    expect(viewOf("true; :; cat f")).toEqual({ filePath: "f", ops: [] });
    expect(viewOf("cd var/log; tail -20 app.log")).toEqual({
      filePath: "app.log",
      baseDir: "var/log",
      ops: [{ kind: "last", n: 20 }],
    });
    expect(viewOf("cd sub; cat f | head -3")).toEqual({
      filePath: "f",
      baseDir: "sub",
      ops: [{ kind: "first", n: 3 }],
    });
    expect(viewOf("cd sub; cat f && true")).toEqual({ filePath: "f", baseDir: "sub", ops: [] });
  });

  it("fails closed on post-view and multi-cd chains (D1 order-soundness)", () => {
    // WHY: bash resolves each `cd` against the directory in effect at that point:
    // WHY: `cat f && cd sub` viewed `./f` (the `cd` ran too late), and
    // WHY: `cd a && cd b && cat f` viewed `a/b/f` (chained `cd`s compose) — so a
    // WHY: single out-of-order `baseDir` would lease a path never viewed.
    expect(reasonOf("cat f.txt && cd sub")).toBe("post-view-cd");
    expect(reasonOf("cd a && cd b && cat f")).toBe("multi-cd");
    expect(reasonOf("cd sub && cd .. && cat f")).toBe("multi-cd");
    expect(reasonOf("cat f && cd sub && cat g")).toBe("post-view-cd");
  });

  it("accepts sanctioned single-pipe filters", () => {
    expect(viewOf("cat f | head -20")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 20 }] });
    expect(viewOf("cat f | head -n20 | tail -5")).toEqual({
      filePath: "f",
      ops: [
        { kind: "first", n: 20 },
        { kind: "last", n: 5 },
      ],
    });
    expect(viewOf("cat f | sed -n '3,7p' | head -n2")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 3, to: 7 },
        { kind: "first", n: 2 },
      ],
    });
    expect(viewOf("head -n 30 f | tail -5")).toEqual({
      filePath: "f",
      ops: [
        { kind: "first", n: 30 },
        { kind: "last", n: 5 },
      ],
    });
    expect(viewOf("cat f | head")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 10 }] });
  });
});

describe("bash-classifier fail-closed matrix", () => {
  it("passes through commands with no view", () => {
    expect(reasonOf("")).toBe("empty");
    expect(reasonOf("   ")).toBe("empty");
    expect(reasonOf("echo hi")).toBe("unsupported-command:echo");
    expect(reasonOf("make build")).toBe("unsupported-command:make");
    expect(reasonOf("not((valid")).toBe("parse-error");
    expect(reasonOf("cat f; cat g")).toBe("multi-statement");
    expect(reasonOf("cat f || cat g")).toBe("non-and-chain");
    expect(reasonOf("cat f &")).toBe("background");
    expect(reasonOf("VAR=x cat f")).toBe("non-literal-command");
    expect(reasonOf("sudo cat f")).toBe("unsupported-command:sudo");
    expect(reasonOf("time cat f")).toBe("compound-top");
    expect(reasonOf("! cat f")).toBe("compound-top");
  });

  it("passes through unsafe chain segments", () => {
    expect(reasonOf("echo hi && cat f")).toBe("unsupported-command:echo");
    expect(reasonOf("make && cat f")).toBe("unsupported-command:make");
    expect(reasonOf("cat f && echo done")).toBe("unsupported-command:echo");
    expect(reasonOf("cd /x && grep -r foo . && cat f")).toBe("unsupported-command:grep");
    expect(reasonOf("cd -")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -- && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -P && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd")).toBe("unsupported-command:cd");
    expect(reasonOf("cd /x && cd - && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cat a && cat b")).toBe("multi-view");
  });

  it("fails closed on non-silent or non-deterministic `;` chains", () => {
    // WHY: only a strictly silent prefix is admitted; a view, an unknown
    // WHY: command, a background job, or a non-literal `cd` in prefix position
    // WHY: is not the deterministic shape this decision authorises.
    expect(reasonOf("cat f; cat g")).toBe("multi-statement");
    expect(reasonOf("cat f; cd sub")).toBe("multi-statement");
    expect(reasonOf("echo hi; cat f")).toBe("unsupported-command:echo");
    expect(reasonOf("cd a; cd b; cat f")).toBe("multi-cd");
    expect(reasonOf("cd $D; cat f")).toBe("non-literal-command");
    // WHY: `cd --`/`cd -P` consume the word as an option and cd to `$HOME`,
    // WHY: so it must never become a `baseDir` (ADR-0033 D1 order-soundness).
    expect(reasonOf("cd --; cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -P; cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd d; cat f &")).toBe("background");
    // WHY: the search branch inherits the `;` chain ruling verbatim (see the search matrix
    // WHY: below): a silent prefix plus a terminal search is the same deterministic shape as
    // WHY: `cd d; cat f`, so it is admitted rather than denied.
    expect(searchOf("cd d; grep -n x f").baseDir).toBe("d");
    // WHY: `unbash` reports `;` and a newline as the same statement boundary, so
    // WHY: the separator text is what keeps a newline script out of the gate.
    expect(reasonOf("cd d\ncat f")).toBe("multi-statement");
    expect(reasonOf("cd d & cat f")).toBe("multi-statement");
  });

  it("keeps the silent set closed outside prefix position", () => {
    // WHY: `pwd` is admitted only as a `;`-chain prefix — a bare `pwd` or an
    // WHY: `&&` chain keeps exactly the R3 silent set.
    expect(reasonOf("pwd")).toBe("unsupported-command:pwd");
    expect(reasonOf("pwd && cat f")).toBe("unsupported-command:pwd");
    expect(reasonOf("cd d && pwd && cat f")).toBe("unsupported-command:pwd");
  });

  it("passes through flag hazards (R4)", () => {
    expect(reasonOf("cat -A f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -n f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -v f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat")).toBe("unsupported-command:cat");
    expect(reasonOf("head -c 20 f")).toBe("unsupported-command:head");
    expect(reasonOf("tail -c 20 f")).toBe("unsupported-command:tail");
    expect(reasonOf("tail -f f")).toBe("unsupported-command:tail");
    expect(reasonOf("tail -F f")).toBe("unsupported-command:tail");
    expect(reasonOf("head -z f")).toBe("unsupported-command:head");
    expect(reasonOf("head --lines=5 f")).toBe("unsupported-command:head");
    expect(reasonOf("head -n 0 f")).toBe("unsupported-command:head");
    expect(reasonOf("head -0 f")).toBe("unsupported-command:head");
    expect(reasonOf("tail -n -5 f")).toBe("unsupported-command:tail");
    expect(reasonOf("head -n +5 f")).toBe("unsupported-command:head");
  });

  it("passes through sed hazards (R4)", () => {
    expect(reasonOf("sed -i 's/a/b/' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n 's/a/b/p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '/re/p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '1,5w out' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '1,5d' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -e '5p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '5p' -e '6p' f")).toBe("unsupported-command:sed");
  });

  it("passes through search and transform pipelines", () => {
    expect(searchOf("grep -n pat f").program).toBe("grep");
    // WHY: `rg pat` has no file operand (it would search the cwd recursively), so the search
    // WHY: selector refuses it and the segment falls through to the unsupported-command reason.
    expect(reasonOf("rg pat")).toBe("unsupported-command:rg");
    expect(reasonOf("cat f | grep x")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | sort | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | grep x | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | head -5 | grep x")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | head -5 | cat")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f |& head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat a b | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat a b")).toBe("unsupported-command:cat");
    expect(reasonOf("paste a b")).toBe("unsupported-command:paste");
  });

  it("passes through expansion, glob, redirect, and substitution shapes", () => {
    expect(reasonOf("cat *.txt")).toBe("non-literal-command");
    expect(reasonOf("cat f?.txt")).toBe("non-literal-command");
    expect(reasonOf("cat $F")).toBe("non-literal-command");
    expect(reasonOf("cat ~/f.txt")).toBe("non-literal-command");
    expect(reasonOf("cat ~/")).toBe("non-literal-command");
    expect(reasonOf("cat ''")).toBe("non-literal-command");
    expect(reasonOf("cat $(ls)")).toBe("non-literal-command");
    expect(reasonOf("cat `ls`")).toBe("non-literal-command");
    expect(reasonOf('cat "a$b"')).toBe("non-literal-command");
    expect(reasonOf("head -5")).toBe("unsupported-command:head");
    expect(reasonOf("cat f | head -5 f")).toBe("unsupported-pipeline");
    expect(reasonOf("head f -n 5")).toBe("unsupported-command:head");
  });

  it("passes through over-depth chains and pipelines", () => {
    const deepPipe = `cat f${" | head -5".repeat(BASH_VIEW_MAX_PIPELINE_STAGES)}`;
    expect(reasonOf(deepPipe)).toBe("unsupported-pipeline");
    const longChain = `${"true && ".repeat(BASH_VIEW_MAX_CHAIN_SEGMENTS)}cat f`;
    expect(reasonOf(longChain)).toBe("chain-too-long");
    const longStatementChain = `${`true; `.repeat(BASH_VIEW_MAX_CHAIN_SEGMENTS)}cat f`;
    expect(reasonOf(longStatementChain)).toBe("chain-too-long");
  });
});

describe("bash-classifier search matrix (I1a)", () => {
  it("accepts single-file grep/rg searches over the allowlisted flags", () => {
    expect(searchOf("grep pattern f.ts")).toEqual({
      program: "grep",
      pattern: "pattern",
      filePath: "f.ts",
      lineNumbered: false,
    });
    expect(searchOf("grep -n pattern f.ts")).toEqual({
      program: "grep",
      pattern: "pattern",
      filePath: "f.ts",
      lineNumbered: true,
    });
    expect(searchOf("grep --line-number pattern f.ts").lineNumbered).toBe(true);
    expect(searchOf("grep -i -F -E pattern f.ts")).toEqual({
      program: "grep",
      pattern: "pattern",
      filePath: "f.ts",
      lineNumbered: false,
    });
    expect(searchOf("rg pattern f.ts")).toEqual({
      program: "rg",
      pattern: "pattern",
      filePath: "f.ts",
      lineNumbered: false,
    });
    expect(searchOf("rg -n -i pattern f.ts").lineNumbered).toBe(true);
    expect(searchOf('grep "a b" f.ts').pattern).toBe("a b");
    expect(searchOf("grep 'a b' f.ts").pattern).toBe("a b");
    // WHY: a `-`-leading pattern is legal only behind the `--` separator (spec §3.3).
    expect(searchOf("grep -- -pat f.ts")).toEqual({
      program: "grep",
      pattern: "-pat",
      filePath: "f.ts",
      lineNumbered: false,
    });
    expect(searchOf("grep pattern /abs/f.ts").filePath).toBe("/abs/f.ts");
    expect(searchOf("cd sub && grep x f").baseDir).toBe("sub");
  });

  it("denies every non-allowlisted grep flag", () => {
    const denied = [
      "grep -c pat f",
      "grep --count pat f",
      "grep -v pat f",
      "grep --invert-match pat f",
      "grep -o pat f",
      "grep --only-matching pat f",
      "grep -A 2 pat f",
      "grep -B 2 pat f",
      "grep -C 2 pat f",
      "grep -l pat f",
      "grep -L pat f",
      "grep --color=never pat f",
      "grep -m 3 pat f",
      "grep --max-count 3 pat f",
      "grep -q pat f",
      "grep -s pat f",
      "grep -w pat f",
      "grep -x pat f",
      "grep -b pat f",
      "grep -H pat f",
      "grep -h pat f",
      "grep -r pat f",
      "grep -R pat f",
      "grep -P pat f",
      "grep -e pat f",
      "grep -f pats f",
      "grep -in pat f",
      "grep -n5 pat f",
      "grep --line-number=x pat f",
      "grep pat -i f",
    ];
    for (const command of denied) expect(reasonOf(command)).toBe("unsupported-command:grep");
  });

  it("denies every non-allowlisted rg flag", () => {
    const denied = [
      "rg --column pat f",
      "rg --heading pat f",
      "rg --no-heading pat f",
      "rg -N pat f",
      "rg --no-line-number pat f",
      "rg --json pat f",
      "rg --stats pat f",
      "rg --files",
      "rg -r x pat f",
      "rg --replace x pat f",
      "rg -0 pat f",
      "rg --null pat f",
      "rg --vimgrep pat f",
      "rg -uu pat f",
      "rg -t ts pat f",
      "rg -j 4 pat f",
      "rg --hidden pat f",
      "rg -g '*.ts' pat f",
      "rg pat -i f",
    ];
    for (const command of denied) expect(reasonOf(command)).toBe("unsupported-command:rg");
  });

  it("denies structural shapes, globs, and non-single-file operands", () => {
    // WHY: zero or two-plus operands break the `^(\\d+):` stdout geometry (stdin search, or
    // WHY: filename prefixes), so only exactly one file operand is admitted.
    expect(reasonOf("grep")).toBe("unsupported-command:grep");
    expect(reasonOf("grep pat")).toBe("unsupported-command:grep");
    expect(reasonOf("grep pat a.ts b.ts")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -n pat a.ts b.ts")).toBe("unsupported-command:grep");
    expect(reasonOf("rg pat")).toBe("unsupported-command:rg");
    expect(reasonOf("rg pat a.ts b.ts")).toBe("unsupported-command:rg");
    // WHY: globs, tildes and expansions never reach the selector — `stageShape` refuses them.
    expect(reasonOf("grep pat *.ts")).toBe("non-literal-command");
    expect(reasonOf("grep pat ~/f.ts")).toBe("non-literal-command");
    expect(reasonOf("grep $P f")).toBe("non-literal-command");
    expect(reasonOf("grep $(cat p) f")).toBe("non-literal-command");
    // WHY: structural shapes (spec §3.2): pipelines, redirections, subshells, compounds, jobs.
    expect(reasonOf("grep pat f | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | grep x")).toBe("unsupported-pipeline");
    expect(reasonOf("grep pat f > out.txt")).toBe("non-literal-command");
    expect(reasonOf("grep pat f && cat g")).toBe("multi-view");
    expect(reasonOf("grep pat f || cat g")).toBe("non-and-chain");
    expect(reasonOf("grep pat f &")).toBe("background");
    expect(reasonOf("grep pat f; cat g")).toBe("multi-statement");
    // WHY: a search chained with a view breaks the exactly-one-target rule, exactly as two views do.
    expect(reasonOf("grep pat f && head -2 g")).toBe("multi-view");
    expect(reasonOf("cd d && grep -r x .")).toBe("unsupported-command:grep");
  });
});

describe("withSearchLineNumbers injection (I1a)", () => {
  it("injects the line-number flag after the program name, before any `--`", () => {
    expect(withSearchLineNumbers("grep 'function' src/app.ts")).toBe(
      "grep -n 'function' src/app.ts",
    );
    expect(withSearchLineNumbers("grep -- -pat f")).toBe("grep -n -- -pat f");
    expect(withSearchLineNumbers("rg pat f")).toBe("rg --line-number pat f");
    expect(withSearchLineNumbers("cd sub; grep x f")).toBe("cd sub; grep -n x f");
    expect(withSearchLineNumbers("cd sub && rg -F x f")).toBe("cd sub && rg --line-number -F x f");
    expect(withSearchLineNumbers("grep   -i  pat   f")).toBe("grep -n   -i  pat   f");
  });

  it("leaves an already-numbered search byte-identical", () => {
    expect(withSearchLineNumbers("grep -n pat f")).toBe("grep -n pat f");
    expect(withSearchLineNumbers("grep --line-number pat f")).toBe("grep --line-number pat f");
    expect(withSearchLineNumbers("rg --line-number pat f")).toBe("rg --line-number pat f");
  });

  it("leaves every denied or non-search command byte-identical", () => {
    const untouched = [
      "",
      "   ",
      "cat f.txt",
      "grep -c pat f",
      "grep -r pat .",
      "grep -in pat f",
      "grep pat",
      "grep pat a.ts b.ts",
      "grep pat f | head -5",
      "grep pat f > out.txt",
      "grep pat f && cat g",
      "grep pat *.ts",
      "cat f | grep x",
      "rg --json pat f",
      "echo hi",
    ];
    for (const command of untouched) expect(withSearchLineNumbers(command)).toBe(command);
  });
});

describe("applySliceOps interval algebra", () => {
  it("folds head/tail/range compositions exactly", () => {
    expect(applySliceOps([{ kind: "first", n: 20 }], 100)).toEqual([{ lo: 1, hi: 20 }]);
    expect(
      applySliceOps(
        [
          { kind: "first", n: 20 },
          { kind: "last", n: 5 },
        ],
        100,
      ),
    ).toEqual([{ lo: 16, hi: 20 }]);
    expect(
      applySliceOps(
        [
          { kind: "range", from: 3, to: 7 },
          { kind: "first", n: 2 },
        ],
        100,
      ),
    ).toEqual([{ lo: 3, hi: 4 }]);
    expect(applySliceOps([{ kind: "range", from: 20, to: 128 }], 30)).toEqual([{ lo: 20, hi: 30 }]);
    expect(applySliceOps([{ kind: "from", n: 55 }], 60)).toEqual([{ lo: 55, hi: 60 }]);
    expect(applySliceOps([{ kind: "dropLast", n: 5 }], 100)).toEqual([{ lo: 1, hi: 95 }]);
    expect(applySliceOps([{ kind: "last", n: 10 }], 100)).toEqual([{ lo: 91, hi: 100 }]);
  });

  it("clamps and empties without errors", () => {
    expect(applySliceOps([{ kind: "first", n: 20 }], 5)).toEqual([{ lo: 1, hi: 5 }]);
    expect(applySliceOps([{ kind: "range", from: 128, to: 20 }], 200)).toEqual([]);
    expect(applySliceOps([{ kind: "range", from: 0, to: 0 }], 200)).toEqual([]);
    expect(applySliceOps([{ kind: "from", n: 500 }], 100)).toEqual([]);
    expect(applySliceOps([{ kind: "first", n: 5 }], 0)).toEqual([]);
    expect(applySliceOps([], 100)).toEqual([{ lo: 1, hi: 100 }]);
  });

  it("keeps multi-interval runs disjoint and ordered", () => {
    const ops = [
      { kind: "range", from: 10, to: 20 },
      { kind: "first", n: 4 },
    ] as const;
    expect(applySliceOps([...ops], 100)).toEqual([{ lo: 10, hi: 13 }]);
  });
});
