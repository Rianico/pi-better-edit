import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXPANSION_DIR = join("src", "read-expansion");
/** No parser dependency, no language-server client, no process or network import. */
const FORBIDDEN_IMPORTS = [
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "tree-sitter",
  "wasm",
  "lsp",
];
/** Calls that would mean this seam reaches outside its pure in-process contract. */
const FORBIDDEN_CALLS = ["fetch(", "spawn(", "spawnSync(", "execFile(", "request("];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("read expansion boundary", () => {
  it("spawns nothing, fetches nothing, and carries no parser or language-server dependency", () => {
    const files = sources(EXPANSION_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      const imports = source
        .split("\n")
        .filter((line) => line.startsWith("import ") || line.includes(' from "'))
        .join("\n")
        .toLowerCase();
      for (const token of FORBIDDEN_IMPORTS) {
        expect(imports, `${file} imports "${token}"`).not.toContain(token);
      }
      for (const call of FORBIDDEN_CALLS) {
        expect(source, `${file} calls "${call}"`).not.toContain(call);
      }
    }
  });

  it("keeps expansion independent of SERVED_MAX_LINES", () => {
    for (const file of sources(EXPANSION_DIR)) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("SERVED_MAX_LINES");
    }
  });
});
