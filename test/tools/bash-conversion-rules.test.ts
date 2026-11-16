import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNever } from "../../src/utils.js";
import type {
  ConversionRule,
  DeclineReason,
  LocatedBox,
  RulePhase,
} from "../../src/bash-conversion/decide.js";
import { RULES, decide } from "../../src/bash-conversion/decide.js";

/**
 * Per-rule pins (#151 S2): each decline reason fires on a command that must decline with exactly
 * that reason, beside an adjacent command that must not — the adjacent proves the pin is not
 * vacuous, because the same command shape converts when the guard's condition lifts. Reason
 * strings are user-visible contract: byte-identical, never renamed.
 */

function reasonOf(command: string): DeclineReason {
  const decision = decide(command);
  if (decision.kind !== "passThrough") throw new Error(`expected decline for ${command}`);
  return decision.reason;
}

describe("bash conversion decline reasons (#151)", () => {
  it("declines empty input, converts a bare view", () => {
    expect(reasonOf("")).toBe("empty");
    expect(reasonOf("   ")).toBe("empty");
    expect(decide("cat f").kind).toBe("pureView");
  });
  it("declines unparseable input, converts the completed pipe", () => {
    expect(reasonOf("cat f |")).toBe("parse-error");
    expect(decide("cat f | head -2").kind).toBe("pureView");
  });
  it("declines a newline-separated script, admits the semicolon gate", () => {
    expect(reasonOf("cat a\ncat b")).toBe("multi-statement");
    expect(decide("cd /tmp; cat f").kind).toBe("pureView");
  });
  it("declines backgrounded work, converts the foreground chain", () => {
    expect(reasonOf("sleep 1 &")).toBe("background");
    expect(decide("cat f").kind).toBe("pureView");
  });
  it("declines non-`&&` chains, converts the `&&` chain", () => {
    expect(reasonOf("cat f || echo x")).toBe("non-and-chain");
    expect(decide("cat f && echo done").kind).toBe("pureCompound");
  });
  it("declines a subshell top, converts the bare view", () => {
    expect(reasonOf("(cat f)")).toBe("compound-top");
    expect(decide("cat f").kind).toBe("pureView");
  });
  it("declines a nine-segment chain, converts the eight-segment chain", () => {
    expect(reasonOf("true && true && true && true && true && true && true && true && cat f")).toBe(
      "chain-too-long",
    );
    expect(decide("true && true && true && true && true && true && true && cat f").kind).toBe(
      "pureView",
    );
  });
  it("declines a non-literal command, converts the literal view", () => {
    expect(reasonOf("FOO=bar")).toBe("non-literal-command");
    expect(decide("cat f").kind).toBe("pureView");
  });
  it("declines an unsupported command with its name, converts the view", () => {
    expect(reasonOf("ls /tmp")).toBe("unsupported-command:ls");
    expect(decide("cat f").kind).toBe("pureView");
  });
  it("declines an unsupported pipeline, converts the supported one", () => {
    expect(reasonOf("cat f | grep")).toBe("unsupported-pipeline");
    expect(decide("cat f | head -2").kind).toBe("pureView");
  });
  it("declines a post-block `cd`, converts the pre-block `cd` compound", () => {
    expect(reasonOf("echo hi && cat f && cd sub")).toBe("post-block-cd");
    const adjacent = decide("echo hi && cd /tmp && cat f");
    expect(adjacent.kind).toBe("pureCompound");
  });
  it("declines a post-view `cd`, converts the pre-view `cd`", () => {
    expect(reasonOf("cat f && cd sub")).toBe("post-view-cd");
    const adjacent = decide("cd sub && cat f");
    expect(adjacent).toEqual({
      kind: "pureView",
      view: { filePath: "f", baseDir: "sub", ops: [] },
    });
  });
  it("declines chained `cd`s, converts the single `cd`", () => {
    expect(reasonOf("cd a && cd b && cat f")).toBe("multi-cd");
    const adjacent = decide("cd /tmp && cat f");
    expect(adjacent).toEqual({
      kind: "pureView",
      view: { filePath: "f", baseDir: "/tmp", ops: [] },
    });
  });
  it("declines a prefix search, converts the based terminal search", () => {
    expect(reasonOf("grep x f; cat g")).toBe("multi-statement");
    const adjacent = decide("cd /tmp; grep x f");
    expect(adjacent.kind).toBe("pureSearch");
  });
  it("declines a prefix view past the gate, converts the based terminal view", () => {
    expect(reasonOf("cat a; cat b")).toBe("multi-statement");
    expect(decide("cd /tmp; cat f").kind).toBe("pureView");
  });
  it("declines a second search without glue, converts the glued chain", () => {
    expect(reasonOf("grep x f && cat g")).toBe("multi-view");
    expect(decide("echo hi && grep x f && cat g").kind).toBe("pureCompound");
  });
  it("declines a second view without glue, converts the glued chain", () => {
    expect(reasonOf("cat a && cat b")).toBe("multi-view");
    expect(decide("echo hi && cat a && cat b").kind).toBe("pureCompound");
  });
  it("declines a blockless chain, converts the silent-prefixed view", () => {
    expect(reasonOf(": && true")).toBe("no-view");
    expect(decide(": && cat f").kind).toBe("pureView");
  });
  it("shares the multi-statement reason between the gate and the prefix arms", () => {
    expect(reasonOf("cat a\ncat b")).toBe("multi-statement");
    expect(reasonOf("cat a; cat b")).toBe("multi-statement");
    expect(reasonOf("grep x f; cat g")).toBe("multi-statement");
  });
});

