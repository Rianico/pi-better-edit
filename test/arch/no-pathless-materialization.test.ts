import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
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
    if (key === "loc") continue;
    walk(record[key], visit);
  }
}

function calleeName(callee: unknown): string | undefined {
  const c = callee as AnyNode;
  if (c.type === "Identifier") return c.name as string;
  if (c.type === "MemberExpression" && (c.property as AnyNode)?.type === "Identifier") {
    return (c.property as AnyNode).name as string;
  }
  return undefined;
}

describe("file materialization always carries a path (ticket-06 C5/C9)", () => {
  it("C5: no pathless hashesFor/hashesForSync/lineHashes call in production sources", () => {
    // WHY: the pathless overloads are gone — every file materialization passes
    // WHY: the canonical absolute path. The explicit content-only API is
    // WHY: `contentOnlyHashes` (never scanned here); `fileHashesFor` always
    // WHY: takes the path first. A flagged call is a read/write-agreement hole.
    const offenders: string[] = [];
    for (const file of tsFiles("src")) {
      const code = readFileSync(file, "utf-8");
      const program = parse(code, { sourceType: "module", plugins: ["typescript"] })
        .program as unknown as AnyNode;
      walk(program, (node) => {
        if (node.type !== "CallExpression") return;
        const name = calleeName(node.callee);
        if (name !== "hashesFor" && name !== "hashesForSync" && name !== "lineHashes") return;
        const args = node.arguments as unknown[];
        if (args.length < 2) offenders.push(`${file}: ${name} with ${args.length} arg(s)`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("C9: allocation base indices come only from the two derivation owners", () => {
    // WHY: `% HASH_SPACE` is the index-forming operation — it may appear only in
    // WHY: `contentBaseIndex`/`fileBaseIndex`, and the legacy `>>> 14` confinement
    // WHY: only in the content-only one. Anything else computes anchors ad hoc.
    const moduloSites: string[] = [];
    const shiftSites: string[] = [];
    for (const file of tsFiles("src")) {
      const code = readFileSync(file, "utf-8");
      const program = parse(code, { sourceType: "module", plugins: ["typescript"] })
        .program as unknown as AnyNode;
      walk(program, (node) => {
        if (node.type !== "BinaryExpression") return;
        const right = node.right as AnyNode;
        if (node.operator === "%" && right?.type === "Identifier" && right.name === "HASH_SPACE") {
          moduloSites.push(file);
        }
        if (node.operator === ">>>" && right?.type === "NumericLiteral" && right.value === 14) {
          shiftSites.push(file);
        }
      });
    }
    expect(moduloSites).toEqual(["src/hashline/hash-identity.ts", "src/hashline/hash-identity.ts"]);
    expect(shiftSites).toEqual(["src/hashline/hash-identity.ts"]);
  });
});
