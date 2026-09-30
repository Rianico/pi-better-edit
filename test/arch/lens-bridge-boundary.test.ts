import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INTEGRATION_DIR = join("src", "integrations", "pi-lens");

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("lens bridge boundary", () => {
  it("keeps every pi-lens reference inside src/integrations/pi-lens", () => {
    const offenders = walkSources("src")
      .filter((file) => !file.startsWith(`${INTEGRATION_DIR}/`))
      .filter((file) => readFileSync(file, "utf-8").includes("pi-lens"));

    expect(offenders).toEqual([]);
  });

  it("keeps the served-span seam domain-neutral", () => {
    const source = readFileSync("src/served-spans.ts", "utf-8");

    expect(source).not.toContain("integrations");
    expect(source).not.toContain("globalThis");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import type { ServedRow } from "./domain-errors.js";']);
  });

  it("keeps the prompts free of the pi-lens token", () => {
    for (const file of ["prompts/read.md", "prompts/read-guidelines.md"]) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("pi-lens");
    }
  });

  it("wires the command and the adapter from the extension entry point", () => {
    const entry = readFileSync("index.ts", "utf-8");

    expect(entry).toContain('from "./src/integrations/pi-lens/command.js"');
    expect(entry).toContain('from "./src/integrations/pi-lens/read-bridge-adapter.js"');
    expect(entry).toContain("registerLensCommand(pi)");
    expect(entry).toContain("attachReadBridgeAdapter()");
    expect(entry).toContain("attachMutationBridgeAdapter()");
  });

  it("keeps the integration surface to the four settled modules", () => {
    expect(walkSources(INTEGRATION_DIR).sort()).toEqual([
      join(INTEGRATION_DIR, "command.ts"),
      join(INTEGRATION_DIR, "config.ts"),
      join(INTEGRATION_DIR, "mutation-bridge-adapter.ts"),
      join(INTEGRATION_DIR, "read-bridge-adapter.ts"),
    ]);
  });
});
