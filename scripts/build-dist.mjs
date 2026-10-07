#!/usr/bin/env node
/**
 * Builds the extension entry declared by `pi.extensions` / `main` in package.json.
 *
 * WHY: pi installs a git source with devDependencies omitted (npm `install --omit=dev
 * --legacy-peer-deps`, pnpm `install --prod --config.auto-install-peers=false`, bun
 * `install --omit=dev --omit=peer`) after `git clean -fdx`, and it drops manifest entries
 * whose path does not exist without a message. The build therefore has to work with no
 * devDependencies present, and it has to fail loudly: a silent skip recreates the 2.2.0
 * regression, where the gitignored artifact was cleaned away, zero extensions resolved,
 * and pi's dependency repair could not see the missing file.
 *
 * Usage: node scripts/build-dist.mjs [--outfile dist/index.js] [--entry index.ts]
 *        --entry is the seam the metafile-guard mutation uses to bundle a fixture.
 * Env:   PI_BUNDLER_BIN  explicit bundler binary; skips discovery and provisioning
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pinned so the artifact never depends on the consumer's toolchain. `pnpm-workspace.yaml`
 * pins the same version in its `overrides` block for the devDependency.
 */
export const PINNED_BUNDLER = "esbuild@0.28.2";

export const ENTRY = "index.ts";
export const DEFAULT_OUTFILE = "dist/index.js";

/**
 * Host-provided packages stay external: pi aliases them to its own copies, and a vendored
 * copy builds a second module graph (measured upstream at 720 ms of 838 ms). The four
 * runtime dependencies (`diff`, `file-type`, `unbash`, `xxhash-wasm`) stay unbundled
 * so a user install gets them from the registry (`typebox` and `@earendil-works/*`
 * are host-provided peer surfaces, likewise external).
 */
export const EXTERNALS = [
  "diff",
  "file-type",
  "unbash",
  "xxhash-wasm",
  "typebox",
  "@earendil-works/*",
];

/** The esbuild target tracks `engines.node`; esbuild preserves the `node:` specifier prefixes. */
const TARGET = "node24";

/** Thrown so enclosing `finally` blocks still reclaim their temp directories. */
class ScriptFailure extends Error {}

function fail(message) {
  throw new ScriptFailure(message);
}

function bundlerVersion(bin) {
  try {
    const output = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = output.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function localBundlerBin() {
  const name = process.platform === "win32" ? "esbuild.cmd" : "esbuild";
  return join(ROOT, "node_modules", ".bin", name);
}

/**
 * Provisions the pinned bundler into a throwaway prefix so the install-time build needs no
 * devDependency. Every attempt is recorded; if none produces a working binary the build
 * fails instead of shipping a package with no extension entry.
 */
function provisionBundler() {
  const prefix = mkdtempSync(join(tmpdir(), "pi-better-edit-bundler-"));
  const attempts = [
    {
      manager: "npm",
      args: [
        "install",
        "--prefix",
        prefix,
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        PINNED_BUNDLER,
      ],
    },
    {
      manager: "pnpm",
      args: [
        "add",
        "--dir",
        prefix,
        "--ignore-workspace-root-check",
        "--reporter=silent",
        PINNED_BUNDLER,
      ],
    },
    {
      manager: "bun",
      args: ["add", "--cwd", prefix, "--no-save", "--silent", PINNED_BUNDLER],
    },
  ];
  const failures = [];
  for (const attempt of attempts) {
    const result = spawnSync(attempt.manager, attempt.args, {
      cwd: prefix,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.error) {
      failures.push(`${attempt.manager}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").at(-1) ?? "";
      failures.push(`${attempt.manager}: exit ${result.status}${detail ? ` (${detail})` : ""}`);
      continue;
    }
    const bin = join(
      prefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "esbuild.cmd" : "esbuild",
    );
    if (bundlerVersion(bin) !== null) {
      return {
        bin,
        description: `${PINNED_BUNDLER} provisioned in ${prefix}`,
        cleanup: () => rmSync(prefix, { recursive: true, force: true }),
      };
    }
    failures.push(`${attempt.manager}: no working esbuild binary at ${bin}`);
  }
  rmSync(prefix, { recursive: true, force: true });
  fail(
    `cannot build without a bundler and provisioning ${PINNED_BUNDLER} failed:\n  ${failures.join("\n  ")}`,
  );
}

function resolveBundler() {
  const override = process.env.PI_BUNDLER_BIN;
  if (override !== undefined && override.length > 0) {
    if (bundlerVersion(override) === null) {
      fail(`PI_BUNDLER_BIN=${override} is not a working bundler`);
    }
    return { bin: override, description: `${override} (PI_BUNDLER_BIN)`, cleanup: () => {} };
  }
  const local = localBundlerBin();
  if (existsSync(local) && bundlerVersion(local) !== null) {
    return { bin: local, description: `${local} (local devDependency)`, cleanup: () => {} };
  }
  return provisionBundler();
}

function bundlerArgs(entry, outfile, metafile) {
  return [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--target=${TARGET}`,
    `--outfile=${outfile}`,
    `--metafile=${metafile}`,
    ...EXTERNALS.map((name) => `--external:${name}`),
  ];
}

/**
 * The externals list is the contract; this is the invariant behind it. Without the guard a
 * new bare import would be silently inlined, which is the vendored-host-graph failure the
 * externals exist to prevent, and the output scan in verify-dist cannot see it.
 */
function assertNothingBundledFromNodeModules(metafilePath) {
  const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
  const inlined = Object.keys(metafile.inputs ?? {}).filter((input) =>
    input.includes("node_modules/"),
  );
  if (inlined.length > 0) {
    fail(`host packages must stay external, but the bundle inlined: ${inlined.sort().join(", ")}`);
  }
}

function parseArgs(argv) {
  let outfile = DEFAULT_OUTFILE;
  let entry = ENTRY;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--outfile" || arg === "--entry") {
      if (value === undefined || value.length === 0) fail(`${arg} needs a path`);
      if (arg === "--outfile") outfile = value;
      else entry = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  // WHY: --entry is a test seam. Defaulting the output to the canonical artifact would let a
  // seam caller that passes --entry and forgets --outfile silently overwrite dist/index.js.
  if (argv.includes("--entry") && !argv.includes("--outfile")) {
    fail("--entry requires an explicit --outfile");
  }
  return { entry: resolve(ROOT, entry), outfile: resolve(ROOT, outfile) };
}

function main() {
  const { entry, outfile } = parseArgs(process.argv.slice(2));
  if (!existsSync(entry)) fail(`entry ${relative(ROOT, entry)} is missing`);

  const bundler = resolveBundler();
  mkdirSync(dirname(outfile), { recursive: true });
  const metafileDir = mkdtempSync(join(tmpdir(), "pi-better-edit-metafile-"));
  const metafile = join(metafileDir, "metafile.json");
  try {
    const result = spawnSync(bundler.bin, bundlerArgs(entry, outfile, metafile), {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.error) fail(`bundler failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`bundler exited with code ${result.status}`);
    assertNothingBundledFromNodeModules(metafile);
  } finally {
    rmSync(metafileDir, { recursive: true, force: true });
    bundler.cleanup();
  }

  if (!existsSync(outfile) || statSync(outfile).size === 0) {
    fail(`bundler reported success but ${relative(ROOT, outfile)} is missing or empty`);
  }
  console.log(
    `build-dist: wrote ${relative(ROOT, outfile)} from ${relative(ROOT, entry)} using ${bundler.description}`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof ScriptFailure) {
    process.exitCode = 1;
    console.error(`build-dist: ${error.message}`);
  } else {
    throw error;
  }
}
