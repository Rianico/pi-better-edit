import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const EXPANSION_DIR = join("src", "read-expansion");
const SHIPPED_DIRS = ["src", "prompts", "dist"];

/** The only files allowed to reach the grammar runtime or the network. */
const GRAMMAR_FILES = new Set([
  "ast-span.ts",
  "grammar-cache.ts",
  "grammar-manifest.ts",
  "grammar-runtime.ts",
  "ast-provider.ts",
]);

/** Process and transport imports no read-expansion file may carry. */
const FORBIDDEN_PROCESS_IMPORTS = [
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
];

/** Calls that would mean the pure seam reaches outside its in-process contract. */
const SEAM_FORBIDDEN_CALLS = [
  "fetch(",
  "spawn(",
  "spawnSync(",
  "execFile(",
  "request(",
  "install(",
  "propose(",
  "startServer(",
  "languageServer(",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function wasmFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) wasmFiles(path, out);
    else if (entry.isFile() && path.endsWith(".wasm")) out.push(path);
  }
  return out;
}

function importLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => line.startsWith("import ") || line.includes(' from "'))
    .join("\n")
    .toLowerCase();
}

describe("read expansion boundary", () => {
  it("keeps the pure seam free of parser, network and process imports", () => {
    const files = sources(EXPANSION_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      const imports = importLines(source);
      for (const token of FORBIDDEN_PROCESS_IMPORTS) {
        expect(imports, `${file} imports "${token}"`).not.toContain(token);
      }
      expect(imports, `${file} imports the native parser`).not.toMatch(/from "tree-sitter"/);
      if (GRAMMAR_FILES.has(basename(file))) continue;
      for (const token of ["tree-sitter", "wasm", "lsp"]) {
        expect(imports, `${file} imports "${token}"`).not.toContain(token);
      }
      for (const call of SEAM_FORBIDDEN_CALLS) {
        expect(source, `${file} calls "${call}"`).not.toContain(call);
      }
    }
  });

  it("uses only the sanctioned wasm runtime in the grammar modules", () => {
    for (const name of GRAMMAR_FILES) {
      const source = readFileSync(join(EXPANSION_DIR, name), "utf-8");
      const imports = importLines(source);
      expect(imports, `${name} imports the native parser`).not.toMatch(/from "tree-sitter"/);
      expect(imports, `${name} imports an LSP client`).not.toContain("lsp");
    }
  });

  it("does not ship a grammar wasm file in the package", () => {
    const shipped = SHIPPED_DIRS.flatMap((dir) => wasmFiles(dir));
    expect(shipped).toEqual([]);
  });

  it("keeps expansion independent of SERVED_MAX_LINES", () => {
    for (const file of sources(EXPANSION_DIR)) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("SERVED_MAX_LINES");
    }
  });
  it("keeps the optional wasm runtime off the extension load path", () => {
    const staticValueImport = /^\s*import\s+(?!type\s)[^;\n]*["']web-tree-sitter["']/m;
    for (const file of [join("index.ts"), ...sources("src")]) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(staticValueImport);
    }
    expect(readFileSync(join(EXPANSION_DIR, "grammar-runtime.ts"), "utf-8")).toContain(
      'import("web-tree-sitter")',
    );
  });

  it("declares the wasm runtime as an optional dependency", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies?.["web-tree-sitter"]).toBe("0.27.1");
    expect(manifest.dependencies?.["web-tree-sitter"]).toBeUndefined();
  });

  it("wires the default provider without an enrichment resolver", () => {
    expect(readFileSync("index.ts", "utf-8")).toContain("createReadSpanProvider()");
  });
});
