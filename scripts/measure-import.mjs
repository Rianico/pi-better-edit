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
 * WHY min-of-runs: a single sample sits inside the noise band (observed spread of ~150 ms on
 * this machine), so the budget is enforced against the minimum of the measured samples with
 * the first warm-up sample discarded, and the whole spread is printed.
 *
 * Usage: node scripts/measure-import.mjs [--runs 3] [--pi pi] [--max-artifact-ms 600]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { name: "source", entry: "index.ts" },
  { name: "artifact", entry: "dist/index.js" },
];

/**
 * WHY a ratio and not the absolute: a shared CI runner roughly 30% slower than a workstation
 * would false-fail an absolute budget. ADR-0027 measured 425-436 ms warm against 1077-1893 ms
 * of source import, so the artifact must stay well under the source it replaces; measured
 * ratios here are 0.54 and 0.59, and 0.75 leaves headroom. The absolute is still printed.
 */
const DEFAULT_MAX_RATIO = 0.75;

/** Reported, not gated: the number a workstation actually sees. */
const DEFAULT_MAX_ARTIFACT_MS = 600;

/**
 * WHY not plain "pi": `pnpm run` puts this repo's node_modules/.bin first on PATH, where the
 * pinned devDependency pi lives. That is a different runtime from the one users run, and it
 * does not print the same timing line, so a PATH entry inside this repo's node_modules is
 * skipped in favour of the pi the criterion is about.
 */
function resolvePiBinary(explicit) {
  if (explicit !== undefined) return explicit;
  const localBin = join(ROOT, "node_modules", ".bin");
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, process.platform === "win32" ? "pi.cmd" : "pi"))
    .filter((candidate) => existsSync(candidate));
  const external = candidates.find((candidate) => !candidate.startsWith(localBin));
  if (external === undefined) {
    // WHY: the repo's pinned devDependency pi is a different runtime and prints no timing line,
    // so falling back to it fails later with a misleading "printed no module import timing".
    throw new Error(`no pi on PATH outside ${localBin}; install pi or set PI_BIN`);
  }
  return external;
}

function parseArgs(argv) {
  const options = {
    runs: 3,
    pi: resolvePiBinary(process.env.PI_BIN),
    maxRatio: DEFAULT_MAX_RATIO,
    maxArtifactMs: DEFAULT_MAX_ARTIFACT_MS,
  };
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
    if (arg === "--max-ratio") {
      options.maxRatio = Number.parseFloat(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--max-artifact-ms") {
      options.maxArtifactMs = Number.parseFloat(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    console.error(`measure-import: unknown argument: ${arg}`);
    process.exitCode = 1;
    return undefined;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    console.error("measure-import: --runs needs a positive integer");
    process.exitCode = 1;
    return undefined;
  }
  return options;
}

function minimum(values) {
  return Math.min(...values);
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
    // One priming run, then runs + 1 samples with the first (warm-up) sample discarded.
    measureOnce({ pi, entry: target.entry, home, cacheDir });
    const collected = [];
    for (let run = 0; run < runs + 1; run += 1) {
      collected.push(measureOnce({ pi, entry: target.entry, home, cacheDir }));
    }
    return { state: "warm", samples: collected.slice(1) };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) return;
  const home = mkdtempSync(join(tmpdir(), "pi-better-edit-import-home-"));
  const results = new Map();
  try {
    for (const target of TARGETS) {
      const entryPath = resolve(ROOT, target.entry);
      if (!existsSync(entryPath)) {
        console.error(`measure-import: ${target.entry} is missing; run \`pnpm run build\` first`);
        process.exitCode = 1;
        return;
      }
      for (const state of ["cold", "warm"]) {
        const { samples } = measure({
          pi: options.pi,
          target,
          home,
          cold: state === "cold",
          runs: options.runs,
        });
        results.set(`${target.name}:${state}`, {
          samples,
          min: minimum(samples),
          median: median(samples),
          spread: Math.max(...samples) - minimum(samples),
        });
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const version =
    spawnSync(options.pi, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "unknown";
  console.log(
    `measure-import: ${options.pi} (${version}), node ${process.version}, ${options.runs} measured samples per state`,
  );
  console.log("entry           cache   samples (ms)                    min    median  spread");
  for (const target of TARGETS) {
    for (const state of ["cold", "warm"]) {
      const { samples, min, median: middle, spread } = results.get(`${target.name}:${state}`);
      console.log(
        `${target.name.padEnd(15)} ${state.padEnd(7)} ${samples.join(", ").padEnd(30)} ${String(min).padEnd(6)} ${String(middle).padEnd(7)} ${spread} ms`,
      );
    }
  }
  const sourceWarm = results.get("source:warm");
  const artifactWarm = results.get("artifact:warm");
  console.log(
    `measure-import: artifact ${artifactWarm.min} ms min / ${artifactWarm.median} ms median warm against source ${sourceWarm.min} ms min / ${sourceWarm.median} ms median warm`,
  );
  const ratio = artifactWarm.min / sourceWarm.min;
  console.log(
    `measure-import: warm artifact spread ${artifactWarm.spread} ms (min ${artifactWarm.min}, max ${Math.max(...artifactWarm.samples)}); absolute ${artifactWarm.min} ms against the reported ${options.maxArtifactMs} ms reference`,
  );
  console.log(
    `measure-import: ratio artifact/source ${ratio.toFixed(3)} against the ${options.maxRatio} gate (artifact ${artifactWarm.min} ms / source ${sourceWarm.min} ms)`,
  );
  if (ratio > options.maxRatio) {
    console.error(
      `measure-import: artifact/source ratio ${ratio.toFixed(3)} exceeds ${options.maxRatio} (artifact ${artifactWarm.min} ms, source ${sourceWarm.min} ms)`,
    );
    process.exitCode = 1;
  }
  if (artifactWarm.min > options.maxArtifactMs) {
    console.log(
      `measure-import: note: absolute ${artifactWarm.min} ms is above the ${options.maxArtifactMs} ms reference; the ratio gate decides`,
    );
  }
}

try {
  main();
} catch (error) {
  process.exitCode = 1;
  console.error(`measure-import: ${error.message}`);
}
