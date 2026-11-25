import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/**
 * Warning-header ratchet (#348): applied `[AUDIENCE] [W_CODE]` renders only in
 * `src/domain-errors.ts` — `formatWarning`, `formatReadWarning` (bare `[code]`),
 * and the `DomainError` constructor. Rules flag `[MODEL]/[USER] [W_` literals and
 * bare `[W_CODE]` literals against empty allowlists; every file under `src/` scans.
 * SAFETY: headers survive only as interpolations, so per-literal matching stays green.
 * Limits: interpolation-split, tagged-template, and concatenation-split headers evade
 * this heuristic (#334); null-cooked quasis fall back to raw text and still scan.
 * `[W_*]` prose and `[Window warning: …]` lines never match the `\[W_[A-Z0-9_]+\]` token.
 */

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

type Literal = { file: string; line: number; value: string };

function nodeLine(node: AnyNode): number {
  const loc = node.loc as { start?: { line?: unknown } } | undefined;
  return typeof loc?.start?.line === "number" ? loc.start.line : 0;
}

function collectLiteralsFromCode(code: string, file: string): Literal[] {
  const out: Literal[] = [];
  const program = parse(code, { sourceType: "module", plugins: ["typescript"] })
    .program as unknown as AnyNode;
  walk(program, (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string") {
      out.push({ file, line: nodeLine(node), value: node.value as string });
    }
    if (node.type === "TemplateLiteral") {
      for (const quasi of (node.quasis as AnyNode[]) ?? []) {
        const quasiValue = quasi.value as { cooked?: unknown; raw?: unknown } | undefined;
        const cooked = quasiValue?.cooked;
        const raw = quasiValue?.raw;
        if (typeof cooked === "string") out.push({ file, line: nodeLine(quasi), value: cooked });
        else if (typeof raw === "string") out.push({ file, line: nodeLine(quasi), value: raw });
      }
    }
  });
  return out;
}

function stringLiterals(): Literal[] {
  const out: Literal[] = [];
  for (const file of srcFiles()) {
    out.push(...collectLiteralsFromCode(readFileSync(file, "utf-8"), file));
  }
  return out;
}

/** Rule 1 matcher: a rendered audience-prefixed warning header inside one literal. */
function hasAudiencePrefixedHeader(value: string): boolean {
  return /\[(?:MODEL|USER)\] \[W_/.test(value);
}

/** Rule 2 matcher: a rendered bare warning-code token inside one literal. */
function hasBareWarningCode(value: string): boolean {
  return /\[W_[A-Z0-9_]+\]/.test(value);
}

function audiencePrefixHits(): string[] {
  return stringLiterals()
    .filter((literal) => hasAudiencePrefixedHeader(literal.value))
    .map((literal) => `${literal.file}:${literal.line}`);
}

function bareCodeHits(): string[] {
  return stringLiterals()
    .filter((literal) => hasBareWarningCode(literal.value))
    .map((literal) => `${literal.file}:${literal.line}`);
}

const AUDIENCE_PREFIX_ALLOWLIST: { key: string; reason: string }[] = [];
const BARE_CODE_ALLOWLIST: { key: string; reason: string }[] = [];

describe("warning header producers (#348)", () => {
  it("holds no audience-prefixed [W_ header literal across src/", () => {
    expect(AUDIENCE_PREFIX_ALLOWLIST).toHaveLength(0);
    for (const entry of AUDIENCE_PREFIX_ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(0);
    expect(audiencePrefixHits()).toEqual(AUDIENCE_PREFIX_ALLOWLIST.map((entry) => entry.key));
  });

  it("holds no bare [W_CODE] header literal across src/", () => {
    expect(BARE_CODE_ALLOWLIST).toHaveLength(0);
    for (const entry of BARE_CODE_ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(0);
    expect(bareCodeHits()).toEqual(BARE_CODE_ALLOWLIST.map((entry) => entry.key));
  });

  it("pins the three sanctioned render sites inside src/domain-errors.ts", () => {
    const home = readFileSync(join("src", "domain-errors.ts"), "utf-8");
    expect(home).toContain("export function formatWarning");
    expect(home).toContain("export function formatReadWarning");
    expect(home).toContain("class DomainError");
    const readTier = readFileSync(join("src", "read.ts"), "utf-8");
    expect(readTier).toContain("formatReadWarning(");
  });

  it("sanctioned headers are interpolations, never rendered literals", () => {
    const home = readFileSync(join("src", "domain-errors.ts"), "utf-8");
    // Ref: docs/spec/unified-error-and-warning-contract.md — applied and reject share one interpolation shape.
    expect(home.split("[${spec.audience}] [${code}]").length - 1).toBeGreaterThanOrEqual(2);
    // Ref: docs/spec/unified-error-and-warning-contract.md — read tier is a bare interpolation, no audience prefix.
    const start = home.indexOf("export function formatReadWarning");
    expect(start).toBeGreaterThanOrEqual(0);
    const readTierFn = home.slice(start, home.indexOf("export class DomainError"));
    expect(readTierFn).toContain("[${code}]");
    expect(readTierFn).not.toContain("[MODEL]");
    expect(readTierFn).not.toContain("[USER]");
    expect(readTierFn).not.toContain("spec.audience");
  });

  it("collector floor: the scan parses the whole tree, so an empty hit list means clean", () => {
    // Ref: docs/spec/unified-error-and-warning-contract.md — measured 2026-11-25: 116 files, 5958 literals.
    // Ref: docs/spec/unified-error-and-warning-contract.md — floors sit just under; parse throws on failure.
    expect(srcFiles().length).toBeGreaterThanOrEqual(115);
    expect(stringLiterals().length).toBeGreaterThanOrEqual(5900);
  });

  it("synthetic control: the collector flags both injected header shapes in-test", () => {
    const synthetic = `export const a = "[USER] [W_FAKE] nope";\nexport const b = "[W_FAKE] nope";\n`;
    const literals = collectLiteralsFromCode(synthetic, "<synthetic>");
    expect(literals.filter((literal) => hasAudiencePrefixedHeader(literal.value))).toHaveLength(1);
    expect(literals.filter((literal) => hasBareWarningCode(literal.value))).toHaveLength(2);
  });

  it("negative controls: matchers fire on rendered headers and spare prose; a real code token still matches (comments stay green only because they are not literals)", () => {
    expect(hasAudiencePrefixedHeader("[USER] [W_FAKE] nope")).toBe(true);
    expect(hasBareWarningCode("[W_FAKE] nope")).toBe(true);
    expect(hasBareWarningCode("[USER] [W_FAKE] nope")).toBe(true);
    expect(hasAudiencePrefixedHeader("`[W_*]`/`[USER]` in `content` are informational")).toBe(
      false,
    );
    expect(hasBareWarningCode("`[W_*]`/`[USER]` in `content` are informational")).toBe(false);
    expect(hasBareWarningCode("[Window warning: Anchor 'ab12' not found; window omitted]")).toBe(
      false,
    );
    expect(hasBareWarningCode("the `[W_EOL_REWRITTEN]` line this plan discloses")).toBe(true);
  });
});
