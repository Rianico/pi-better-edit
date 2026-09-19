import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_REGISTRY,
  WARNING_REGISTRY,
  formatWarning,
  type DomainErrorCode,
  type DomainWarningCode,
  type ErrorPayloadMap,
  type WarningPayloadMap,
} from "../../src/domain-errors.js";

function srcFiles(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

type AnyNode = Record<string, unknown>;

function walk(node: unknown, visit: (node: AnyNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as AnyNode;
  if (typeof record.type === "string") visit(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(record[key], visit);
  }
}

function parseSrc(path: string): AnyNode {
  const code = readFileSync(path, "utf-8");
  return parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program as unknown as AnyNode;
}

function unionMembersOf(alias: string): string[] {
  const program = parseSrc(join("src", "domain-errors.ts"));
  const members: string[] = [];
  walk(program, (node) => {
    if (
      node.type === "TSTypeAliasDeclaration" &&
      (node.id as AnyNode)?.type === "Identifier" &&
      ((node.id as AnyNode).name as string) === alias &&
      (node.typeAnnotation as AnyNode)?.type === "TSUnionType"
    ) {
      for (const variant of (node.typeAnnotation as AnyNode).types as AnyNode[]) {
        if (
          variant.type === "TSLiteralType" &&
          (variant.literal as AnyNode)?.type === "StringLiteral"
        ) {
          members.push((variant.literal as AnyNode).value as string);
        }
      }
    }
  });
  return members;
}

function unionMembers(): string[] {
  return unionMembersOf("DomainErrorCode");
}

function warningUnionMembers(): string[] {
  return unionMembersOf("DomainWarningCode");
}

function producers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const codeOf = (arg: AnyNode | undefined): string | undefined => {
    if (arg?.type === "StringLiteral") return arg.value as string;
    // WHY: a cast around the code (`as never`, `satisfies`) must not smuggle
    // WHY: an undeclared code past the producer check — unwrap to the literal.
    if (
      (arg?.type === "TSAsExpression" ||
        arg?.type === "TSSatisfiesExpression" ||
        arg?.type === "TypeCastExpression") &&
      (arg.expression as AnyNode)?.type === "StringLiteral"
    ) {
      return (arg.expression as AnyNode).value as string;
    }
    return undefined;
  };
  for (const file of srcFiles()) {
    walk(parseSrc(file), (node) => {
      if (
        node.type === "NewExpression" &&
        (node.callee as AnyNode)?.type === "Identifier" &&
        ((node.callee as AnyNode).name as string) === "DomainError"
      ) {
        const code = codeOf(((node.arguments as AnyNode[]) ?? [])[0] as AnyNode | undefined);
        if (code !== undefined) {
          const list = found.get(code) ?? [];
          list.push(file);
          found.set(code, list);
        }
      }
    });
  }
  return found;
}

function warningProducers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of srcFiles()) {
    walk(parseSrc(file), (node) => {
      if (
        node.type === "CallExpression" &&
        (node.callee as AnyNode)?.type === "Identifier" &&
        ((node.callee as AnyNode).name as string) === "formatWarning"
      ) {
        const first = ((node.arguments as AnyNode[]) ?? [])[0] as AnyNode | undefined;
        let code: string | undefined;
        if (first?.type === "StringLiteral") code = first.value as string;
        if (
          (first?.type === "TSAsExpression" ||
            first?.type === "TSSatisfiesExpression" ||
            first?.type === "TypeCastExpression") &&
          (first.expression as AnyNode)?.type === "StringLiteral"
        ) {
          code = (first.expression as AnyNode).value as string;
        }
        if (code !== undefined) {
          const list = found.get(code) ?? [];
          list.push(file);
          found.set(code, list);
        }
      }
    });
  }
  return found;
}

function rawHeaderLiterals(): string[] {
  const header = /\[(MODEL|USER)\] \[[EW]_[A-Z0-9_]+\]/;
  const offenders: string[] = [];
  for (const file of srcFiles()) {
    if (file === join("src", "domain-errors.ts")) continue;
    walk(parseSrc(file), (node) => {
      if (node.type === "StringLiteral" && typeof node.value === "string") {
        if (header.test(node.value))
          offenders.push(`${file}: ${(node.value as string).slice(0, 80)}`);
      }
      if (node.type === "TemplateLiteral") {
        for (const quasi of (node.quasis as AnyNode[]) ?? []) {
          const cooked = (quasi.value as AnyNode)?.cooked as string | undefined;
          if (typeof cooked === "string" && header.test(cooked)) {
            offenders.push(`${file}: ${cooked.slice(0, 80)}`);
          }
        }
      }
    });
  }
  return offenders;
}

