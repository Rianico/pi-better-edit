import { describe, expect, it } from "vitest";
import {
  applySliceOps,
  BASH_VIEW_MAX_CHAIN_SEGMENTS,
  BASH_VIEW_MAX_PIPELINE_STAGES,
  classifyBashCommand,
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
    expect(reasonOf("cd d; grep x f")).toBe("unsupported-command:grep");
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
    expect(reasonOf("grep -n pat f")).toBe("unsupported-command:grep");
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
