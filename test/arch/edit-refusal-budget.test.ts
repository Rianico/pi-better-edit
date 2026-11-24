import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_REGISTRY,
  formatReadWarning,
  formatWarning,
  isDomainErrorCode,
  type DomainErrorCode,
  type ErrorPayloadMap,
} from "../../src/domain-errors.js";
import { assertReq, normReq, prepareEditArguments } from "../../src/payload-contract.js";
import { resEdit } from "../../src/hashline/resolve.js";

/**
 * T2 (#327) refusal budget: delete-only rendering cuts.
 *
 * (a) No refusal message echoes the request (`Received: ` is gone with `describeReceived`).
 * (b) No refusal inlines the served canonical-payload paragraph; arms carry one shape line.
 * (d) `E_SUSPICIOUS_TEXT` renders the submission count once (`suspiciousTail` deleted).
 * (e) No rendered registry message ends with a doubled terminator (`..`).
 * (f) Touched codes keep audience, rows, and `Options:` (regression: only deleted text is gone).
 */

function refusalOf(shape: unknown): string {
  try {
    assertReq(normReq(shape));
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected rejection");
}

function preparedRefusalOf(args: unknown): string {
  try {
    prepareEditArguments(args);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected rejection");
}

const MALFORMED_INPUTS: unknown[] = [
  undefined,
  null,
  "bare-string",
  123,
  ["an", "array"],
  { edits: [{ anchor_from: "aB3x", anchor_to: "cD4y", text: "x" }] },
  { file: null, edits: [{ anchor_from: "aB3x", anchor_to: "cD4y", text: "x" }] },
  { file: "s.txt", edits: "nope" },
  { file: "s.txt", edits: [] },
  { file: "s.txt", edits: [{ anchor_from: "aB3x", anchor_to: "cD4y" }] },
  { file: "s.txt", edits: [["aB3x", "cD4y", "x"]] },
  {
    file: "s.txt",
    edits: [{ anchor_from: "aB3x", anchor_to: "cD4y", text: "x" }],
    bogus: true,
  },
];

const ERROR_EXAMPLES: { [K in DomainErrorCode]: ErrorPayloadMap[K] } = {
  E_BAD_PAYLOAD: { message: "Edit request requires a non-empty edits array." },
  E_EMPTY_RANGE: {},
  E_STALE_ANCHOR: {
    headline: "anchor gone",
    servedRows: [{ position: 0, hash: "abcd" }],
    servedBlock: "abcd│alpha",
    cause: "never-served",
  },
  E_UNKNOWN_ANCHOR: { path: "probe.ts", anchors: ["zzzz"] },
  E_FOREIGN_ANCHOR: { path: "probe.ts", anchors: ["wxyz"], homes: ["other.ts"] },
  E_STALE_RANGE: {
    headline: "line two differs from what was served.",
    servedRows: [{ position: 1, hash: "defg" }],
    servedBlock: "defg│beta",
    cause: "served-range staleness",
  },
  E_TARGET_LOST: { servedLine: 2, path: "probe.ts", cause: "retirement" },
  E_UNVERIFIED_RANGE: {
    servedRows: [{ position: 0, hash: "abcd" }],
    servedBlock: "abcd│alpha",
    cause: "retirement",
  },
  E_UNSERVED_RANGE: {
    headline: "hole refused",
    servedRows: [],
    servedBlock: "",
    cause: "never-served",
  },
  E_MALFORMED_ANCHOR: {
    rawAnchor: "wxyz│x",
    reason: "anchor carries a row suffix and retry",
  },
  E_SUSPICIOUS_TEXT: {
    target: "edit",
    path: "probe.ts",
    line: 1,
    hash: "abcd",
    servedLine: 2,
    count: 1,
  },
  E_BATCH_ABORT: {
    earlierIndex: 0,
    laterIndex: 1,
    earlierStart: 1,
    earlierEnd: 2,
    laterStart: 2,
    laterEnd: 3,
    path: "probe.ts",
    servedBlock: "abcd│alpha",
  },
  E_NOOP_LOOP: {
    ref: "edit[0] (probe.ts)",
    removeFrom: "abcd",
    removeTo: "efgh",
    count: 3,
    batch: false,
    servedRows: [{ position: 0, hash: "abcd" }],
    servedBlock: "abcd│alpha",
  },
  E_UNSUPPORTED_FILE: { path: "probe.bin", kind: "binary" },
  E_ACCESS: { path: "probe.ts", kind: "denied", access: "read" },
  E_NOT_FOUND: { path: "probe.ts" },
  E_UNDO_STALE: { path: "probe.ts", reason: "modified" },
  E_UNDO_UNAVAILABLE: { path: "probe.ts" },
  E_LOSSY_TEXT: { path: "probe.bin" },
  E_UNDO_REVERT_FAILED: { path: "probe.ts" },
  E_UNKNOWN: { errorName: "Error", message: "boom" },
  E_LARGE_FILE: { path: "probe.ts", limitKind: "lines", lineCount: 99, limit: 5 },
  E_INTERNAL_INVARIANT: { message: "probe invariant" },
};

describe("edit refusal budget — deleted request bytes never render (T2 #327)", () => {
  it("no refusal message repeats the submitted request", () => {
    for (const input of MALFORMED_INPUTS) {
      expect(refusalOf(input)).not.toContain("Received: ");
      expect(preparedRefusalOf(input)).not.toContain("Received: ");
    }
  });

  it("no refusal inlines the served canonical-payload paragraph", () => {
    for (const input of MALFORMED_INPUTS) {
      expect(refusalOf(input)).not.toContain(
        "Edit must be called with exactly one payload per item",
      );
      expect(preparedRefusalOf(input)).not.toContain(
        "Edit must be called with exactly one payload per item",
      );
    }
  });

  // TODO(#328): decide whether the long hint survives — no serve path consumes EDIT_PAYLOAD_HINT today (scripts/served-prompts.mjs imports only EDIT_DESCRIPTION/SNIPPET/GUIDELINES).
  it("the long hint survives only as the unserved `hint` fragment", () => {
    const source = readFileSync("src/payload-contract.ts", "utf-8");
    const hits = source.split("Edit must be called with exactly one payload per item").length - 1;
    expect(hits).toBe(1);
  });

  it("E_SUSPICIOUS_TEXT with count 3 renders the count once", () => {
    const error = new DomainError("E_SUSPICIOUS_TEXT", {
      target: "edit",
      path: "probe.ts",
      line: 1,
      hash: "abcd",
      servedLine: 2,
      count: 3,
    });
    expect(error.message).toContain("(submission 3 times)");
    expect(error.message.split("3").length - 1).toBe(1);
    expect(error.message).not.toContain("Identical refusal");
  });

  it("no rendered registry message ends with a doubled terminator", () => {
    const rendered: string[] = [];
    for (const code of Object.keys(ERROR_REGISTRY).filter(isDomainErrorCode)) {
      const error = new DomainError(code, ERROR_EXAMPLES[code]);
      rendered.push(error.message);
    }
    rendered.push(
      formatWarning("W_NEVER_SERVED_SHAPE", { count: 2 }),
      formatWarning("W_SERVED_PREFIX_MISMATCH", { k: 1, anchor: "abcd", servedLine: 2 }),
      formatWarning("W_REVERSED_ANCHORS", { fromHash: "abcd", toHash: "efgh" }),
      formatWarning("W_UNICODE_LITERAL", { line: 3 }),
      formatWarning("W_LITERAL_BYPASS", {}),
      formatWarning("W_NOOP", {
        ref: "edit[0] (probe.ts)",
        removeFrom: "abcd",
        removeTo: "efgh",
        batch: true,
        count: 2,
      }),
      formatWarning("W_NOOP_INSERT", {
        ref: "edit[0] (probe.ts)",
        removeFrom: "abcd",
        removeTo: "efgh",
      }),
      formatWarning("W_EOL_REWRITTEN", { target: "LF", source: "env", changed: 2 }),
      formatWarning("W_UNSERVED_INTERIOR", { unservedLines: [2], replacedLineCount: 3 }),
      formatReadWarning("W_MIXED_EOL", {
        crlf: 1,
        lf: 2,
        cr: 0,
        target: "LF",
        source: "env",
      }),
    );
    for (const message of rendered) {
      expect(message).not.toContain("..");
    }
  });

  it("malformed-anchor reasons join the registry terminator exactly once", () => {
    const probes = ["+abcd│row", "-abcd│row", "abcd│row"];
    for (const anchor of probes) {
      let caught: unknown;
      try {
        resEdit({ anchor_from: anchor, anchor_to: anchor, text: "x" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      if (!(caught instanceof Error)) throw new Error("expected a DomainError");
      const message = caught.message;
      expect(message).toContain("retry.");
      expect(message).not.toContain("retry..");
    }
  });

  it("non-row │-suffix probe joins the registry terminator exactly once", () => {
    const probe = { anchor_from: "x│", anchor_to: "x│", text: "x" };
    let direct: unknown;
    try {
      resEdit(probe);
    } catch (error) {
      direct = error;
    }
    expect(direct).toBeInstanceOf(DomainError);
    if (!(direct instanceof Error)) throw new Error("expected a DomainError");
    expect(direct.message.endsWith("..")).toBe(false);
    expect(direct.message).not.toContain("..");
    const admitted = prepareEditArguments({ file: "probe.ts", edits: [probe] });
    const items = admitted.edits as { anchor_from: string; anchor_to: string; text: string }[];
    const item = items[0];
    if (item === undefined) throw new Error("expected one admitted edit");
    let viaAdmission: unknown;
    try {
      resEdit({ anchor_from: item.anchor_from, anchor_to: item.anchor_to, text: item.text });
    } catch (error) {
      viaAdmission = error;
    }
    expect(viaAdmission).toBeInstanceOf(DomainError);
    if (!(viaAdmission instanceof Error)) throw new Error("expected a DomainError");
    expect(viaAdmission.message.endsWith("..")).toBe(false);
    expect(viaAdmission.message).not.toContain("..");
  });

  it("touched codes keep audience, rows, and Options", () => {
    const suspicious = new DomainError("E_SUSPICIOUS_TEXT", {
      target: "edit",
      path: "probe.ts",
      line: 1,
      hash: "abcd",
      servedLine: 2,
      count: 1,
    });
    expect(suspicious.audience).toBe("MODEL");
    expect(suspicious.message).toContain("Options:");
    const undo = new DomainError("E_UNDO_UNAVAILABLE", { path: "probe.ts" });
    expect(undo.audience).toBe("MODEL");
    expect(undo.message).toContain("probe.ts is unchanged.");
    expect(undo.message).toContain("Options:");
    expect(ERROR_REGISTRY.E_UNDO_UNAVAILABLE.options).toEqual([
      "retry the edit",
      "use write if the store stays unavailable",
    ]);
  });
});
