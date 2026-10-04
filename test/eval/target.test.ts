import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { makeFakePiRegistry } from "../support/fixtures";
import { adaptReadParamsForLegacy } from "./target";

describe("adaptReadParamsForLegacy", () => {
  it("maps file to path and preserves the other fields", () => {
    expect(adaptReadParamsForLegacy({ file: "notes.ts", offset: 2, limit: 3 })).toEqual({
      path: "notes.ts",
      offset: 2,
      limit: 3,
    });
  });

  it("passes through params that already speak the legacy wire", () => {
    expect(adaptReadParamsForLegacy({ path: "already.ts" })).toEqual({ path: "already.ts" });
  });

  it("passes through non-object params", () => {
    expect(adaptReadParamsForLegacy(undefined)).toBeUndefined();
    expect(adaptReadParamsForLegacy("nope")).toBe("nope");
  });
});

// WHY: item 4 translates `{file}` -> `{path}` on the assumption that the published comparator's
// WHY: read speaks the legacy `path` wire. That wire is unverified and not introspectable
// WHY: (`test/eval/upstream.d.ts` declares the package untyped), so only the gated witness below can
// WHY: settle it. The package is absent from node_modules unless `scripts/eval-compare.mjs` symlinks
// WHY: it in — that flow now runs this file — so skip when it does not resolve; never install it here.
// WHY: gate on node's own resolution so "runnable" matches the `await import` the witness then does.
const requireFromTest = createRequire(import.meta.url);
function resolvesFromTest(specifier: string): boolean {
  try {
    requireFromTest.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
const packagePresent =
  resolvesFromTest("pi-hashline-edit-pro") || resolvesFromTest("pi-hashline-edit-pro/package.json");

describe.skipIf(!packagePresent)("published comparator read wire", () => {
  it("keys the read tool on path, the wire adaptReadParamsForLegacy translates for", async () => {
    const { default: packageRegister } = (await import("pi-hashline-edit-pro")) as {
      default: (pi: unknown) => void;
    };
    const { pi, getTool } = makeFakePiRegistry();
    packageRegister(pi);

    const properties = (getTool("read") as { parameters: { properties: Record<string, unknown> } })
      .parameters.properties;
    expect(properties).toHaveProperty("path");
  });
});
