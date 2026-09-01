import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { normReq as payloadNormReq } from "../../src/payload-contract.js";
import { normReq as normalizeNormReq } from "../../src/edit-normalize.js";
import { editToolSchema as payloadSchema } from "../../src/payload-contract.js";
import { editToolSchema as editSchema } from "../../src/edit.js";

describe("C5 payload contract seam — single source", () => {
  it("edit-normalize re-exports same impl as payload-contract (identity via shim)", () => {
    expect(normalizeNormReq).toBe(payloadNormReq);
  });

  it("edit.ts re-exports same schema as payload-contract", () => {
    expect(editSchema).toBe(payloadSchema);
  });

  it("edit-normalize.ts is deprecated shim pointing to payload-contract", () => {
    const content = readFileSync("src/edit-normalize.ts", "utf8");
    expect(content).toMatch(/@deprecated/i);
    expect(content).toMatch(/payload-contract/);
  });

  it("edit.ts schema re-exports are deprecated", () => {
    const editContent = readFileSync("src/edit.ts", "utf8");
    // shallow check: deprecated marker near the schema re-export block
    expect(editContent).toMatch(/@deprecated/i);
  });

  it("pipeline imports NormalizedEditRequest from payload-contract, not edit-normalize", () => {
    const pipe = readFileSync("src/mutation-engine/pipeline.ts", "utf8");
    expect(pipe).toMatch(/from\s+["']\.\.\/payload-contract\.js["']/);
    expect(pipe).not.toMatch(/from\s+["']\.\.\/edit-normalize\.js["']/);
  });
});
