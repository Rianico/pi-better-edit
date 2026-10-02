#!/usr/bin/env node
/**
 * Reproduces pi's git-install lifecycle for one package manager and asserts the artifact is
 * produced with devDependencies omitted.
 *
 * WHY (ADR-0027): pi clones a git source, runs `git clean -fdx` — which removes the
 * gitignored artifact — and then runs the package manager with devDependencies omitted. The
 * install must therefore produce the artifact from scratch with no bundler in the tree, and
 * it must fail when it cannot: pi drops a manifest entry whose path does not exist without a
 * message, and its dependency repair cannot see a missing artifact, so a silent skip would
 * persist across every future update.
 *
 * Usage: node scripts/install-surface-check.mjs --manager npm|pnpm|bun [--keep]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitAll, copyTrackedFiles, gitClean, initGitRepo, run } from "./lib/git-tree.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact arguments pi passes for a git source, from its package-manager install path. */
const MANAGERS = {
  npm: ["npm", ["install", "--omit=dev", "--legacy-peer-deps"]],
  pnpm: [
    "pnpm",
    [
      "install",
      "--prod",
      "--config.auto-install-peers=false",
      "--config.strict-peer-dependencies=false",
    ],
  ],
  bun: ["bun", ["install", "--omit=dev", "--omit=peer"]],
};

function fail(message) {
  console.error(`install-surface-check: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let manager;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manager") {
      manager = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === "--keep") {
      keep = true;
      continue;
    }
    fail(`unknown argument: ${argv[index]}`);
  }
  if (manager === undefined || !(manager in MANAGERS)) {
    fail(`--manager must be one of ${Object.keys(MANAGERS).join(", ")}`);
  }
  return { manager, keep };
}

function install(manager, cwd, env) {
  const [command, args] = MANAGERS[manager];
  return run(command, args, {
    cwd,
    env: { ...process.env, HUSKY: "0", ...env },
    allowFailure: true,
  });
}

function main() {
  const { manager, keep } = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync(join(tmpdir(), `pi-better-edit-install-${manager}-`));
  const tree = join(scratch, "pi-better-edit");
  const artifact = join(tree, "dist", "index.js");
  let exitCode = 0;
  try {
    const copied = copyTrackedFiles(ROOT, tree);
    initGitRepo(tree);
    commitAll(tree, "smoke source");
    gitClean(tree);
    console.log(
      `install-surface-check: ${manager}: git-checkout-shaped tree at ${tree} (${copied} tracked files, untracked removed)`,
    );
    if (existsSync(artifact))
      fail("the cleaned tree still contains the artifact; git clean did not remove it");

    const first = install(manager, tree, {});
    if (first.status !== 0) {
      fail(`${manager} install exited ${first.status}\n${first.stdout ?? ""}${first.stderr ?? ""}`);
    }
    if (!existsSync(artifact) || statSync(artifact).size === 0) {
      fail(
        `${manager} install exited 0 but produced no artifact: pi would resolve zero extensions silently`,
      );
    }
    const firstOutput = `${first.stdout ?? ""}${first.stderr ?? ""}`;
    if (!firstOutput.includes("provisioned in")) {
      fail(
        `${manager} install did not report a provisioned bundler; the no-local-bundler path did not run`,
      );
    }
    console.log(
      `install-surface-check: ${manager}: artifact produced with devDependencies omitted (provisioned bundler)`,
    );

    const esbuildInTree = existsSync(join(tree, "node_modules", "esbuild"));
    const esbuildBinInTree = existsSync(join(tree, "node_modules", ".bin", "esbuild"));
    if (esbuildInTree || esbuildBinInTree) {
      fail(
        `${manager} install added a bundler to the installed tree (node_modules/esbuild present)`,
      );
    }

    const manifest = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    if (Object.keys(manifest.dependencies ?? {}).includes("esbuild")) {
      fail("the manifest declares the bundler as a runtime dependency");
    }

    const verify = run(
      process.execPath,
      [join(ROOT, "scripts", "verify-dist.mjs"), "--package-root", tree],
      {
        cwd: ROOT,
        allowFailure: true,
      },
    );
    if (verify.status !== 0) {
      fail(
        `verify-dist rejected the installed artifact\n${verify.stdout ?? ""}${verify.stderr ?? ""}`,
      );
    }
    console.log(`install-surface-check: ${manager}: ${(verify.stdout ?? "").trim()}`);

    rmSync(join(tree, "dist"), { recursive: true, force: true });
    const broken = install(manager, tree, { PI_BUNDLER_BIN: join(scratch, "no-such-bundler") });
    if (broken.status === 0) {
      fail(
        `${manager} install exited 0 with an unusable bundler; the build was skipped instead of failing`,
      );
    }
    if (existsSync(artifact)) {
      fail(
        `${manager} install failed but left an artifact behind; the failure was not a clean stop`,
      );
    }
    const brokenOutput = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    if (!brokenOutput.includes("build-dist: PI_BUNDLER_BIN=")) {
      fail(`${manager} install failed for an unexpected reason\n${brokenOutput}`);
    }
    console.log(
      `install-surface-check: ${manager}: unusable bundler fails the install (exit ${broken.status}), no artifact written`,
    );
  } catch (error) {
    exitCode = 1;
    console.error(`install-surface-check: ${error.message}`);
  } finally {
    if (keep) console.log(`install-surface-check: kept ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main();
