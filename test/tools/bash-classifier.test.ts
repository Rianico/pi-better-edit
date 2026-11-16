import { describe, expect, it } from "vitest";
import {
  applySliceOps,
  applyViewOps,
  BASH_VIEW_MAX_CHAIN_SEGMENTS,
  BASH_VIEW_MAX_PIPELINE_STAGES,
  classifyBashCommand,
  withSearchLineNumbers,
  type BashSearch,
  type BashView,
  type ViewOp,
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

function multiOf(command: string) {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureMultiSearch");
  if (result.kind !== "pureMultiSearch") throw new Error(`not a multi search: ${command}`);
  return result.search;
}

function recursiveOf(command: string) {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureRecursiveSearch");
  if (result.kind !== "pureRecursiveSearch") throw new Error(`not a recursive search: ${command}`);
  return result.search;
}

function filesOf(command: string) {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureFilesList");
  if (result.kind !== "pureFilesList") throw new Error(`not a file list: ${command}`);
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

import type { BashClass } from "../../src/bash-classifier";

function compoundOf(command: string): Extract<BashClass, { kind: "pureCompound" }> {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureCompound");
  if (result.kind !== "pureCompound") throw new Error(`not a compound: ${command}`);
  return result;
}

describe("bash-classifier compound glue segments", () => {
  it("still declines lone prints and glue-only chains", () => {
    expect(reasonOf('printf "hi"')).toBe("unsupported-command:printf");
    expect(reasonOf("export A=b")).toBe("non-literal-command");
    expect(reasonOf("set -e")).toBe("unsupported-command:set");
    expect(reasonOf("printf a; printf b")).toBe("no-view");
    expect(reasonOf("echo hi; echo bye")).toBe("no-view");
  });
  it("admits print and env glue beside a view, with parse-time expected bytes", () => {
    expect(compoundOf('printf "hi\\n" && cat f')).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "printf", expectedText: "hi\n", expectedBytes: 3 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
    expect(compoundOf("export A=b && cat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "export", expectedText: "", expectedBytes: 0 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
    expect(compoundOf("set -e; cat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "set", expectedText: "", expectedBytes: 0 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
    expect(compoundOf('echo "a*b" && cat f')).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "a*b\n", expectedBytes: 4 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
  });
  it("fails closed on dynamic, flagged, or converting print forms", () => {
    expect(reasonOf('echo "a$b" && cat f')).toBe("non-literal-command");
    expect(reasonOf('echo -n "hi" && cat f')).toBe("unsupported-command:echo");
    expect(reasonOf('printf "%s" hi && cat f')).toBe("unsupported-command:printf");
  });
  it("numbers an unnumbered search inside a compound, leaving the rest alone", () => {
    expect(withSearchLineNumbers("echo hi && grep x f")).toBe("echo hi && grep -n x f");
    expect(withSearchLineNumbers("echo hi; grep x f")).toBe("echo hi; grep -n x f");
    expect(withSearchLineNumbers("export A=b && rg -F x f")).toBe(
      "export A=b && rg --line-number -F x f",
    );
    expect(withSearchLineNumbers("set -e; grep x f")).toBe("set -e; grep -n x f");
    expect(withSearchLineNumbers("cat f && echo done")).toBe("cat f && echo done");
    expect(withSearchLineNumbers("echo hi && grep -n x f")).toBe("echo hi && grep -n x f");
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

  it("fails closed on compound AndOr operands without crashing", () => {
    for (const command of [
      "cd . && for f in a; do echo $f; done",
      "cd . && if true; then cat f; fi",
      "cd . && while false; do :; done",
      "cd . && time cat f",
      "cd . && { cat f; }",
      "cd . && (cat f)",
      "cd . && case x in x) cat f;; esac",
      "cd . && f() { cat f; }; f",
      "[[ -f f ]] && cat f",
      "for f in a; do echo $f; done && echo done",
      "cd . && true && for f in a; do echo $f; done",
    ]) {
      expect(() => classifyBashCommand(command)).not.toThrow();
      expect(reasonOf(command)).toBe("compound-andor-operand");
    }
    expect(viewOf("cd sub && cat f").filePath).toBe("f");
    expect(reasonOf("cat f && cat g")).toBe("multi-view");
  });

  it("passes through unsafe chain segments", () => {
    expect(compoundOf("echo hi && cat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
    expect(reasonOf("make && cat f")).toBe("unsupported-command:make");
    expect(compoundOf("cat f && echo done")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "view", filePath: "f", ops: [] },
        { kind: "glue", glue: { program: "echo", expectedText: "done\n", expectedBytes: 5 } },
      ],
    });
    expect(reasonOf("cd /x && grep -r foo . && cat f")).toBe("multi-view");
    expect(reasonOf("cd -")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -- && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -P && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd")).toBe("unsupported-command:cd");
    expect(reasonOf("cd /x && cd - && cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cat a && cat b")).toBe("multi-view");
  });

  it("fails closed on non-silent or non-deterministic `;` chains", () => {
    expect(reasonOf("cat f; cat g")).toBe("multi-statement");
    expect(reasonOf("cat f; cd sub")).toBe("multi-statement");
    expect(compoundOf("echo hi; cat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
    });
    expect(reasonOf("cd a; cd b; cat f")).toBe("multi-cd");
    expect(reasonOf("cd $D; cat f")).toBe("non-literal-command");
    expect(reasonOf("cd --; cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd -P; cat f")).toBe("unsupported-command:cd");
    expect(reasonOf("cd d; cat f &")).toBe("background");
    expect(searchOf("cd d; grep -n x f").baseDir).toBe("d");
    expect(reasonOf("cd d\ncat f")).toBe("multi-statement");
    expect(reasonOf("cd d & cat f")).toBe("multi-statement");
  });

  it("keeps the silent set closed outside prefix position", () => {
    expect(reasonOf("pwd")).toBe("unsupported-command:pwd");
    expect(reasonOf("pwd && cat f")).toBe("unsupported-command:pwd");
    expect(reasonOf("cd d && pwd && cat f")).toBe("unsupported-command:pwd");
  });

  it("passes through flag hazards (R4)", () => {
    expect(reasonOf("cat -A f")).toBe("unsupported-command:cat");
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
    expect(reasonOf("rg pat")).toBe("unsupported-command:rg");
    expect(reasonOf("cat f | sort | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | head -5 | cat")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f |& head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat a b | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat a b -A")).toBe("unsupported-command:cat");
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
    expect(searchOf("grep -- -pat f.ts")).toEqual({
      program: "grep",
      pattern: "-pat",
      filePath: "f.ts",
      lineNumbered: false,
    });
    expect(searchOf("grep pattern /abs/f.ts").filePath).toBe("/abs/f.ts");
    expect(searchOf("cd sub && grep x f").baseDir).toBe("sub");
  });
  it("accepts the five Tier-1 flag shapes (spec §3.2 expansion)", () => {
    expect(searchOf("grep -w pat f").lineNumbered).toBe(false);
    expect(searchOf("grep --word-regexp pat f").pattern).toBe("pat");
    expect(searchOf("grep -x pat f").filePath).toBe("f");
    expect(searchOf("grep --line-regexp pat f").program).toBe("grep");
    expect(searchOf("grep -m 3 pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep --max-count=3 pat f").pattern).toBe("pat");
    expect(searchOf("rg -m 1 pat f").program).toBe("rg");
    expect(searchOf("grep -in pat f").lineNumbered).toBe(true);
    expect(searchOf("grep -iF pat f").lineNumbered).toBe(false);
    expect(searchOf("grep -wF pat f").pattern).toBe("pat");
    expect(searchOf("grep -nw pat f").lineNumbered).toBe(true);
    expect(searchOf("grep -nm 3 pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
    });
    expect(searchOf("grep pat -i f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep pat f -n").lineNumbered).toBe(true);
    expect(searchOf("rg pat -i f").program).toBe("rg");
    expect(searchOf("grep pat f -w").filePath).toBe("f");
    expect(searchOf("grep pat -- -n")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "-n",
      lineNumbered: false,
    });
    expect(searchOf("grep --color=never pat f").lineNumbered).toBe(false);
    expect(searchOf("grep --colour=never pat f").pattern).toBe("pat");
    expect(searchOf("rg --color=never pat f").program).toBe("rg");
  });

  it("fails closed on malformed values, attached short values and unknown cluster letters", () => {
    for (const command of [
      "grep -m0 pat f",
      "grep -m 0 pat f",
      "grep -m -1 pat f",
      "grep -m abc pat f",
      "grep -m pat f",
      "grep --max-count=0 pat f",
      "grep --max-count= pat f",
      "grep --max-count pat f",
      "grep -m3 pat f",
      "grep -nm3 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
    for (const command of [
      "grep -n5 pat f",
      "grep -inQ pat f",
      "grep --line-number=x pat f",
      "grep -mw pat f",
      "grep -x5 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
    for (const command of [
      "grep --color pat f",
      "grep --color=always pat f",
      "grep --color=auto pat f",
      "grep --colour pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("denies every non-allowlisted grep flag", () => {
    const denied = [
      "grep -c pat f",
      "grep --count pat f",
      "grep -v pat f",
      "grep --invert-match pat f",
      "grep -o pat f",
      "grep --only-matching pat f",
      "grep -l pat f",
      "grep -L pat f",
      "grep --max-count 3 pat f",
      "grep -q pat f",
      "grep -s pat f",
      "grep -b pat f",
      "grep -H pat f",
      "grep -h pat f",
      "grep -P pat f",
      "grep -f pats f",
      "grep -n5 pat f",
      "grep --line-number=x pat f",
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
    ];
    for (const command of denied) expect(reasonOf(command)).toBe("unsupported-command:rg");
  });
  it("denies attached context flags, filename/formatting flags, and a non-literal operand", () => {
    expect(reasonOf("grep -A2 pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -B3 pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -C1 pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep --with-filename pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep --no-filename pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep --color pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep --color=auto pat f")).toBe("unsupported-command:grep");
    expect(reasonOf("grep `cmd` f")).toBe("non-literal-command");
    expect(reasonOf("rg -A2 pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --with-filename pat f")).toBe("unsupported-command:rg");
    expect(searchOf("grep -n pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
    });
  });

  it("denies structural shapes, globs, and non-single-file operands", () => {
    expect(reasonOf("grep")).toBe("unsupported-command:grep");
    expect(reasonOf("grep pat")).toBe("unsupported-command:grep");
    expect(reasonOf("rg pat")).toBe("unsupported-command:rg");
    expect(reasonOf("grep pat *.ts")).toBe("non-literal-command");
    expect(reasonOf("grep pat ~/f.ts")).toBe("non-literal-command");
    expect(reasonOf("grep $P f")).toBe("non-literal-command");
    expect(reasonOf("grep $(cat p) f")).toBe("non-literal-command");
    expect(reasonOf("grep pat f > out.txt")).toBe("non-literal-command");
    expect(reasonOf("grep pat f && cat g")).toBe("multi-view");
    expect(reasonOf("grep pat f || cat g")).toBe("non-and-chain");
    expect(reasonOf("grep pat f &")).toBe("background");
    expect(reasonOf("grep pat f; cat g")).toBe("multi-statement");
    expect(reasonOf("grep pat f && head -2 g")).toBe("multi-view");
    expect(recursiveOf("cd d && grep -r x .").baseDir).toBe("d");
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
    expect(withSearchLineNumbers("grep -in pat f")).toBe("grep -in pat f");
    expect(withSearchLineNumbers("grep -nm 3 pat f")).toBe("grep -nm 3 pat f");
    expect(withSearchLineNumbers("grep pat f -n")).toBe("grep pat f -n");
  });

  it("rewrites the Tier-1 flag shapes with the line-number flag after the program name", () => {
    expect(withSearchLineNumbers("grep pat -i f")).toBe("grep -n pat -i f");
    expect(withSearchLineNumbers("grep pat f -n")).toBe("grep pat f -n");
    expect(withSearchLineNumbers("grep -w pat f")).toBe("grep -n -w pat f");
    expect(withSearchLineNumbers("grep -m 3 pat f")).toBe("grep -n -m 3 pat f");
    expect(withSearchLineNumbers("grep --max-count=3 pat f")).toBe("grep -n --max-count=3 pat f");
    expect(withSearchLineNumbers("grep --color=never pat f")).toBe("grep -n --color=never pat f");
    expect(withSearchLineNumbers("rg -w pat f")).toBe("rg --line-number -w pat f");
    expect(withSearchLineNumbers("grep pat -- -n")).toBe("grep -n pat -- -n");
    expect(withSearchLineNumbers("grep -in pat f")).toBe("grep -in pat f");
    expect(withSearchLineNumbers("grep -nm 3 pat f")).toBe("grep -nm 3 pat f");
  });

  it("leaves every denied or non-search command byte-identical", () => {
    const untouched = [
      "",
      "   ",
      "cat f.txt",
      "grep -c pat f",
      "grep pat",
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

describe("bash-classifier search -e matrix (Tier-2 item 6)", () => {
  it("admits separate `-e PAT` in every flag position", () => {
    expect(searchOf("grep -e pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("rg -e pat f")).toEqual({
      program: "rg",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -i -e pat f").pattern).toBe("pat");
    expect(searchOf("grep -e pat -i f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -i f -e pat")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -e -pat f")).toEqual({
      program: "grep",
      pattern: "-pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -e -n f")).toEqual({
      program: "grep",
      pattern: "-n",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -e pat -- -n")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "-n",
      lineNumbered: false,
    });
  });

  it("admits attached `-ePAT` without decomposing the pattern letters", () => {
    expect(searchOf("grep -epat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("rg -epat f").program).toBe("rg");
    expect(searchOf("grep -e-pat f").pattern).toBe("-pat");
    expect(searchOf("grep -i -epat f").pattern).toBe("pat");
    expect(searchOf("grep -epat -i f").filePath).toBe("f");
  });

  it("admits cluster-close `-e` mirroring `-m` (must close, consumes next)", () => {
    expect(searchOf("grep -ine pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
    });
    expect(searchOf("grep -ne pat f").lineNumbered).toBe(true);
    expect(searchOf("grep -ie pat f").pattern).toBe("pat");
    expect(searchOf("rg -ine pat f").program).toBe("rg");
  });

  it("admits the `-e` + `-m` interplay (each value-taker consumes exactly one argument)", () => {
    expect(searchOf("grep -e pat -m 3 f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
    });
    expect(searchOf("grep -m 3 -e pat f").pattern).toBe("pat");
    expect(searchOf("grep -nm 3 -e pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
    });
    expect(searchOf("grep -ine pat -m 3 f").pattern).toBe("pat");
    expect(searchOf("rg -m 1 -e pat f").program).toBe("rg");
  });

  it("fails closed on missing `-e` values in every spelling", () => {
    for (const command of [
      "grep -e",
      "grep -e pat",
      "grep pat f -e",
      "grep -m 3 -e",
      "grep -ine",
      "grep -ine pat",
      "rg -e",
    ]) {
      expect(reasonOf(command)).toBe(
        command.startsWith("rg") ? "unsupported-command:rg" : "unsupported-command:grep",
      );
    }
  });

  it("fails closed on doubled `-e` and on pattern-both-ways", () => {
    for (const command of [
      "grep -e a -e b f",
      "grep -ea -eb f",
      "grep -e a -eb f",
      "grep -ea -e b f",
      "grep -e pat -e pat f",
      "grep -ine a -e b f",
      "grep -ine a -ine b f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("fails closed on `-e`-as-cluster misreadings and `-e`+`-m` collisions", () => {
    for (const command of [
      "grep -me pat f",
      "grep -iem pat f",
      "grep -e pat -m 0 f",
      "grep -e pat -m3 f",
      "grep -e pat -nm3 f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("keeps `-f` denied in every spelling", () => {
    for (const command of ["grep -f pats f", "grep -ffoo f", "grep --file=x f", "rg -f pats f"]) {
      expect(reasonOf(command)).toBe(
        command.startsWith("rg") ? "unsupported-command:rg" : "unsupported-command:grep",
      );
    }
  });

  it("rewrites `-e` searches with the line-number splice after the program name", () => {
    expect(withSearchLineNumbers("grep -e pat f")).toBe("grep -n -e pat f");
    expect(withSearchLineNumbers("grep -epat f")).toBe("grep -n -epat f");
    expect(withSearchLineNumbers("grep -e pat -m 3 f")).toBe("grep -n -e pat -m 3 f");
    expect(withSearchLineNumbers("grep -ne pat f")).toBe("grep -ne pat f");
    expect(withSearchLineNumbers("grep -ine pat f")).toBe("grep -ine pat f");
    expect(withSearchLineNumbers("grep -e -n f")).toBe("grep -n -e -n f");
    expect(withSearchLineNumbers("grep -e a -e b f")).toBe("grep -e a -e b f");
  });
});

describe("bash-classifier sed multi-range -e matrix (Tier-2 item 7)", () => {
  it("admits -n -e RANGEp [-e RANGEp …] and merges at parse", () => {
    expect(viewOf("sed -n -e '1p' -e '10p' f")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 1, to: 1 },
        { kind: "range", from: 10, to: 10 },
      ],
    });
    expect(viewOf("sed -n -e '1,5p' -e '3,7p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 1, to: 7 }],
    });
    expect(viewOf("sed -n -e '1,3p' -e '4,5p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 1, to: 5 }],
    });
    expect(viewOf("sed -n -e '10,12p' -e '1,2p' f")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 1, to: 2 },
        { kind: "range", from: 10, to: 12 },
      ],
    });
    expect(viewOf("sed -n -e '2p' -e '2p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 2, to: 2 }],
    });
    expect(viewOf("sed -n -e '1,10p' -e '3,4p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 1, to: 10 }],
    });
    expect(viewOf("sed -n -e '1,2p' -e '5,6p' -e '3,4p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 1, to: 6 }],
    });
    expect(viewOf("sed -n -e '5p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 5, to: 5 }],
    });
    expect(viewOf("sed -n '20,128p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 20, to: 128 }],
    });
    expect(viewOf("sed -n 5p f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 5, to: 5 }],
    });
    expect(viewOf("cat f | sed -n -e '3,7p' -e '5,9p'")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 3, to: 9 }],
    });
  });

  it("fails the whole stage closed on any unparseable spec (never partial)", () => {
    expect(reasonOf("sed -n -e '1p' -e 's/a/b/p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e '/re/p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e '1,5w out' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e '1,5d' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '10,1p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '10,1p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '5p' -e '10,1p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p;2p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '1p;2p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n '5p' -e '6p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' f -e '2p'")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e 'oops' f g")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -e '2p' f g -e '3p'")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -e '1p' -e '2p' f")).toBe("unsupported-command:sed");
    expect(reasonOf("sed -n -e '1p' -- f")).toBe("unsupported-command:sed");
    expect(reasonOf("cat f | sed -n -e '1p' -e 'oops'")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | sed -n -e '9,2p'")).toBe("unsupported-pipeline");
  });
});

describe("bash-classifier numbered viewers (Tier-2 item 8)", () => {
  it("admits exactly `cat -n FILE` with the numbered marker", () => {
    expect(viewOf("cat -n f.txt")).toMatchObject({
      filePath: "f.txt",
      ops: [],
      lineNumbered: true,
    });
    expect(viewOf("cat -n ./sub/f.txt")).toMatchObject({
      filePath: "./sub/f.txt",
      lineNumbered: true,
    });
    expect(viewOf('cat -n "my file.txt"')).toMatchObject({
      filePath: "my file.txt",
      lineNumbered: true,
    });
    expect(viewOf("cd sub && cat -n f.txt")).toMatchObject({
      filePath: "f.txt",
      baseDir: "sub",
      lineNumbered: true,
    });
    expect(viewOf("cat f.txt")).toEqual({ filePath: "f.txt", ops: [] });
  });

  it("admits exactly `nl -ba FILE` with the same marker", () => {
    expect(viewOf("nl -ba f.txt")).toMatchObject({
      filePath: "f.txt",
      ops: [],
      lineNumbered: true,
    });
    expect(viewOf("nl -ba ./sub/f.txt")).toMatchObject({
      filePath: "./sub/f.txt",
      lineNumbered: true,
    });
    expect(viewOf("cd sub && nl -ba f.txt")).toMatchObject({
      filePath: "f.txt",
      baseDir: "sub",
      lineNumbered: true,
    });
  });

  it("fails closed on every other cat/nl spelling", () => {
    expect(reasonOf("cat -A f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -b f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -E f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -n -n f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -n")).toBe("unsupported-command:cat");
    expect(reasonOf("cat --number f")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -n -- f g")).toBe("unsupported-command:cat");
    expect(reasonOf("cat -n -f")).toBe("unsupported-command:cat");
    expect(reasonOf("nl f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -ba")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -bn f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -bp f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -bt f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -b a f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -ba -ba f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl --body-numbering=a f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -ba -- f g")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -ba -f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -v 2 -ba f")).toBe("unsupported-command:nl");
    expect(reasonOf("nl -i 2 -ba f")).toBe("unsupported-command:nl");
    expect(reasonOf("cat -n f | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("nl -ba f | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("cat -n f | cat")).toBe("unsupported-pipeline");
  });
});

describe("bash-classifier content filter stages (Tier-3 item 9)", () => {
  it("admits grep keep / grep -v drop / rg -N keep as downstream stages", () => {
    expect(viewOf("cat f | grep foo")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "foo" }],
    });
    expect(viewOf("cat f | grep -v foo")).toEqual({
      filePath: "f",
      ops: [{ kind: "drop", pattern: "foo" }],
    });
    expect(viewOf("cat f | rg -N foo")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "foo" }],
    });
    expect(viewOf("cat f | grep 'a b'")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "a b" }],
    });
    expect(viewOf('cat f | grep -v "a b"')).toEqual({
      filePath: "f",
      ops: [{ kind: "drop", pattern: "a b" }],
    });
    expect(viewOf("cat f | rtk grep -v foo")).toEqual({
      filePath: "f",
      ops: [{ kind: "drop", pattern: "foo" }],
    });
    expect(viewOf("cat f | rtk rg -N foo")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "foo" }],
    });
  });

  it("folds mixed selector and filter stages left in pipeline order", () => {
    expect(viewOf("cat f | grep foo | head -3")).toEqual({
      filePath: "f",
      ops: [
        { kind: "keep", pattern: "foo" },
        { kind: "first", n: 3 },
      ],
    });
    expect(viewOf("cat f | grep a | grep -v b | head -5")).toEqual({
      filePath: "f",
      ops: [
        { kind: "keep", pattern: "a" },
        { kind: "drop", pattern: "b" },
        { kind: "first", n: 5 },
      ],
    });
    expect(viewOf("head -n 30 f | grep foo | tail -5")).toEqual({
      filePath: "f",
      ops: [
        { kind: "first", n: 30 },
        { kind: "keep", pattern: "foo" },
        { kind: "last", n: 5 },
      ],
    });
    expect(viewOf("cat f | sed -n '3,7p' | grep foo")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 3, to: 7 },
        { kind: "keep", pattern: "foo" },
      ],
    });
    expect(viewOf("cat f | sed -n -e '3p' -e '7p' | grep foo")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 3, to: 3 },
        { kind: "range", from: 7, to: 7 },
        { kind: "keep", pattern: "foo" },
      ],
    });
  });

  it("translates an unnumbered search source into a keep filter", () => {
    expect(viewOf("grep pat f | head -5")).toEqual({
      filePath: "f",
      ops: [
        { kind: "keep", pattern: "pat" },
        { kind: "first", n: 5 },
      ],
    });
    expect(viewOf("rg pat f | rg -N x | tail -2")).toEqual({
      filePath: "f",
      ops: [
        { kind: "keep", pattern: "pat" },
        { kind: "keep", pattern: "x" },
        { kind: "last", n: 2 },
      ],
    });
    expect(viewOf("cd sub && grep pat f | head -5")).toEqual({
      filePath: "f",
      baseDir: "sub",
      ops: [
        { kind: "keep", pattern: "pat" },
        { kind: "first", n: 5 },
      ],
    });
    expect(searchOf("grep -n pat f | head -5")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
      sliceOps: [{ kind: "first", n: 5 }],
    });
    expect(searchOf("rg --line-number pat f | head -5")).toEqual({
      program: "rg",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
      sliceOps: [{ kind: "first", n: 5 }],
    });
    expect(searchOf("grep -n pat f | tail -5")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
      sliceOps: [{ kind: "last", n: 5 }],
    });
    expect(searchOf("rg --line-number pat f | tail -5")).toEqual({
      program: "rg",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
      sliceOps: [{ kind: "last", n: 5 }],
    });
    expect(reasonOf("grep -n pat f | head -0")).toBe("unsupported-pipeline");
    expect(reasonOf("grep -n pat f | tail -0")).toBe("unsupported-pipeline");
    expect(reasonOf("rtk grep pat f | head -3")).toBe("unsupported-pipeline");
    expect(reasonOf("grep -v pat f | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("rg -N pat f | head -5")).toBe("unsupported-pipeline");
  });

  it("fails closed on every non-exact filter shape and every un-admitted stage", () => {
    for (const command of [
      "cat f | grep",
      "cat f | grep a b",
      "cat f | grep -i x",
      "cat f | grep -F x",
      "cat f | grep -E x",
      "cat f | grep -w x",
      "cat f | grep -e x",
      "cat f | grep -m 1 x",
      "cat f | grep -n x",
      "cat f | grep -c x",
      "cat f | grep -A2 x",
      "cat f | grep --invert-match x",
      "cat f | grep --color=never x",
      "cat f | grep -v",
      "cat f | grep -v a b",
      "cat f | grep -v -x",
      "cat f | grep -- -x",
      "cat f | grep -x",
      "cat f | rg x",
      "cat f | rg -N",
      "cat f | rg -N a b",
      "cat f | rg --no-line-number x",
      "cat f | rg -i -N x",
      "cat f | rg -N -x",
      "cat f | sort",
      "cat f | tac",
      "cat f | tee out.txt",
      "cat f | head -c 5",
      "cat f | grep $P",
      "cat f | grep *.ts",
      "cat f | frobnicate",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-pipeline");
    }
    expect(reasonOf("cat -n f | grep x")).toBe("unsupported-pipeline");
    expect(reasonOf("nl -ba f | rg -N x")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | grep a | grep -v b | head -5 | tail -2")).toBe("unsupported-pipeline");
  });

  it("never mutates a pipeline: the rewrite is bare searches only", () => {
    expect(withSearchLineNumbers("grep pat f | head -5")).toBe("grep pat f | head -5");
    expect(withSearchLineNumbers("rg pat f | head -5")).toBe("rg pat f | head -5");
    expect(withSearchLineNumbers("grep -n pat f | head -5")).toBe("grep -n pat f | head -5");
    expect(withSearchLineNumbers("cat f | grep x")).toBe("cat f | grep x");
    expect(withSearchLineNumbers("cat f | grep x | head -5")).toBe("cat f | grep x | head -5");
    expect(withSearchLineNumbers("grep pat f")).toBe("grep -n pat f");
  });

  it("folds applyViewOps left, so subtract-then-head differs from head-then-subtract", () => {
    const lines = [
      { line: 1, text: "K1" },
      { line: 2, text: "K2" },
      { line: 3, text: "a" },
      { line: 4, text: "b" },
    ];
    expect(
      applyViewOps(
        [
          { kind: "drop", pattern: "K" },
          { kind: "first", n: 2 },
        ],
        lines,
      ).map((entry) => entry.line),
    ).toEqual([3, 4]);
    expect(
      applyViewOps(
        [
          { kind: "first", n: 2 },
          { kind: "drop", pattern: "K" },
        ],
        lines,
      ),
    ).toEqual([]);
    expect(
      applyViewOps(
        [
          { kind: "keep", pattern: "K" },
          { kind: "last", n: 1 },
        ],
        lines,
      ).map((entry) => entry.line),
    ).toEqual([2]);
    expect(
      applyViewOps(
        [
          { kind: "from", n: 2 },
          { kind: "keep", pattern: "b" },
        ],
        lines,
      ).map((entry) => entry.line),
    ).toEqual([4]);
  });
});

describe("bash-classifier multi-file, recursive and --files (Tier-3 item 10)", () => {
  it("admits multi-file searches, recursive grep and rg --files", () => {
    expect(multiOf("grep pat a.ts b.ts")).toEqual({
      program: "grep",
      pattern: "pat",
      filePaths: ["a.ts", "b.ts"],
      lineNumbered: false,
    });
    expect(multiOf("grep -n pat a.ts b.ts c.ts").lineNumbered).toBe(true);
    expect(multiOf("grep pat -i a.ts b.ts").filePaths).toEqual(["a.ts", "b.ts"]);
    expect(multiOf("grep pat a.ts b.ts -n").lineNumbered).toBe(true);
    expect(multiOf("rg pat a.ts b.ts").program).toBe("rg");
    expect(multiOf("grep -e pat a.ts b.ts").pattern).toBe("pat");
    expect(multiOf("grep -epat a.ts b.ts").filePaths).toEqual(["a.ts", "b.ts"]);
    expect(multiOf("grep -e a b f").filePaths).toEqual(["b", "f"]);
    expect(multiOf("grep -ei pat f").pattern).toBe("i");
    expect(multiOf("grep -en pat f").filePaths).toEqual(["pat", "f"]);
    expect(multiOf("grep -emi pat f").pattern).toBe("mi");
    expect(multiOf("grep -- -pat a.ts b.ts").pattern).toBe("-pat");
    expect(multiOf("cd sub && grep x a.ts b.ts").baseDir).toBe("sub");
    expect(recursiveOf("grep -r pat dir")).toEqual({
      program: "grep",
      pattern: "pat",
      dirPath: "dir",
      lineNumbered: false,
    });
    expect(recursiveOf("grep -rn pat dir").lineNumbered).toBe(true);
    expect(recursiveOf("grep -inr pat dir").lineNumbered).toBe(true);
    expect(recursiveOf("grep -R pat dir").dirPath).toBe("dir");
    expect(recursiveOf("grep --recursive pat dir").program).toBe("grep");
    expect(recursiveOf("grep --dereference-recursive pat dir").dirPath).toBe("dir");
    expect(recursiveOf("grep -e pat -r dir").pattern).toBe("pat");
    expect(recursiveOf("cd d && grep -r x .").baseDir).toBe("d");
    expect(searchOf("rg pat dir").filePath).toBe("dir");
    expect(searchOf("rg pat f.ts").filePath).toBe("f.ts");
    expect(searchOf("grep pat dir").filePath).toBe("dir");
    expect(filesOf("rg --files")).toEqual({ program: "rg" });
    expect(filesOf("rg --files dir").dirPath).toBe("dir");
    expect(filesOf("cd sub && rg --files").baseDir).toBe("sub");
  });

  it("fails closed beyond the file bound and on every mixed or wrong-tool shape", () => {
    const tooMany = `grep pat ${Array.from({ length: 11 }, (_, i) => `f${i}.ts`).join(" ")}`;
    expect(reasonOf(tooMany)).toBe("unsupported-command:grep");
    expect(reasonOf("grep -r pat a.ts b.ts")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -r pat d1 d2")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -r pat")).toBe("unsupported-command:grep");
    expect(reasonOf("rg -r x pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg -R pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --replace x pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --files pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --files --json")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --files -n")).toBe("unsupported-command:rg");
    expect(reasonOf("grep pat")).toBe("unsupported-command:grep");
    expect(reasonOf("rg pat")).toBe("unsupported-command:rg");
    expect(reasonOf("git grep pat")).toBe("unsupported-command:git");
    expect(reasonOf("git show HEAD:f")).toBe("unsupported-command:git");
    expect(reasonOf("grep -e a -e b f g")).toBe("unsupported-command:grep");
    expect(reasonOf("grep pat a.ts b.ts | head -2")).toBe("unsupported-pipeline");
  });

  it("splices line numbers into multi-file and recursive searches, never into --files", () => {
    expect(withSearchLineNumbers("grep pat a.ts b.ts")).toBe("grep -n pat a.ts b.ts");
    expect(withSearchLineNumbers("rg pat a.ts b.ts")).toBe("rg --line-number pat a.ts b.ts");
    expect(withSearchLineNumbers("grep -r pat dir")).toBe("grep -n -r pat dir");
    expect(withSearchLineNumbers("grep -rn pat dir")).toBe("grep -rn pat dir");
    expect(withSearchLineNumbers("rg pat dir")).toBe("rg --line-number pat dir");
    expect(withSearchLineNumbers("rg --files")).toBe("rg --files");
    expect(withSearchLineNumbers("rg --files dir")).toBe("rg --files dir");
  });
});

describe("bash-classifier line-set consumers (Tier-3 item 11)", () => {
  it("admits exactly `sort -u`, `uniq` and `wc -l` as downstream stages", () => {
    expect(viewOf("cat f | sort -u")).toEqual({ filePath: "f", ops: [{ kind: "sortUnique" }] });
    expect(viewOf("cat f | uniq")).toEqual({ filePath: "f", ops: [{ kind: "uniq" }] });
    expect(viewOf("cat f | wc -l")).toEqual({ filePath: "f", ops: [{ kind: "count" }] });
    expect(viewOf("cat f | rtk sort -u")).toEqual({ filePath: "f", ops: [{ kind: "sortUnique" }] });
    expect(viewOf("cat f | rtk uniq")).toEqual({ filePath: "f", ops: [{ kind: "uniq" }] });
    expect(viewOf("cat f | rtk wc -l")).toEqual({ filePath: "f", ops: [{ kind: "count" }] });
    expect(viewOf("cd sub && cat f | sort -u")).toEqual({
      filePath: "f",
      baseDir: "sub",
      ops: [{ kind: "sortUnique" }],
    });
    expect(viewOf("head -n 30 f | uniq")).toEqual({
      filePath: "f",
      ops: [{ kind: "first", n: 30 }, { kind: "uniq" }],
    });
  });

  it("keeps stage order for every composition with the existing ops", () => {
    expect(viewOf("cat f | grep x | sort -u")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "x" }, { kind: "sortUnique" }],
    });
    expect(viewOf("cat f | sort -u | head -2")).toEqual({
      filePath: "f",
      ops: [{ kind: "sortUnique" }, { kind: "first", n: 2 }],
    });
    expect(viewOf("cat f | uniq | wc -l")).toEqual({
      filePath: "f",
      ops: [{ kind: "uniq" }, { kind: "count" }],
    });
    expect(viewOf("cat f | grep -v x | wc -l")).toEqual({
      filePath: "f",
      ops: [{ kind: "drop", pattern: "x" }, { kind: "count" }],
    });
    expect(viewOf("cat f | sed -n '3,7p' | sort -u")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 3, to: 7 }, { kind: "sortUnique" }],
    });
    expect(viewOf("cat f | sort -u | uniq")).toEqual({
      filePath: "f",
      ops: [{ kind: "sortUnique" }, { kind: "uniq" }],
    });
    expect(viewOf("grep pat f | sort -u")).toEqual({
      filePath: "f",
      ops: [{ kind: "keep", pattern: "pat" }, { kind: "sortUnique" }],
    });
  });

  it("denies every growth spelling around the three consumers", () => {
    for (const command of [
      "cat f | sort",
      "cat f | sort -n",
      "cat f | sort -r",
      "cat f | sort -u -n",
      "cat f | sort -o out.txt",
      "cat f | sort g",
      "cat f | uniq -c",
      "cat f | uniq -d",
      "cat f | uniq -u",
      "cat f | uniq extra",
      "cat f | wc",
      "cat f | wc -c",
      "cat f | wc -w",
      "cat f | wc -l f",
      "cat f | wc -l | head -2",
      "cat f | wc -l | sort -u",
      "cat f | sort -u | frobnicate",
      "cat f | frobnicate",
      "cat f | grep -A 2 x",
      "cat f | grep -B 1 x",
      "cat f | grep -C 1 x",
      "cat f | grep -c x",
      "cat f | grep -l x",
      "cat f | grep -o x",
      "cat f | grep -q x",
      "cat f | sed -i 's/a/b/'",
      "cat f | head -c 5",
      "cat f | tail -c 5",
      "cat f | tee out.txt",
      "cat f | tac",
      "cat -n f | sort -u",
      "cat -n f | grep x | sort -u",
      "nl -ba f | wc -l",
      "rg --files | wc -l",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-pipeline");
    }
    expect(reasonOf("sort -u f")).toBe("unsupported-command:sort");
    expect(reasonOf("uniq f")).toBe("unsupported-command:uniq");
    expect(reasonOf("wc -l f")).toBe("unsupported-command:wc");
    expect(reasonOf("git grep pat")).toBe("unsupported-command:git");
    expect(reasonOf("git show HEAD:f")).toBe("unsupported-command:git");
  });

  it("folds sort -u, uniq and wc -l over (true line, text) pairs", () => {
    const lines = [
      { line: 1, text: "b" },
      { line: 2, text: "a" },
      { line: 3, text: "b" },
      { line: 4, text: "a" },
      { line: 5, text: "c" },
    ];
    expect(applyViewOps([{ kind: "sortUnique" }], lines)).toEqual([
      { line: 2, text: "a" },
      { line: 1, text: "b" },
      { line: 5, text: "c" },
    ]);
    expect(applyViewOps([{ kind: "uniq" }], lines)).toEqual(lines);
    expect(
      applyViewOps(
        [{ kind: "uniq" }],
        [
          { line: 1, text: "x" },
          { line: 2, text: "x" },
          { line: 3, text: "y" },
          { line: 4, text: "x" },
        ],
      ),
    ).toEqual([
      { line: 1, text: "x" },
      { line: 3, text: "y" },
      { line: 4, text: "x" },
    ]);
    expect(applyViewOps([{ kind: "sortUnique" }, { kind: "first", n: 2 }], lines)).toEqual([
      { line: 2, text: "a" },
      { line: 1, text: "b" },
    ]);
    expect(applyViewOps([{ kind: "count" }], lines)).toEqual(lines);
    expect(applyViewOps([{ kind: "drop", pattern: "a" }, { kind: "count" }], lines)).toHaveLength(
      3,
    );
    expect(
      applyViewOps(
        [{ kind: "sortUnique" }],
        [
          { line: 1, text: "a" },
          { line: 2, text: "Z" },
        ],
      ).map((entry) => entry.text),
    ).toEqual(["Z", "a"]);
  });

  it("throws on an unknown op kind instead of degrading it to a slice", () => {
    expect(() =>
      applyViewOps([{ kind: "unknown-op" } as unknown as ViewOp], [{ line: 1, text: "a" }]),
    ).toThrow();
  });

  it("never mutates a line-set consumer command (no rewrite)", () => {
    for (const command of [
      "cat f | sort -u",
      "cat f | uniq",
      "cat f | wc -l",
      "cat f | grep x | sort -u",
      "cat f | sort -u | head -2",
      "cat f | uniq | wc -l",
    ]) {
      expect(withSearchLineNumbers(command)).toBe(command);
    }
  });
});
describe("bash-classifier redundant cd (D7/D8)", () => {
  it("skips dot-form cds without counting them", () => {
    expect(viewOf("cd . && cat f")).toEqual({ filePath: "f", ops: [] });
    expect(viewOf("cd sub && cd . && cat f")).toEqual({ filePath: "f", baseDir: "sub", ops: [] });
    expect(viewOf("cd . && cd . && cat f")).toEqual({ filePath: "f", ops: [] });
    expect(viewOf("cat f && cd .")).toEqual({ filePath: "f", ops: [] });
  });
  it("skips an exact absolute repeat against tracked knowledge", () => {
    expect(viewOf("cd /x && cd /x && cat f")).toEqual({ filePath: "f", baseDir: "/x", ops: [] });
  });
  it("still counts non-redundant seconds (relative repeat, parent, absolute change)", () => {
    expect(reasonOf("cd sub && cd sub && cat f")).toBe("multi-cd");
    expect(reasonOf("cd /x && cd /y && cat f")).toBe("multi-cd");
    expect(reasonOf("cd sub && cd .. && cat f")).toBe("multi-cd");
  });
  it("carries the base through glue to the view", () => {
    expect(compoundOf("cd sub && echo hi && cat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
        { kind: "view", filePath: "f", ops: [] },
      ],
      baseDir: "sub",
    });
  });
});
describe("bash-classifier compound multi-block (C4)", () => {
  it("admits multiple blocks when glue is present anywhere", () => {
    expect(compoundOf("grep -n A f && grep -n B g && echo hi")).toEqual({
      kind: "pureCompound",
      segments: [
        {
          kind: "search",
          family: {
            kind: "pureSearch",
            search: { program: "grep", pattern: "A", filePath: "f", lineNumbered: true },
          },
        },
        {
          kind: "search",
          family: {
            kind: "pureSearch",
            search: { program: "grep", pattern: "B", filePath: "g", lineNumbered: true },
          },
        },
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
      ],
    });
    expect(compoundOf("cat f; echo hi")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "view", filePath: "f", ops: [] },
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
      ],
    });
  });
  it("declines a non-redundant cd after a block in a glue chain", () => {
    expect(reasonOf("grep A f; cd sub; echo hi")).toBe("post-block-cd");
  });
  it("numbers every unnumbered search in a compound in one pass", () => {
    expect(withSearchLineNumbers("echo hi && grep x f && grep y g")).toBe(
      "echo hi && grep -n x f && grep -n y g",
    );
  });
});

// Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
describe("bash-classifier context search admission (#183)", () => {
  it("admits grep's short window flags and carries the window on the search", () => {
    expect(searchOf("grep -A 2 pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
      context: { before: 0, after: 2 },
    });
    expect(searchOf("grep -B 3 pat f").context).toEqual({ before: 3, after: 0 });
    expect(searchOf("grep -C 1 pat f").context).toEqual({ before: 1, after: 1 });
    expect(searchOf("grep -A 1 -B 2 pat f").context).toEqual({ before: 2, after: 1 });
  });

  it("admits the long context spellings in both value shapes", () => {
    expect(searchOf("grep --after-context 2 pat f").context).toEqual({ before: 0, after: 2 });
    expect(searchOf("grep --before-context 2 pat f").context).toEqual({ before: 2, after: 0 });
    expect(searchOf("grep --context 2 pat f").context).toEqual({ before: 2, after: 2 });
    expect(searchOf("grep --context=2 pat f").context).toEqual({ before: 2, after: 2 });
    expect(searchOf("grep --after-context=1 pat f").context).toEqual({ before: 0, after: 1 });
  });

  it("admits rg -C and the cluster-close and post-operand spellings", () => {
    expect(searchOf("rg -C 2 pat f")).toEqual({
      program: "rg",
      pattern: "pat",
      filePath: "f",
      lineNumbered: false,
      context: { before: 2, after: 2 },
    });
    expect(searchOf("grep -nC 2 pat f")).toEqual({
      program: "grep",
      pattern: "pat",
      filePath: "f",
      lineNumbered: true,
      context: { before: 2, after: 2 },
    });
    expect(searchOf("grep pat -C 1 f").context).toEqual({ before: 1, after: 1 });
    expect(searchOf("cd sub && grep -C 1 pat f").context).toEqual({ before: 1, after: 1 });
    expect(searchOf("grep -C 1 -- pat f").context).toEqual({ before: 1, after: 1 });
  });

  it("injects the line-number splice without touching the context flag", () => {
    expect(withSearchLineNumbers("grep -A 2 pat f")).toBe("grep -n -A 2 pat f");
    expect(withSearchLineNumbers("rg -C 2 pat f")).toBe("rg --line-number -C 2 pat f");
    expect(withSearchLineNumbers("grep --context=2 pat f")).toBe("grep -n --context=2 pat f");
    expect(withSearchLineNumbers("grep -nC 2 pat f")).toBe("grep -nC 2 pat f");
  });

  it("refuses values that are not strictly positive integers", () => {
    for (const command of [
      "grep -A 0 pat f",
      "grep -A 00 pat f",
      "grep -B -1 pat f",
      "grep -C x pat f",
      "grep -C pat f",
      "grep --context= pat f",
      "grep --context=0 pat f",
      "grep --context pat f",
      "grep -C 1e2 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("refuses attached, repeated and mixed context spellings", () => {
    for (const command of [
      "grep -A2 pat f",
      "grep -B3 pat f",
      "grep -C1 pat f",
      "grep -nC2 pat f",
      "grep -A1C2 pat f",
      "grep --context 1 --context 2 pat f",
      "grep -A 1 -C 2 pat f",
      "grep -C 2 -A 1 pat f",
      "grep -C 1 --context 2 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("refuses context on the shapes D3 does not name", () => {
    for (const command of [
      "grep -r -C 2 pat dir",
      "grep -R -A 1 pat dir",
      "grep -rn -C 1 pat dir",
      "grep --recursive -C 1 pat dir",
      "grep -C 2 pat a.ts b.ts",
      "grep -A 2 pat a.ts b.ts",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
    for (const command of [
      "rg -A 2 pat f",
      "rg -B 2 pat f",
      "rg --context 2 pat f",
      "rg --context=2 pat f",
      "rg --after-context 2 pat f",
      "rg -C 2 pat a.ts b.ts",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:rg");
    }
  });

  it("still refuses every context-plus-output-modifier combination", () => {
    for (const command of [
      "grep -c -A 2 pat f",
      "grep -o -C 1 pat f",
      "grep -l -B 2 pat f",
      "grep -L -C 1 pat f",
      "grep -v -A 2 pat f",
      "grep -q -C 1 pat f",
      "grep -A 2 -c pat f",
      "grep -C 1 -o pat f",
      "grep --count --context 1 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("carries the window through a compound search segment", () => {
    expect(classifyBashCommand("echo hi && grep -C 1 pat f")).toEqual({
      kind: "pureCompound",
      segments: [
        { kind: "glue", glue: { program: "echo", expectedText: "hi\n", expectedBytes: 3 } },
        {
          kind: "search",
          family: {
            kind: "pureSearch",
            search: {
              program: "grep",
              pattern: "pat",
              filePath: "f",
              lineNumbered: false,
              context: { before: 1, after: 1 },
            },
          },
        },
      ],
    });
  });
});

// Ref: docs/.archive_adrs/0049-multi-file-bash-views.md
function multiViewOf(command: string) {
  const result = classifyBashCommand(command);
  expect(result.kind).toBe("pureMultiView");
  if (result.kind !== "pureMultiView") throw new Error(`not a multi view: ${command}`);
  return result.view;
}

describe("bash-classifier multi-file view admission (#183)", () => {
  it("admits the four shapes and keeps operand order", () => {
    expect(multiViewOf("cat a b")).toEqual({ program: "cat", filePaths: ["a", "b"], ops: [] });
    expect(multiViewOf("cat a b c").filePaths).toEqual(["a", "b", "c"]);
    expect(multiViewOf("cat -n a b")).toEqual({
      program: "cat",
      filePaths: ["a", "b"],
      ops: [],
      lineNumbered: true,
    });
    expect(multiViewOf("nl -ba a b")).toEqual({
      program: "nl",
      filePaths: ["a", "b"],
      ops: [],
      lineNumbered: true,
    });
    expect(multiViewOf("sed -n '2,4p' a b")).toEqual({
      program: "sed",
      filePaths: ["a", "b"],
      ops: [{ kind: "range", from: 2, to: 4 }],
    });
    expect(multiViewOf("sed -n -e '1p' -e '5,6p' a b").ops).toEqual([
      { kind: "range", from: 1, to: 1 },
      { kind: "range", from: 5, to: 6 },
    ]);
  });

  it("keeps the single-operand shapes exactly as they were", () => {
    expect(classifyBashCommand("cat a").kind).toBe("pureView");
    expect(classifyBashCommand("cat -n a").kind).toBe("pureView");
    expect(classifyBashCommand("nl -ba a").kind).toBe("pureView");
    expect(classifyBashCommand("sed -n '2,4p' a").kind).toBe("pureView");
  });

  it("carries the single pre-view cd and leaves the line-number splice alone", () => {
    expect(multiViewOf("cd sub && cat a b").baseDir).toBe("sub");
    expect(withSearchLineNumbers("cat a b")).toBe("cat a b");
    expect(withSearchLineNumbers("sed -n '1,2p' a b")).toBe("sed -n '1,2p' a b");
  });

  it("admits the rtk-wrapped shape, which D8 already treats as a transparent view wrapper", () => {
    expect(multiViewOf("rtk cat a b").filePaths).toEqual(["a", "b"]);
  });

  it("refuses every near-miss shape with the settled reasons", () => {
    for (const command of [
      "head a b",
      "tail -n 2 a b",
      "cat a -",
      "cat a b -n",
      "cat -- a b",
      "cat -n -- a b",
      "nl -ba -- a b",
      "cat -b a b",
      "sed '2,4p' a b",
      "sed -n '2,4p' a b -e '5p'",
      "sed -n -e '1p' -e 'oops' a b",
    ]) {
      expect(reasonOf(command)).toMatch(/^(unsupported-command|non-literal-command):?/);
    }
    expect(reasonOf("cat a b | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat a b > out.txt")).toBe("non-literal-command");
    expect(reasonOf("cat *.txt b.txt")).toBe("non-literal-command");
  });

  it("refuses every compound envelope around a multi-file view", () => {
    expect(reasonOf("cat a b && cat c")).toBe("multi-view");
    expect(reasonOf("cat a b; echo hi")).toBe("multi-view");
    expect(reasonOf("echo hi && cat a b")).toBe("multi-view");
    expect(reasonOf("cat a b && grep x f")).toBe("multi-view");
    expect(reasonOf("cat a b && cd sub")).toBe("post-view-cd");
    expect(multiViewOf("true && cat a b").filePaths).toEqual(["a", "b"]);
  });
});

describe("bash-classifier display tails (ADR-0048 D2)", () => {
  it("admits a terminal display stage over a raw-slice view", () => {
    expect(viewOf("cat f | cat -A")).toEqual({
      filePath: "f",
      ops: [],
      display: { kind: "cat-A", label: "cat -A" },
    });
    expect(viewOf("cat f | cat -vet")).toEqual({
      filePath: "f",
      ops: [],
      display: { kind: "cat-vet", label: "cat -vet" },
    });
    expect(viewOf("head -5 f | cat -A")).toEqual({
      filePath: "f",
      ops: [{ kind: "first", n: 5 }],
      display: { kind: "cat-A", label: "cat -A" },
    });
    expect(viewOf("sed -n '2,4p' f | cat -A")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 2, to: 4 }],
      display: { kind: "cat-A", label: "cat -A" },
    });
    expect(viewOf("cat f | od -c")).toEqual({
      filePath: "f",
      ops: [],
      display: { kind: "od-c", label: "od -c" },
    });
    expect(viewOf("cat f | xxd")).toEqual({
      filePath: "f",
      ops: [],
      display: { kind: "xxd", label: "xxd" },
    });
    expect(viewOf("cat f | hexdump -C")).toEqual({
      filePath: "f",
      ops: [],
      display: { kind: "hexdump-C", label: "hexdump -C" },
    });
    expect(viewOf("cd sub && cat f | cat -A")).toEqual({
      filePath: "f",
      baseDir: "sub",
      ops: [],
      display: { kind: "cat-A", label: "cat -A" },
    });
  });

  it("refuses non-terminal, operand, redirect, numbered, search, filter, wrapper and compound shapes", () => {
    expect(reasonOf("cat f | cat -A | head")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | cat -A > out")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | cat -A other")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | rtk cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | cat -A | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("cat -n f | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("nl -ba f | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("grep pat f | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | sort -u | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | wc -l | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("echo hi && cat f | cat -A")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | cat -A && echo hi")).toBe("unsupported-pipeline");
  });
});
