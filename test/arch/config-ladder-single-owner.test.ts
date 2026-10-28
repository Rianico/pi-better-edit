/**
 * One naming module for the settings locations (#90, #190 acceptance item 1).
 *
 * The PATH LITERALS live in `src/config-dir.ts` and nowhere else: a second copy is how an adoption
 * ladder silently reads a location nobody meant it to, and the relocation moved three of them at
 * once (settings dir, project dir, retired sources). The read/write/adopt CONTRACT lives in
 * `src/json-config.ts`, which every settings owner reaches instead of touching the file — the
 * boundary test next door already forbids the integration directory from being imported from
 * outside itself, so this guard pins the inverse direction.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SEAM = join("src", "json-config.ts");
const PATH_OWNER = join("src", "config-dir.ts");
const CURRENT_PROJECT_LITERAL = ".pi/agents/pi-better-edit/settings.json";
const RETIRED_FLAT_LITERAL = ".pi/agents/pi-better-edit.json";
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

function namers(literal: string): string[] {
  return tsFiles("src").filter((file) => readFileSync(file, "utf-8").includes(literal));
}

describe("the settings file has one owner (#90, #190)", () => {
  it("names the current project location in exactly one module", () => {
    expect(namers(CURRENT_PROJECT_LITERAL)).toEqual([PATH_OWNER]);
  });

  it("names the retired flat location in exactly one module", () => {
    expect(namers(RETIRED_FLAT_LITERAL)).toEqual([PATH_OWNER]);
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

    for (const symbol of [
      "readScopeConfig",
      "updateConfigFile",
      "configFilePath",
      "displayPath",
      "CONFIG_REL",
      "CONFIG_FILE_NAME",
    ]) {
      expect(seam, symbol).toContain(symbol);
    }
  });

  it("takes its paths from the naming module instead of spelling them", () => {
    expect(readFileSync(SEAM, "utf-8")).toMatch(/from "\.\/config-dir\.js"/);
  });
});