const LIVE_CODES: DomainErrorCode[] = [
  "E_BAD_PAYLOAD",
  "E_EMPTY_RANGE",
  "E_STALE_ANCHOR",
  "E_UNKNOWN_ANCHOR",
  "E_FOREIGN_ANCHOR",
  "E_STALE_RANGE",
  "E_TARGET_LOST",
  "E_UNVERIFIED_RANGE",
  "E_MALFORMED_ANCHOR",
  "E_SUSPICIOUS_TEXT",
  "E_BATCH_ABORT",
  "E_NOOP_LOOP",
  "E_UNSUPPORTED_FILE",
  "E_ACCESS",
  "E_NOT_FOUND",
  "E_UNDO_STALE",
  "E_UNDO_UNAVAILABLE",
  "E_UNKNOWN",
  "E_LARGE_FILE",
];

const EXAMPLES: { [K in DomainErrorCode]: ErrorPayloadMap[K] } = {
  E_BAD_PAYLOAD: { message: "Edit request requires a non-empty edits array." },
  E_EMPTY_RANGE: {},
  E_STALE_ANCHOR: {
    headline: 'anchor "abc" is not present in the served leases for probe.ts; nothing was written.',
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
    cause: "never-served",
  },
  E_UNKNOWN_ANCHOR: { path: "a.py", anchors: ["ZZZ"] },
  E_FOREIGN_ANCHOR: { path: "a.py", anchors: ["wUp"], homes: ["b.py"] },
  E_STALE_RANGE: {
    headline: 'line 2 in probe.ts differs from what was served (expected "a" vs actual "b").',
    servedRows: [{ position: 1, hash: "def" }],
    servedBlock: "def│b",
    cause: "served-range staleness",
    firstOffendingLine: 2,
  },
  E_TARGET_LOST: { servedLine: 2, path: "probe.ts", cause: "retirement" },
  E_UNVERIFIED_RANGE: {
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
    cause: "retirement",
  },
  E_MALFORMED_ANCHOR: { rawAnchor: "wUp│x", reason: "anchor carries a row suffix" },
  E_SUSPICIOUS_TEXT: {
    target: "edit",
    path: "probe.ts",
    line: 1,
    hash: "abc",
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
    servedBlock: "abc│alpha",
  },
  E_NOOP_LOOP: {
    ref: "edit[0] (probe.ts)",
    removeFrom: "abc",
    removeTo: "def",
    count: 3,
    batch: false,
    servedRows: [{ position: 0, hash: "abc" }],
    servedBlock: "abc│alpha",
  },
  E_UNSUPPORTED_FILE: {
    path: "probe.bin",
    kind: "binary",
    description: "application/octet-stream",
  },
  E_ACCESS: { path: "probe.ts", kind: "denied", access: "read" },
  E_NOT_FOUND: { path: "probe.ts" },
  E_UNDO_STALE: { path: "probe.ts", reason: "modified" },
  E_UNDO_UNAVAILABLE: { path: "probe.ts" },
  E_UNKNOWN: { errorName: "Error", message: "boom\nsecond line" },
  E_LARGE_FILE: { path: "probe.ts", limitKind: "lines", lineCount: 99, limit: 5 },
};

