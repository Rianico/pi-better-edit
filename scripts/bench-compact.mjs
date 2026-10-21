/**
 * Runs `scripts/bench-compact.ts` through the real source (ticket #161, ADR-0046). Dev-only.
 * Usage: `node scripts/bench-compact.mjs`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const work = join(root, ".tmp");
await mkdir(work, { recursive: true });
const bundle = join(work, "bench-compact.mjs");
const storeDir = await mkdtemp(join(tmpdir(), "pi-bench-compact-store-"));

try {
  await build({
    entryPoints: [join(root, "scripts/bench-compact.ts")],
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
