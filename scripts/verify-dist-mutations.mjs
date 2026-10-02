#!/usr/bin/env node
/**
 * Demonstrates that scripts/verify-dist.mjs actually fails on each violation it claims to
 * catch, by mutating the artifact and the manifest and asserting a non-zero exit.
 *
 * WHY: a verification step that passes on a broken artifact is worse than no step at all.
 * Every check in verify-dist.mjs is exercised here against a deliberate mutation, so a
 * check that silently stopped working shows up as a missing failure.
 *
 * Usage: node scripts/verify-dist-mutations.mjs
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ARTIFACT = join(DIST, "index.js");
const SCRATCH = join(ROOT, ".tmp", "verify-dist-mutations");

function fail(message) {
  console.error(`verify-dist-mutations: ${message}`);
  process.exit(1);
}

function run(args) {
  return spawnSync(process.execPath, ["scripts/verify-dist.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function writeMutantArtifact(name, transform) {
  const code = readFileSync(ARTIFACT, "utf8");
  const mutated = transform(code);
  if (mutated === code)
    fail(`mutation ${name} changed nothing; the artifact no longer matches the assumption`);
  const path = join(DIST, `__mutant-${name}.js`);
  writeFileSync(path, mutated, "utf8");
  return path;
}

function writeMutantManifest(name, mutate) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  mutate(manifest);
  const path = join(SCRATCH, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function main() {
  mkdirSync(SCRATCH, { recursive: true });
  const build = spawnSync(process.execPath, ["scripts/build-dist.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) fail("could not build the artifact to mutate");
  if (!existsSync(ARTIFACT)) fail("dist/index.js is missing after the build");

  const mutants = [];
  const mutations = [];
  const addMutation = (name, args, expectation) => mutations.push({ name, args, expectation });

  const missing = join(DIST, "__mutant-missing.js");
  addMutation("artifact-missing", ["--artifact", missing], "artifact is missing");

  const nestedDir = join(DIST, "nested");
  const nested = join(nestedDir, "index.js");
  mutants.push(nestedDir);
  mkdirSync(nestedDir, { recursive: true });
  copyFileSync(ARTIFACT, nested);
  addMutation(
    "nested-artifact",
    ["--artifact", nested],
    "prompt assets no longer resolve relative to the artifact",
  );

  const promptRef = writeMutantArtifact("prompt-ref", (code) =>
    code.replaceAll("../prompts/read.md", "../prompts/__missing__.md"),
  );
  mutants.push(promptRef);
  addMutation(
    "prompt-ref-missing",
    ["--artifact", promptRef],
    "a referenced prompt asset does not exist",
  );

  const strippedNode = writeMutantArtifact("stripped-node-prefix", (code) =>
    code.replaceAll('from "node:', 'from "'),
  );
  mutants.push(strippedNode);
  addMutation(
    "stripped-node-prefix",
    ["--artifact", strippedNode],
    "a node: prefix was rewritten to a bare builtin",
  );

  const undeclared = writeMutantArtifact(
    "undeclared-package",
    (code) => `${code}\nimport "left-pad";\n`,
  );
  mutants.push(undeclared);
  addMutation(
    "undeclared-bare-package",
    ["--artifact", undeclared],
    "an undeclared bare package is left for the runtime",
  );

  const notFactory = writeMutantArtifact("default-export", (code) =>
    code.replace("index_default as default", "index_default as notDefault"),
  );
  mutants.push(notFactory);
  addMutation(
    "default-export-not-a-factory",
    ["--artifact", notFactory],
    "the artifact does not default-export a factory",
  );

  const stale = join(DIST, "__mutant-stale.js");
  mutants.push(stale);
  copyFileSync(ARTIFACT, stale);
  const longAgo = new Date(statSync(join(ROOT, "src")).mtimeMs - 24 * 60 * 60 * 1000);
  utimesSync(stale, longAgo, longAgo);
  addMutation("stale-artifact", ["--artifact", stale], "the artifact predates its sources");

  const noDist = writeMutantManifest("entry-not-packed", (manifest) => {
    manifest.files = manifest.files.filter((entry) => entry !== "dist");
  });
  mutants.push(noDist);
  addMutation(
    "entry-not-in-packed-file-set",
    ["--manifest", noDist, "--package-root", ROOT, "--artifact", ARTIFACT],
    "the packed file set does not contain the manifest entry",
  );

  const noPrompts = writeMutantManifest("prompts-not-packed", (manifest) => {
    manifest.files = manifest.files.filter((entry) => entry !== "prompts");
  });
  mutants.push(noPrompts);
  addMutation(
    "prompt-assets-not-in-packed-file-set",
    ["--manifest", noPrompts, "--package-root", ROOT, "--artifact", ARTIFACT],
    "a prompt asset resolves outside the packed file set",
  );

  const twoEntries = writeMutantManifest("two-entries", (manifest) => {
    manifest.pi.extensions = ["./dist/index.js", "./index.ts"];
  });
  mutants.push(twoEntries);
  addMutation(
    "manifest-two-entries",
    ["--manifest", twoEntries, "--package-root", ROOT, "--artifact", ARTIFACT],
    "pi.extensions declares more than one entry",
  );

  const mainMismatch = writeMutantManifest("main-mismatch", (manifest) => {
    manifest.main = "index.ts";
  });
  mutants.push(mainMismatch);
  addMutation(
    "manifest-main-mismatch",
    ["--manifest", mainMismatch, "--package-root", ROOT, "--artifact", ARTIFACT],
    "main and pi.extensions disagree",
  );

  const sourceEntry = writeMutantManifest("source-entry", (manifest) => {
    manifest.main = "./index.ts";
    manifest.pi.extensions = ["./index.ts"];
  });
  mutants.push(sourceEntry);
  addMutation(
    "manifest-points-at-source",
    ["--manifest", sourceEntry, "--package-root", ROOT, "--artifact", ARTIFACT],
    "pi.extensions points at source",
  );

  try {
    const baseline = run([]);
    if (baseline.status !== 0) {
      fail(`verify-dist.mjs must pass on the unmutated artifact:\n${baseline.stderr.trim()}`);
    }
    console.log("verify-dist-mutations: baseline artifact passes");

    let failures = 0;
    for (const mutation of mutations) {
      const result = run(mutation.args);
      const message = `${result.stderr}${result.stdout}`.trim().split("\n")[0] ?? "";
      if (result.status === 0) {
        failures += 1;
        console.error(
          `verify-dist-mutations: FAIL ${mutation.name}: verify-dist.mjs passed; expected ${mutation.expectation}`,
        );
        continue;
      }
      console.log(`verify-dist-mutations: ok ${mutation.name} (${message})`);
    }
    if (failures > 0) fail(`${failures} mutation(s) went undetected`);
    console.log(`verify-dist-mutations: ${mutations.length} mutations all detected`);
  } finally {
    for (const mutant of mutants) rmSync(mutant, { recursive: true, force: true });
  }
}

main();
