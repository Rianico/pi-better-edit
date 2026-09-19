import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/**
 * Prose-neutrality linter (spec section 6, item 4: PROSE NEUTRALITY
 * LINTER, review-ruled form). `FILLER` is a small data-driven list, not
 * a verb blacklist: each banned patronizing phrase carries a reason,
 * and extending the list requires declaring one — the same discipline
 * as the terminology baseline. The scan owns src string literals via
 * the AST, and permits the single `mode: "literal"` escape in the
 * `E_SUSPICIOUS_TEXT` refusal payload while still banning filler
 * there and everywhere else.
 *
 * Falsifiability: `literalHasFiller` fails a planted literal holding a
 * filler phrase, and `reasonDeclared` fails a planted reason-less
 * entry (see the negative controls below).
 */

type FillerEntry = {
  phrase: string;
  reason: string;
};

const FILLER: FillerEntry[] = [
  {
    phrase: "No action is required",
    reason:
      "patronizing verdict: the E_*/W_* tier already states whether the call was refused, so the sentence adds no coordinates and instructs the model to stand down.",
  },
  {
    phrase: "run undo_last_edit",
    reason:
      "prescriptive directive: the applied-hint remedy already names the conditional retry (undo_last_edit with the same anchors and the anchor prefix dropped); a bare run order steers without evidence. The conditional remedy wording carries no 'run' prefix, so it stays green.",
  },
];

function reasonDeclared(entry: FillerEntry): boolean {
  return entry.reason.trim().length >= 20;
}

function literalHasFiller(value: string): FillerEntry[] {
  const lower = value.toLowerCase();
  return FILLER.filter((entry) => lower.includes(entry.phrase.toLowerCase()));
}

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

function stringLiterals(): Array<{ file: string; value: string }> {
  const out: Array<{ file: string; value: string }> = [];
  for (const file of srcFiles()) {
    const code = readFileSync(file, "utf-8");
    const program = parse(code, { sourceType: "module", plugins: ["typescript"] })
      .program as unknown as AnyNode;
    walk(program, (node) => {
      if (node.type === "StringLiteral" && typeof node.value === "string") {
        out.push({ file, value: node.value as string });
      }
      if (node.type === "TemplateLiteral") {
        for (const quasi of (node.quasis as AnyNode[]) ?? []) {
          const cooked = (quasi.value as AnyNode)?.cooked as string | undefined;
          if (typeof cooked === "string") out.push({ file, value: cooked });
        }
      }
    });
  }
  return out;
}

function fillerHits(): string[] {
  const hits: string[] = [];
  for (const { file, value } of stringLiterals()) {
    for (const entry of literalHasFiller(value)) {
      hits.push(`${file}: ${entry.phrase} in ${JSON.stringify(value.slice(0, 80))}`);
    }
  }
  return hits;
}

describe("prose neutrality linter: data-driven filler list (spec 6.4)", () => {
  it("every filler entry carries a declared reason", () => {
    expect(FILLER.length).toBeGreaterThan(0);
    for (const entry of FILLER) {
      expect(reasonDeclared(entry)).toBe(true);
    }
  });

  it("no src string literal holds a filler phrase", () => {
    expect(fillerHits()).toEqual([]);
  });

  it("permits the single literal-flag escape while still banning filler", () => {
    const domainErrors = readFileSync(join("src", "domain-errors.ts"), "utf-8");
    expect(domainErrors).toContain('mode: "literal"');
    expect(fillerHits()).toEqual([]);
  });

  it("negative control: a literal holding filler fails the scan", () => {
    const planted = "Edit applied. No action is required.";
    expect(literalHasFiller(planted).map((entry) => entry.phrase)).toContain(
      "No action is required",
    );
  });

  it("negative control: a reason-less entry fails the reason check", () => {
    expect(reasonDeclared({ phrase: "a new phrase", reason: "" })).toBe(false);
  });
});
