/**
 * Runs `scripts/bench-pair-trim.ts` through the real source: esbuild bundles the TS entry, node
 * executes the bundle from `.tmp/` (gitignored, inside the repo so bare imports resolve). Dev-only
 * (ticket #163, ADR-0044). Usage: `node scripts/bench-pair-trim.mjs`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { sandboxEnv } from "./lib/sandbox-env.mjs";

const root = new URL("../", import.meta.url).pathname;
const work = join(root, ".tmp");
await mkdir(work, { recursive: true });
const bundle = join(work, "bench-pair-trim.mjs");
const storeDir = await mkdtemp(join(tmpdir(), "pi-bench-pair-store-"));

try {
  await build({
    entryPoints: [join(root, "scripts/bench-pair-trim.ts")],
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
    env: { ...process.env, ...sandboxEnv(storeDir) },
  });
} finally {
  await rm(bundle, { force: true });
  await rm(storeDir, { recursive: true, force: true });
}
