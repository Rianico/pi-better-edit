#!/usr/bin/env node
/**
 * The package `prepare` hook. It runs on every install path — the maintainer's working
 * copy, pi's git install (`npm install --omit=dev --legacy-peer-deps`,
 * `pnpm install --prod --config.auto-install-peers=false`, `bun install --omit=dev
 * --omit=peer`, each after `git clean -fdx`), and pack/publish.
 *
 * Two jobs, and the order is load-bearing: installing git hooks is optional and tolerated,
 * building the extension entry is mandatory. `husky || true && node scripts/build-dist.mjs`
 * would exit 0 after a failed build — the silent skip ADR-0027 forbids — so the tolerant
 * step runs first and the mandatory one decides the exit code.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function installGitHooks() {
  if (process.env.HUSKY === "0") return;
  const bin = join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "husky.cmd" : "husky",
  );
  if (!existsSync(bin)) {
    console.log("prepare: husky not installed; skipping git hooks");
    return;
  }
  const result = spawnSync(bin, [], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error || result.status !== 0) {
    console.log("prepare: git hooks were not installed; continuing");
  }
}

function build() {
  const result = spawnSync(process.execPath, ["scripts/build-dist.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`prepare: could not run the build: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`prepare: build failed with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

installGitHooks();
build();