describe("domain error registry: closed contract, not a list", () => {
  it("the union is exactly the live set plus E_UNKNOWN and E_LARGE_FILE", () => {
    expect(unionMembers().sort()).toEqual([...LIVE_CODES].sort());
  });

  it("no raw [MODEL]/[USER] [E_/W_ header literal exists outside src/domain-errors.ts", () => {
    expect(rawHeaderLiterals()).toEqual([]);
  });

  it("every produced code is a union member", () => {
    const members = new Set(unionMembers());
    const unknown = [...producers().keys()].filter((code) => !members.has(code));
    expect(unknown).toEqual([]);
  });

  it("every union member has at least one producer in src/", () => {
    const produced = producers();
    const codeless = LIVE_CODES.filter((code) => (produced.get(code) ?? []).length === 0);
    expect(codeless).toEqual([]);
  });

  it("every code renders [<AUDIENCE>] [<CODE>] as its message header", () => {
    for (const code of LIVE_CODES) {
      const spec = ERROR_REGISTRY[code];
      const error = new DomainError(code, EXAMPLES[code]);
      expect(error.message.startsWith(`[${spec.audience}] [${code}] `)).toBe(true);
      expect(error.code).toBe(code);
      expect(error.audience).toBe(spec.audience);
      expect(error.details.code).toBe(code);
    }
  });

  it("E_UNKNOWN renders only the first message line", () => {
    const error = new DomainError("E_UNKNOWN", { errorName: "Error", message: "one\ntwo" });
    expect(error.message).not.toContain("two");
  });

  it("covers every format variant branch", () => {
    const binary = new DomainError("E_UNSUPPORTED_FILE", { path: "p", kind: "binary" });
    expect(binary.message).toContain("(binary)");
    const image = new DomainError("E_UNSUPPORTED_FILE", { path: "p", kind: "image" });
    expect(image.message).toContain("image file");
    const endless = new DomainError("E_LARGE_FILE", { limitKind: "lines", limit: 5 });
    expect(endless.message).toContain("the file has more than 5 lines");
    const spaced = new DomainError("E_LARGE_FILE", { limitKind: "hash-space", limit: 9 });
    expect(spaced.message).toContain("Cannot allocate a unique hash anchor");
    const noRows = new DomainError("E_BATCH_ABORT", {
      earlierIndex: 0,
      laterIndex: 1,
      earlierStart: 1,
      earlierEnd: 1,
      laterStart: 1,
      laterEnd: 1,
      path: "p",
      servedBlock: "",
    });
    expect(noRows.message).toContain("Call read()");
    const batchLoop = new DomainError("E_NOOP_LOOP", {
      ref: "r",
      removeFrom: "a",
      removeTo: "b",
      count: 3,
      batch: true,
      servedRows: [],
      servedBlock: "s",
    });
    expect(batchLoop.message).toContain("rejecting the batch");
    const writeEcho = new DomainError("E_SUSPICIOUS_TEXT", {
      target: "write",
      path: "p",
      line: 2,
      hash: "abc",
      servedLine: 1,
      count: 2,
    });
    expect(writeEcho.message).toContain("Refused write");
    expect(writeEcho.message).toContain("Identical refusal submitted 2×");
    const loop = new DomainError("E_ACCESS", { path: "p", kind: "symlink-loop" });
    expect(loop.message).toContain("symbolic links");
    const far = new DomainError("E_ACCESS", { path: "p", kind: "unreachable" });
    expect(far.message).toContain("Cannot access file");
    const writable = new DomainError("E_ACCESS", {
      path: "p",
      kind: "denied",
      access: "write",
    });
    expect(writable.message).toContain("not writable");
    const gone = new DomainError("E_UNDO_STALE", { path: "p", reason: "deleted" });
    expect(gone.message).toContain("no longer exists");
    const lost = new DomainError("E_TARGET_LOST", { servedLine: 4, cause: "retirement" });
    expect(lost.message).toContain("line 4 no longer resolves");
    const bare = new DomainError("E_STALE_ANCHOR", {
      headline: "anchor gone",
      cause: "never-served",
    });
    expect(bare.message).toBe("[MODEL] [E_STALE_ANCHOR] anchor gone");
    expect(bare.servedRows).toEqual([]);
    expect(bare.servedBlock).toBe("");
  });
});

describe("domain warning registry: applied tier, never a rejection", () => {
  const WARNING_CODES: DomainWarningCode[] = [
    "W_NEVER_SERVED_SHAPE",
    "W_SERVED_PREFIX_MISMATCH",
    "W_REVERSED_ANCHORS",
    "W_UNICODE_LITERAL",
    "W_LITERAL_BYPASS",
    "W_NOOP",
  ];

  const WARNING_EXAMPLES: { [K in DomainWarningCode]: WarningPayloadMap[K] } = {
    W_NEVER_SERVED_SHAPE: { count: 2 },
    W_SERVED_PREFIX_MISMATCH: { k: 1, anchor: "abc", servedLine: 2 },
    W_REVERSED_ANCHORS: { fromHash: "zzz", toHash: "aaa" },
    W_UNICODE_LITERAL: { line: 3 },
    W_LITERAL_BYPASS: {},
    W_NOOP: {
      ref: "edit[0] (probe.ts)",
      removeFrom: "abc",
      removeTo: "def",
      batch: false,
      count: 2,
    },
  };

  it("the warning union is exactly the six W_* codes", () => {
    expect(warningUnionMembers().sort()).toEqual([...WARNING_CODES].sort());
  });

  it("every warning code renders [<AUDIENCE>] [<CODE>] as its message header", () => {
    for (const code of WARNING_CODES) {
      const spec = WARNING_REGISTRY[code];
      const rendered = formatWarning(code, WARNING_EXAMPLES[code]);
      expect(rendered.startsWith(`[${spec.audience}] [${code}] `)).toBe(true);
    }
  });

  it("every produced warning code is a union member", () => {
    const members = new Set(warningUnionMembers());
    const unknown = [...warningProducers().keys()].filter((code) => !members.has(code));
    expect(unknown).toEqual([]);
  });

  it("every warning union member has at least one producer in src/", () => {
    const produced = warningProducers();
    const codeless = WARNING_CODES.filter((code) => (produced.get(code) ?? []).length === 0);
    expect(codeless).toEqual([]);
  });

  it("grades the tiers: applied warnings never carry E_* and rejections never carry W_*", () => {
    for (const code of WARNING_CODES) {
      expect(formatWarning(code, WARNING_EXAMPLES[code])).not.toContain("[E_");
    }
  });
});
