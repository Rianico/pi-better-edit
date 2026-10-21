/**
 * Runs `scripts/bench-adopt.ts` through the real source: esbuild bundles the TS entry, node executes
 * the bundle. Why a bundle: the repo has no TS runtime for plain `node`, and a benchmark that measured
 * anything other than the shipped code would be measuring the wrong thing.
 *
 * Dev-only (ticket #162, ADR-0043). Usage: `node scripts/bench-adopt.mjs`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
// WHY: the bundle must live inside the repo so its bare imports resolve from the repo's
// WHY: node_modules (`.tmp/` is gitignored), never from a sibling package's copy.
const work = join(root, ".tmp");
await mkdir(work, { recursive: true });
const bundle = join(work, "bench-adopt.mjs");
const storeDir = await mkdtemp(join(tmpdir(), "pi-bench-adopt-store-"));

try {
  await build({
    // WHY: the bundle lives outside the repo, so every bare import must resolve from the repo's
    // WHY: node_modules — running the process with `cwd: root` is what makes that work.
    entryPoints: [join(root, "scripts/bench-adopt.ts")],
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
