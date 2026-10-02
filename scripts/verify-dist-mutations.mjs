#!/usr/bin/env node
/**
 * Demonstrates that scripts/verify-dist.mjs and scripts/build-dist.mjs actually fail on each
 * violation they claim to catch, by mutating the artifact, the manifest and the bundle input
 * and asserting a non-zero exit with the expected diagnostic.
 *
 * WHY: a verification step that passes on a broken artifact is worse than no step at all.
 * Every check is exercised here against a deliberate mutation, and the expected message is
 * asserted too — a mutant that trips an unrelated check, or that crashes later for a
 * different reason, must not be recorded as a pass.
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

/** Thrown so enclosing `finally` blocks still reclaim the mutants. */
class ScriptFailure extends Error {}

function fail(message) {
  throw new ScriptFailure(message);
}

function run(args) {
  return spawnSync(process.execPath, ["scripts/verify-dist.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function runBuild(args) {
  return spawnSync(process.execPath, ["scripts/build-dist.mjs", ...args], {
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
  const addMutation = (name, args, expected, kind = "verify") =>
    mutations.push({ name, args, expected, kind });

  const missing = join(DIST, "__mutant-missing.js");
  addMutation("artifact-missing", ["--artifact", missing], "is missing or empty");

  const nestedDir = join(DIST, "nested");
  const nested = join(nestedDir, "index.js");
  mutants.push(nestedDir);
  mkdirSync(nestedDir, { recursive: true });
  copyFileSync(ARTIFACT, nested);
  addMutation(
    "nested-artifact",
    ["--artifact", nested],
    "does not resolve relative to the artifact",
  );

  const promptRef = writeMutantArtifact("prompt-ref", (code) =>
    code.replaceAll("../prompts/read.md", "../prompts/__missing__.md"),
  );
  mutants.push(promptRef);
  addMutation(
    "prompt-ref-missing",
    ["--artifact", promptRef],
    "does not resolve relative to the artifact",
  );

  const strippedNode = writeMutantArtifact("stripped-node-prefix", (code) =>
    code.replaceAll('from "node:', 'from "'),
  );
  mutants.push(strippedNode);
  addMutation("stripped-node-prefix", ["--artifact", strippedNode], "unresolvable bare specifiers");

  const undeclared = writeMutantArtifact(
    "undeclared-package",
    (code) => `${code}\nimport "left-pad";\n`,
  );
  mutants.push(undeclared);
  addMutation(
    "undeclared-bare-package",
    ["--artifact", undeclared],
    "unresolvable bare specifiers",
  );

  // WHY: static import statements are not the only way a specifier reaches the runtime; a
  // stripped prefix inside import() or require() is the same 2.1.0 failure class.
  const dynamicImport = writeMutantArtifact(
    "dynamic-import-node-prefix",
    (code) => `${code}\nasync function __smoke() { await import("sqlite"); }\n`,
  );
  mutants.push(dynamicImport);
  addMutation(
    "dynamic-import-stripped-node-prefix",
    ["--artifact", dynamicImport],
    "unresolvable bare specifiers",
  );

  const requireCall = writeMutantArtifact(
    "require-node-prefix",
    (code) => `${code}\nfunction __smoke() { return require("sqlite"); }\n`,
  );
  mutants.push(requireCall);
  addMutation(
    "require-stripped-node-prefix",
    ["--artifact", requireCall],
    "unresolvable bare specifiers",
  );

  const notFactory = writeMutantArtifact("default-export", (code) =>
    code.replace("index_default as default", "index_default as notDefault"),
  );
  mutants.push(notFactory);
  addMutation(
    "default-export-not-a-factory",
    ["--artifact", notFactory],
    "does not export a valid factory function",
  );

  const stale = join(DIST, "__mutant-stale.js");
  mutants.push(stale);
  copyFileSync(ARTIFACT, stale);
  const longAgo = new Date(statSync(join(ROOT, "src")).mtimeMs - 24 * 60 * 60 * 1000);
  utimesSync(stale, longAgo, longAgo);
  addMutation("stale-artifact", ["--artifact", stale], "is stale");

  const noDist = writeMutantManifest("entry-not-packed", (manifest) => {
    manifest.files = manifest.files.filter((entry) => entry !== "dist");
  });
  mutants.push(noDist);
  addMutation(
    "entry-not-in-packed-file-set",
    ["--manifest", noDist, "--package-root", ROOT, "--artifact", ARTIFACT],
    "does not contain the manifest entry",
  );

  const noPrompts = writeMutantManifest("prompts-not-packed", (manifest) => {
    manifest.files = manifest.files.filter((entry) => entry !== "prompts");
  });
  mutants.push(noPrompts);
  addMutation(
    "prompt-assets-not-in-packed-file-set",
    ["--manifest", noPrompts, "--package-root", ROOT, "--artifact", ARTIFACT],
    "the packed file set does not contain",
  );

  const twoEntries = writeMutantManifest("two-entries", (manifest) => {
    manifest.pi.extensions = ["./dist/index.js", "./index.ts"];
  });
  mutants.push(twoEntries);
  addMutation(
    "manifest-two-entries",
    ["--manifest", twoEntries, "--package-root", ROOT, "--artifact", ARTIFACT],
    "must declare exactly one entry",
  );

  const mainMismatch = writeMutantManifest("main-mismatch", (manifest) => {
    manifest.main = "index.ts";
  });
  mutants.push(mainMismatch);
  addMutation(
    "manifest-main-mismatch",
    ["--manifest", mainMismatch, "--package-root", ROOT, "--artifact", ARTIFACT],
    "must be the same single entry",
  );

  const sourceEntry = writeMutantManifest("source-entry", (manifest) => {
    manifest.main = "./index.ts";
    manifest.pi.extensions = ["./index.ts"];
  });
  mutants.push(sourceEntry);
  addMutation(
    "manifest-points-at-source",
    ["--manifest", sourceEntry, "--package-root", ROOT, "--artifact", ARTIFACT],
    "points at source",
  );

  const hostDependency = writeMutantManifest("host-package-as-runtime-dependency", (manifest) => {
    manifest.dependencies.typebox = manifest.peerDependencies.typebox;
  });
  mutants.push(hostDependency);
  addMutation(
    "host-package-as-runtime-dependency",
    ["--manifest", hostDependency, "--package-root", ROOT, "--artifact", ARTIFACT],
    "host-provided package",
  );

  // WHY: the externals list is the contract, the metafile guard is the invariant behind it. A
  // bare import that is not externalized gets inlined from node_modules, which the output scan
  // cannot see, so this guard is exercised through the build itself.
  const guardEntry = join(SCRATCH, "metafile-guard-entry.ts");
  writeFileSync(guardEntry, 'import "@babel/parser";\nexport const fixture = 1;\n', "utf8");
  addMutation(
    "metafile-guard-inlined-host-package",
    ["--entry", guardEntry, "--outfile", join(SCRATCH, "metafile-guard.js")],
    "host packages must stay external",
    "build",
  );

  try {
    const baseline = run([]);
    if (baseline.status !== 0) {
      fail(`verify-dist.mjs must pass on the unmutated artifact:\n${baseline.stderr.trim()}`);
    }
    console.log("verify-dist-mutations: baseline artifact passes");

    let failures = 0;
    for (const mutation of mutations) {
      const result = mutation.kind === "build" ? runBuild(mutation.args) : run(mutation.args);
      const output = `${result.stdout}${result.stderr}`;
      const message = output.trim().split("\n")[0] ?? "";
      if (result.status === 0) {
        failures += 1;
        console.error(
          `verify-dist-mutations: FAIL ${mutation.name}: exit 0; expected a failure containing "${mutation.expected}"`,
        );
        continue;
      }
      if (!output.includes(mutation.expected)) {
        failures += 1;
        console.error(
          `verify-dist-mutations: FAIL ${mutation.name}: failed for the wrong reason; expected "${mutation.expected}", got "${message}"`,
        );
        continue;
      }
      const matched =
        output.split("\n").find((line) => line.includes(mutation.expected)) ?? message;
      console.log(`verify-dist-mutations: ok ${mutation.name} (${matched.trim()})`);
    }
    if (failures > 0) fail(`${failures} mutation(s) went undetected`);
    console.log(
      `verify-dist-mutations: ${mutations.length} mutations all detected for the expected reason`,
    );
  } finally {
    for (const mutant of mutants) rmSync(mutant, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof ScriptFailure) {
    process.exitCode = 1;
    console.error(`verify-dist-mutations: ${error.message}`);
  } else {
    throw error;
  }
}
