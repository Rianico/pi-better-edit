import { existsSync } from "node:fs";
import { join } from "node:path";
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

// WHY: item 4 translates `{file}` -> `{path}` on the premise that the published comparator's
// WHY: read speaks the legacy `path` wire. That wire is documented by CHANGELOG.md:8 (the removed
// WHY: `file_path` alias was rewritten to `path` for read_skill/undo_last_edit) rather than
// WHY: introspectable: test/eval/upstream.d.ts declares `pi-hashline-edit-pro` untyped. This
// WHY: witness skips when the package is absent — do not network-install it here.
const packagePresent = existsSync(
  join(process.cwd(), "node_modules", "pi-hashline-edit-pro", "package.json"),
);

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
    expect(properties).not.toHaveProperty("file");
  });
});
