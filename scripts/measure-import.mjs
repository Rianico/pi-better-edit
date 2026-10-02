#!/usr/bin/env node
/**
 * Measures the cost pi pays to import the extension entry, for the TypeScript source and for
 * the built artifact, with the cache state named.
 *
 * WHY: the reason the artifact is the entry on both install surfaces is module-import cost,
 * and jiti caches transforms in the OS temporary directory, so a number without its cache
 * state is meaningless. The measurement is pi's own instrumentation (`PI_TIMING=1` prints
 * `<entry> module import: <ms>` for the extensions timing namespace), driven through the real
 * CLI with `--no-extensions -e <entry>` so only the entry under test is loaded.
 *
 * Usage: node scripts/measure-import.mjs [--runs 3] [--pi pi] [--max-artifact-ms 450]
 *        --max-artifact-ms fails the run when the warm artifact median exceeds the budget.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { name: "source", entry: "index.ts" },
  { name: "artifact", entry: "dist/index.js" },
];

function parseArgs(argv) {
  const options = { runs: 3, pi: process.env.PI_BIN ?? "pi", maxArtifactMs: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      options.runs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--pi") {
      options.pi = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--max-artifact-ms") {
      options.maxArtifactMs = Number.parseFloat(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    console.error(`measure-import: unknown argument: ${arg}`);
    process.exit(1);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    console.error("measure-import: --runs needs a positive integer");
    process.exit(1);
  }
  return options;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measureOnce({ pi, entry, home, cacheDir }) {
  const result = spawnSync(pi, ["--mode", "rpc", "--no-extensions", "-e", entry], {
    cwd: ROOT,
    input: `${JSON.stringify({ id: "measure", type: "get_commands" })}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: cacheDir,
      PI_OFFLINE: "1",
      PI_TIMING: "1",
      NO_COLOR: "1",
    },
  });
  if (result.error) throw new Error(`could not run ${pi}: ${result.error.message}`);
  const match = `${result.stderr ?? ""}`.match(/^ {2}(.+?) module import: (\d+)ms$/m);
  if (match === null) {
    throw new Error(`${pi} printed no module import timing for ${entry}:\n${result.stderr ?? ""}`);
  }
  return Number.parseInt(match[2], 10);
}

function measure({ pi, target, home, cold, runs }) {
  const cacheDir = mkdtempSync(join(tmpdir(), "pi-better-edit-import-cache-"));
  try {
    if (cold) {
      const samples = [];
      for (let run = 0; run < runs; run += 1) {
        const freshCache = mkdtempSync(join(tmpdir(), "pi-better-edit-import-cache-"));
        try {
          samples.push(measureOnce({ pi, entry: target.entry, home, cacheDir: freshCache }));
        } finally {
          rmSync(freshCache, { recursive: true, force: true });
        }
      }
      return { state: "cold", samples };
    }
    measureOnce({ pi, entry: target.entry, home, cacheDir });
    const samples = [];
    for (let run = 0; run < runs; run += 1)
      samples.push(measureOnce({ pi, entry: target.entry, home, cacheDir }));
    return { state: "warm", samples };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = mkdtempSync(join(tmpdir(), "pi-better-edit-import-home-"));
  const results = new Map();
  try {
    for (const target of TARGETS) {
      const entryPath = resolve(ROOT, target.entry);
      if (!existsSync(entryPath)) {
        console.error(`measure-import: ${target.entry} is missing; run \`pnpm run build\` first`);
        process.exit(1);
      }
      for (const state of ["cold", "warm"]) {
        const { samples } = measure({
          pi: options.pi,
          target,
          home,
          cold: state === "cold",
          runs: options.runs,
        });
        results.set(`${target.name}:${state}`, { samples, median: median(samples) });
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  console.log(
    `measure-import: ${options.pi} (${spawnSync(options.pi, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "unknown"}), node ${process.version}, ${options.runs} samples per state`,
  );
  console.log("entry           cache   samples (ms)        median");
  for (const target of TARGETS) {
    for (const state of ["cold", "warm"]) {
      const { samples, median: middle } = results.get(`${target.name}:${state}`);
      console.log(
        `${target.name.padEnd(15)} ${state.padEnd(7)} ${samples.join(", ").padEnd(20)} ${middle} ms`,
      );
    }
  }
  const sourceWarm = results.get("source:warm").median;
  const artifactWarm = results.get("artifact:warm").median;
  console.log(
    `measure-import: artifact ${artifactWarm} ms warm against source ${sourceWarm} ms warm (${Math.round((1 - artifactWarm / sourceWarm) * 100)}% less)`,
  );
  if (options.maxArtifactMs !== undefined && artifactWarm > options.maxArtifactMs) {
    console.error(
      `measure-import: artifact module import ${artifactWarm} ms exceeds ${options.maxArtifactMs} ms`,
    );
    process.exit(1);
  }
}

main();
