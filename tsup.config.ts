import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  bundle: true,
  dts: false,
  sourcemap: false,
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "diff",
    "file-type",
    "typebox",
    "xxhash-wasm",
  ],
});
