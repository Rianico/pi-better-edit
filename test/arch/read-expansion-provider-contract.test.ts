/**
 * The provider contract seam — one declaration site, and no provider reaches the decision module.
 *
 * WHY a guard: the providers outlive the expansion decision layer. A provider that imports the
 * contract from the decision module compiles today and breaks the day that module is deleted, so
 * the direction of the import is the invariant worth pinning. The second case refutes a planted
 * violation: re-declaring a contract shape in the decision module passes every behaviour test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXPANSION_DIR = join("src", "read-expansion");
const CONTRACT_FILE = join(EXPANSION_DIR, "provider-contract.ts");
const DECISION_FILE = join(EXPANSION_DIR, "span-expansion.ts");

/** Every module that implements, composes or consumes the provider seam. */
const PROVIDER_MODULES = [
  "ast-provider.ts",
  "ast-span.ts",
  "bash-provider.ts",
  "markdown-provider.ts",
  "paragraph-provider.ts",
  "qualified-names.ts",
  "read-provider.ts",
];

/** Each contract declaration, by the shape the seam must keep. */
const CONTRACT_DECLARATIONS = [
  "interface SpanProvider",
  "type SpanWindow",
  "interface SpanDecline",
  "interface EnclosingSpan",
  "interface LineRange",
];

describe("provider contract seam", () => {
  it("declares every provider interface in the contract module", () => {
    const source = readFileSync(CONTRACT_FILE, "utf-8");
    for (const declaration of CONTRACT_DECLARATIONS) {
      expect(source, `provider-contract.ts is missing "${declaration}"`).toContain(declaration);
    }
  });

  it("keeps every provider's contract import pointed at the contract module", () => {
    for (const name of PROVIDER_MODULES) {
      const source = readFileSync(join(EXPANSION_DIR, name), "utf-8");
      expect(source, `${name} imports the contract from the decision module`).not.toContain(
        'from "./span-expansion.js"',
      );
    }
  });

  it("does not re-declare the contract in the decision module", () => {
    const source = readFileSync(DECISION_FILE, "utf-8");
    for (const declaration of CONTRACT_DECLARATIONS) {
      const pattern = new RegExp(`^(export\\s+)?${declaration}\\b`, "m");
      expect(source, `span-expansion.ts still declares "${declaration}"`).not.toMatch(pattern);
    }
  });
});
