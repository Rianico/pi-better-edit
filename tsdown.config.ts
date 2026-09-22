import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  // WHY: tsdown emits .mjs for ESM by default, but package.json sets type=module and
  // WHY: `main` points at dist/index.js; publint fails the build if these drift apart.
  outExtensions: () => ({ js: ".js" }),
  dts: false,
  sourcemap: false,
  // WHY: `false` = do not transform built-in imports (tsdown's default, stated explicitly).
  // WHY: tsdown's `nodeProtocol: "strip"` mode would rewrite `node:sqlite` to bare `sqlite`,
  // WHY: which resolves at build time but throws MODULE_NOT_FOUND when pi loads the extension.
  nodeProtocol: false,
  // WHY: validates package.json entry resolution (main/files) against the real artifact.
  publint: true,
});
