import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INTEGRATION_DIR = join("src", "integrations", "pi-lens");
const ENTRY = "index.ts";

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sourceFilesOutsideIntegration(): string[] {
  return walkSources("src").filter((file) => !file.startsWith(`${INTEGRATION_DIR}/`));
}

describe("lens bridge boundary", () => {
  it("keeps every pi-lens reference inside src/integrations/pi-lens", () => {
    const offenders = sourceFilesOutsideIntegration().filter((file) =>
      readFileSync(file, "utf-8").includes("pi-lens"),
    );

    expect(offenders).toEqual([]);
  });

  it("lets only the extension entry point wire the integration dir", () => {
    const importers = sourceFilesOutsideIntegration().filter((file) =>
      /from "[^"]*integrations\/pi-lens/.test(readFileSync(file, "utf-8")),
    );

    expect(importers).toEqual([]);
    expect(readFileSync(ENTRY, "utf-8")).toContain(
      'from "./src/integrations/pi-lens/io-bridge-adapter.js"',
    );
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

  it("wires the command and the unified adapter from the extension entry point", () => {
    const entry = readFileSync(ENTRY, "utf-8");

    expect(entry).toContain('from "./src/integrations/pi-lens/command.js"');
    expect(entry).toContain('from "./src/integrations/pi-lens/io-bridge-adapter.js"');
    expect(entry).toContain("registerLensCommand(pi)");
    expect(entry).toContain("attachIOBridgeAdapter()");
    expect(entry).not.toContain("attachReadBridgeAdapter");
    expect(entry).not.toContain("attachMutationBridgeAdapter");
  });

  it("keeps the integration surface to the four settled v2 modules", () => {
    expect(walkSources(INTEGRATION_DIR).sort()).toEqual([
      join(INTEGRATION_DIR, "command.ts"),
      join(INTEGRATION_DIR, "config.ts"),
      join(INTEGRATION_DIR, "io-bridge-adapter.ts"),
      join(INTEGRATION_DIR, "io-bridge.ts"),
    ]);
  });

  it("probes the v2 mount from the command status surface, never the retired v1 keys", () => {
    const command = readFileSync(join(INTEGRATION_DIR, "command.ts"), "utf-8");

    expect(command).toContain('"pi-lens:io-bridge"');
    expect(command).not.toContain('"pi-lens:read-bridge"');
    expect(command).not.toContain('"pi-lens:mutation-bridge"');
  });
});
