import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The build script's comment claims the esbuild target tracks `engines.node`;
// this pins the coupling so the two majors cannot drift silently.
describe("build target tracks engines.node", () => {
  it("TARGET's major equals the engines.node floor major", () => {
    const buildScript = readFileSync("scripts/build-dist.mjs", "utf8");
    const targetMajor = /^const TARGET = "node(\d+)";$/m.exec(buildScript)?.[1];
    expect(targetMajor).toBeDefined();
    const engines = (
      JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string } }
    ).engines.node;
    const floorMajor = /^>=(\d+)\./.exec(engines)?.[1];
    expect(floorMajor).toBeDefined();
    expect(targetMajor).toBe(floorMajor);
  });
});
