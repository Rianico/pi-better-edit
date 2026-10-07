import { describe, expect, it } from "vitest";
import { classifyBashCommand, type BashView } from "../../src/bash-classifier";

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

describe("rtk transparent wrapper (ADR-0033 D8)", () => {
  it("unwraps rtk around view commands in source positions", () => {
    expect(viewOf("rtk cat f.txt")).toEqual({ filePath: "f.txt", ops: [] });
    expect(viewOf("rtk head -5 f")).toEqual({ filePath: "f", ops: [{ kind: "first", n: 5 }] });
    expect(viewOf("rtk tail -n +3 f")).toEqual({ filePath: "f", ops: [{ kind: "from", n: 3 }] });
    expect(viewOf("rtk sed -n '1,2p' f")).toEqual({
      filePath: "f",
      ops: [{ kind: "range", from: 1, to: 2 }],
    });
    expect(viewOf("rtk cat f | tail -2")).toEqual({
      filePath: "f",
      ops: [{ kind: "last", n: 2 }],
    });
    expect(viewOf("cd /x && rtk cat f.txt")).toEqual({ filePath: "f.txt", baseDir: "/x", ops: [] });
    expect(viewOf("cat f | rtk head -5")).toEqual({
      filePath: "f",
      ops: [{ kind: "first", n: 5 }],
    });
    expect(viewOf("rtk cat f | rtk tail -2")).toEqual({
      filePath: "f",
      ops: [{ kind: "last", n: 2 }],
    });
    expect(viewOf("rtk cat f | rtk sed -n '3,7p' | rtk head -n2")).toEqual({
      filePath: "f",
      ops: [
        { kind: "range", from: 3, to: 7 },
        { kind: "first", n: 2 },
      ],
    });
  });

  it("keeps rtk unsafe everywhere else", () => {
    expect(reasonOf("rtk")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk ls")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk --compact cat f")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk cd x")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk true")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk cat")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk cat -A f")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk rtk cat f")).toBe("unsupported-command:rtk");
    expect(reasonOf("rtk ls | head -5")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | rtk grep x")).toBe("unsupported-pipeline");
    expect(reasonOf("cat f | rtk")).toBe("unsupported-pipeline");
    expect(reasonOf("rtk cat a b")).toBe("unsupported-command:rtk");
  });
});
