/**
 * One config ladder for `.pi/agents/pi-better-edit.json` (#90, acceptance item 6).
 *
 * The file, the two scopes, the read and the preserving atomic write live in `src/json-config.ts`
 * and nowhere else: a second hand-rolled ladder over one file is how two settings owners drift apart,
 * and the boundary test next door already forbids the integration directory from being imported from
 * outside itself. This guard pins the inverse direction — the settings owners reach the seam instead
 * of re-deriving it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SEAM = join("src", "json-config.ts");
const SETTINGS_OWNERS = [
  join("src", "bash-view-config.ts"),
  // WHY: (ADR-0049 M6) the multi-file caps are a second per-key ladder over the same file, so they
  // WHY: reach the seam exactly like the view owner instead of re-deriving it.
  join("src", "bash-multifile-config.ts"),
  join("src", "integrations", "pi-lens", "config.ts"),
  join("src", "store-config.ts"),
  // WHY: the janitor settings ladder moved to the kernel (arch-04); it reads the shared seam like every
  // WHY: other settings owner and must not grow its own file access.
  join("src", "store-kernel", "settings.ts"),
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the config file has one owner (#90)", () => {
  it("names the config file location in exactly one module", () => {
    // The literal is what a second copy would hard-code; the seam's own constant is the only one.
    const namers = tsFiles("src").filter((file) =>
      readFileSync(file, "utf-8").includes(".pi/agents/pi-better-edit.json"),
    );

    expect(namers).toEqual([SEAM]);
  });

  it("routes every settings owner through the seam rather than reading the file itself", () => {
    for (const file of SETTINGS_OWNERS) {
      const source = readFileSync(file, "utf-8");

      expect(source, file).toMatch(/from "[^"]*json-config\.js"/);
      expect(source, file).not.toContain("readFileSync");
      expect(source, file).not.toContain("writeFileSync");
      expect(source, file).not.toContain("renameSync");
    }
  });

  it("keeps the seam's readers and writer exported for both owners", () => {
    const seam = readFileSync(SEAM, "utf-8");

    for (const symbol of ["readScopeConfig", "updateConfigFile", "configFilePath", "CONFIG_REL"]) {
      expect(seam, symbol).toContain(
        `export ${symbol === "CONFIG_REL" ? "const" : "function"} ${symbol}`,
      );
    }
  });
});
