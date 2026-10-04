import { describe, expect, it } from "vitest";
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
