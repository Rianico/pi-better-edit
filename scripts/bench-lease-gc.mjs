/**
 * Runs `scripts/bench-lease-gc.ts` through the real source: esbuild bundles the TS entry, node runs
 * it from `.tmp/` (gitignored, inside the repo so bare imports resolve). Dev-only (ticket #160).
 * Usage: `node scripts/bench-lease-gc.mjs`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const work = join(root, ".tmp");
await mkdir(work, { recursive: true });
const bundle = join(work, "bench-lease-gc.mjs");
const storeDir = await mkdtemp(join(tmpdir(), "pi-bench-lease-gc-store-"));

try {
  await build({
    entryPoints: [join(root, "scripts/bench-lease-gc.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    external: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
      "file-type",
      "xxhash-wasm",
    ],
    logLevel: "warning",
  });
  execFileSync(process.execPath, [bundle], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PI_BETTER_EDIT_CONFIG_DIR: storeDir },
  });
} finally {
  await rm(bundle, { force: true });
  await rm(storeDir, { recursive: true, force: true });
}