describe("bash conversion accumulation (#151)", () => {
  it("skips a redundant `cd` without recording a base", () => {
    const decision = decide("cd . && cat f");
    expect(decision.kind).toBe("pureView");
    if (decision.kind === "pureView") expect("baseDir" in decision.view).toBe(false);
  });
  it("records one pre-view `cd` as the resolution base", () => {
    const decision = decide("cd /tmp && cat f");
    expect(decision).toEqual({
      kind: "pureView",
      view: { filePath: "f", baseDir: "/tmp", ops: [] },
    });
  });
  it("carries glue beside its block in the compound", () => {
    const decision = decide("echo hi && cat f");
    expect(decision.kind).toBe("pureCompound");
    if (decision.kind === "pureCompound") {
      expect(decision.segments.map((segment) => segment.kind)).toEqual(["glue", "view"]);
    }
  });
  it("records the terminal search offset for the line-number splice", () => {
    const located: LocatedBox = {};
    expect(decide("grep x f", located).kind).toBe("pureSearch");
    expect(located.searchNameEnds?.length).toBe(1);
    const empty: LocatedBox = {};
    expect(decide("cat f", empty).kind).toBe("pureView");
    expect(empty.searchNameEnds).toBeUndefined();
  });
});

describe("bash conversion rule table (#151)", () => {
  const table: readonly ConversionRule[] = RULES;
  const ids = table.map((rule) => rule.id);
  it("keeps rule ids unique", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("documents every rule's authority", () => {
    for (const rule of RULES) {
      expect(rule.why, `rule ${rule.id} lacks an authority citation`).toMatch(
        /docs\/|commit |item |structural/,
      );
    }
  });

  it("cites only record paths that exist", () => {
    for (const rule of RULES) {
      for (const [citation] of rule.why.matchAll(/docs\/[\w./-]+\.md/g)) {
        expect(existsSync(citation), `rule ${rule.id} cites a missing record: ${citation}`).toBe(
          true,
        );
      }
    }
  });
  it("pins the rule order (array order is precedence)", () => {
    expect(ids).toEqual([
      "empty",
      "parse-error",
      "multi-statement",
      "background",
      "non-and-chain",
      "compound-top",
      "compound-andor-operand",
      "chain-too-long",
      "compound-segment",
      "admit-glue",
      "inert-tail",
      "inert-count-tail",
      "unsafe",
      "skip-redundant-cd",
      "post-block-cd",
      "post-view-cd",
      "multi-cd",
      "record-cd",
      "silent-skip",
      "inert-tail-head",
      "search-prefix",
      "search-second",
      "record-search",
      "view-prefix",
      "view-second",
      "record-view",
      "multi-view-chain",
      "multi-view",
      "display-compound",
      "compound",
      "inert-compound",
      "search",
      "no-view",
      "view",
    ]);
  });
  it("keeps every phase transition total", () => {
    const phases: RulePhase[] = table.map((rule) => rule.phase);
    expect(phases[0]).toBe("pre");
    expect(phases[phases.length - 1]).toBe("post");
    expect(new Set(phases)).toEqual(new Set(["pre", "statement", "presegment", "segment", "post"]));
  });
});

describe("bash serve attribution admission (#175)", () => {
  function pinDeclineReason(
    reason: Exclude<DeclineReason, `unsupported-command:${string}`>,
  ): string {
    switch (reason) {
      case "empty":
        return "empty";
      case "parse-error":
        return "parse-error";
      case "multi-statement":
        return "multi-statement";
      case "background":
        return "background";
      case "non-and-chain":
        return "non-and-chain";
      case "compound-top":
        return "compound-top";
      case "compound-andor-operand":
        return "compound-andor-operand";
      case "chain-too-long":
        return "chain-too-long";
      case "compound-segment":
        return "compound-segment";
      case "non-literal-command":
        return "non-literal-command";
      case "unsupported-pipeline":
        return "unsupported-pipeline";
      case "post-block-cd":
        return "post-block-cd";
      case "post-view-cd":
        return "post-view-cd";
      case "multi-cd":
        return "multi-cd";
      case "multi-view":
        return "multi-view";
      case "no-view":
        return "no-view";
      default:
        return assertNever(reason);
    }
  }

  it("keeps the guard shapes admitted by the pure classifier", () => {
    expect(decide("grep -n x a a:1:b.txt").kind).toBe("pureMultiSearch");
    expect(decide("grep -n pat f").kind).toBe("pureSearch");
  });

  function isTemplateReason(reason: DeclineReason): reason is `unsupported-command:${string}` {
    return reason.startsWith("unsupported-command:");
  }
  it("adds no DeclineReason and keeps the neighbours firing", () => {
    const pairs: Array<[string, Exclude<DeclineReason, `unsupported-command:${string}`>]> = [
      ["", "empty"],
      ["cat f |", "parse-error"],
      ["cat a\ncat b", "multi-statement"],
      ["sleep 1 &", "background"],
      ["cat f || echo x", "non-and-chain"],
      ["(cat f)", "compound-top"],
      ["true && true && true && true && true && true && true && true && cat f", "chain-too-long"],
      ["FOO=bar", "non-literal-command"],
      ["cat f | grep", "unsupported-pipeline"],
      ["echo hi && cat f && cd sub", "post-block-cd"],
      ["cat f && cd sub", "post-view-cd"],
      ["cd a && cd b && cat f", "multi-cd"],
      ["cat a && cat b", "multi-view"],
      [": && true", "no-view"],
    ];
    for (const [command, want] of pairs) {
      const reason = reasonOf(command);
      expect(isTemplateReason(reason) ? "unsupported-command:*" : pinDeclineReason(reason)).toBe(
        want,
      );
    }
    expect(reasonOf("ls /tmp")).toBe("unsupported-command:ls");
    expect(reasonOf("cat f && (cat g)")).toBe("compound-andor-operand");
  });
});

// Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
describe("bash context search admission reasons (#183)", () => {
  it("admits the D3 spellings as a single-file search", () => {
    expect(decide("grep -A 2 pat f").kind).toBe("pureSearch");
    expect(decide("grep --context=2 pat f").kind).toBe("pureSearch");
    expect(decide("rg -C 2 pat f").kind).toBe("pureSearch");
  });

  it("declines context-plus-modifier combinations with the program's own reason", () => {
    for (const command of [
      "grep -c -A 2 pat f",
      "grep -o -C 1 pat f",
      "grep -l -B 2 pat f",
      "grep --count --context 1 pat f",
      "grep -A2 pat f",
    ]) {
      expect(reasonOf(command)).toBe("unsupported-command:grep");
    }
  });

  it("declines recursive and multi-file context, which D3 does not admit", () => {
    expect(reasonOf("grep -r -C 2 pat dir")).toBe("unsupported-command:grep");
    expect(reasonOf("grep -C 2 pat a.ts b.ts")).toBe("unsupported-command:grep");
    expect(reasonOf("rg -A 2 pat f")).toBe("unsupported-command:rg");
    expect(reasonOf("rg --context 2 pat f")).toBe("unsupported-command:rg");
  });
});
