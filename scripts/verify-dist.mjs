#!/usr/bin/env node
/**
 * Verifies the built extension entry the way pi loads it, rather than trusting that the
 * bundler exited 0.
 *
 * WHY (ADR-0027): pi drops manifest entries whose path does not exist without a message,
 * and its dependency repair compares only `dependencies` against `node_modules`, so a
 * missing artifact resolves zero extensions permanently. A bundle that builds can still
 * throw at extension load, strip a `node:` prefix, inline a host package, or resolve its
 * prompt assets relative to a directory that does not exist. Each of those is checked here
 * and each check is demonstrated to fail by scripts/verify-dist-mutations.mjs.
 *
 * Usage: node scripts/verify-dist.mjs [--artifact <path>] [--manifest <path>]
 *                                    [--package-root <dir>] [--skip-freshness]
 *        --artifact / --manifest / --package-root are the seams the mutation harness uses;
 *        they default to the real manifest entry in this package.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Inputs whose mtime must not be newer than the artifact: a stale artifact ships old code. */
const FRESHNESS_INPUTS = ["index.ts", "src", "package.json", "scripts/build-dist.mjs"];

/** File timestamps and tar extraction do not preserve sub-second ordering. */
const FRESHNESS_TOLERANCE_MS = 2000;

const REQUIRED_TOOLS = ["edit", "read", "read_skill", "undo_last_edit"];
const REQUIRED_COMMAND = "pi-better-edit";

/** pi aliases these to its own copies; they must stay external, optional peers. */
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

/** Thrown so enclosing `finally` blocks still reclaim their temp directories. */
class ScriptFailure extends Error {}

function fail(message) {
  throw new ScriptFailure(message);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function parseArgs(argv) {
  const options = {
    artifact: undefined,
    manifest: undefined,
    packageRoot: undefined,
    skipFreshness: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-freshness") {
      options.skipFreshness = true;
      continue;
    }
    if (arg === "--artifact" || arg === "--manifest" || arg === "--package-root") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) fail(`${arg} needs a path`);
      if (arg === "--artifact") options.artifact = value;
      if (arg === "--manifest") options.manifest = value;
      if (arg === "--package-root") options.packageRoot = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return options;
}

function readManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    fail(`cannot read ${manifestPath}: ${cause.message}`);
  }
}

/**
 * npm `files` semantics for the entries this package uses: plain paths and simple globs.
 * The packed file list decides whether the manifest entry survives `pack`, which is the
 * 2.2.0 failure class — the entry was declared but absent from the tarball.
 */
function expandFiles(packageRoot, patterns) {
  const packed = new Set();
  const addFile = (absolutePath) => packed.add(toPosix(relative(packageRoot, absolutePath)));
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else addFile(absolutePath);
    }
  };
  const walkAll = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "coverage" ||
        entry.name === ".tmp"
      ) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) walkAll(absolutePath);
      else addFile(absolutePath);
    }
  };
  for (const pattern of patterns ?? []) {
    if (/[*?[\]{}]/.test(pattern)) {
      const matcher = globToRegExp(pattern);
      const collected = new Set();
      const before = new Set(packed);
      walkAll(packageRoot);
      for (const candidate of packed) {
        if (!before.has(candidate) && matcher.test(candidate)) collected.add(candidate);
      }
      for (const candidate of packed) {
        if (!before.has(candidate) && !collected.has(candidate)) packed.delete(candidate);
      }
      continue;
    }
    const absolutePath = resolve(packageRoot, pattern);
    if (!existsSync(absolutePath)) continue;
    if (statSync(absolutePath).isDirectory()) walk(absolutePath);
    else addFile(absolutePath);
  }
  return packed;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split("\u0000")
    .join(".*");
  return new RegExp(`^${source}$`);
}

function maxMtimeMs(paths, packageRoot) {
  let newest = 0;
  const visit = (absolutePath) => {
    if (!existsSync(absolutePath)) return;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath, { withFileTypes: true }))
        visit(join(absolutePath, entry.name));
      return;
    }
    newest = Math.max(newest, stats.mtimeMs);
  };
  for (const input of paths) visit(resolve(packageRoot, input));
  return newest;
}

/**
 * Module specifiers the artifact leaves for the runtime.
 *
 * Static statements are read off esbuild's own output shape: every module statement starts at
 * the beginning of a line, so a scan anchored there cannot pick up prompt text that happens to
 * contain the word `from` inside a string. Dynamic `import()` and `require()` calls are not
 * anchored that way, so their string-literal arguments are collected separately — a stripped
 * prefix inside `import("sqlite")` is the same 2.1.0 failure class as one inside a static
 * import, and the reviewer demonstrated that bypass against the anchored scan alone.
 *
 * Each specifier must resolve: either a Node builtin that kept its `node:` prefix, or a
 * package the manifest declares. A stripped prefix (`node:sqlite` -> `sqlite`) is exactly
 * what broke 2.1.0 and no package.json lint catches it.
 */
function bareSpecifiers(code) {
  const specifiers = new Set();
  const addIfBare = (specifier) => {
    if (specifier === undefined) return;
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:"))
      return;
    specifiers.add(specifier);
  };
  const lines = code.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:import|export)\b/.test(lines[index])) continue;
    let statement = lines[index];
    let lookahead = index;
    while (
      !/\bfrom\s*["']/.test(statement) &&
      !/^\s*import\s*["']/.test(statement) &&
      lookahead < lines.length - 1 &&
      !statement.trimEnd().endsWith(";")
    ) {
      lookahead += 1;
      statement += `\n${lines[lookahead]}`;
      if (lookahead - index > 64) break;
    }
    const specifier =
      statement.match(/\bfrom\s*["']([^"']+)["']/)?.[1] ??
      statement.match(/^\s*import\s*["']([^"']+)["']/)?.[1];
    addIfBare(specifier);
    index = lookahead;
  }
  for (const pattern of [
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) addIfBare(match[1]);
  }
  return specifiers;
}

function packageNameOf(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

/**
 * ADR-0027 decision 4: the three host packages are provided by pi, so they must never be
 * runtime dependencies — a user install would then pull a second copy of pi's own module graph
 * — and they must stay declared as optional peers, which is also what keeps npm's peer
 * auto-install from fetching them into the user's tree.
 */
function assertHostPackagesAreOptionalPeers(manifest) {
  const dependencies = manifest.dependencies ?? {};
  const peers = manifest.peerDependencies ?? {};
  const peerMeta = manifest.peerDependenciesMeta ?? {};
  for (const name of HOST_PACKAGES) {
    if (Object.keys(dependencies).includes(name)) {
      fail(`host-provided package ${name} is a runtime dependency; it must be an optional peer`);
    }
    if (!Object.keys(peers).includes(name)) {
      fail(`host-provided package ${name} is missing from peerDependencies`);
    }
    if (peerMeta[name]?.optional !== true) {
      fail(`host-provided package ${name} is not marked optional in peerDependenciesMeta`);
    }
  }
}

function assertSpecifiersResolve(code, manifest) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  const offenders = new Set();
  for (const specifier of bareSpecifiers(code)) {
    const name = packageNameOf(specifier);
    if (builtins.has(name) || !declared.has(name)) offenders.add(specifier);
  }
  if (offenders.size > 0) {
    fail(
      `the artifact leaves unresolvable bare specifiers (stripped node: prefix or undeclared package): ${[...offenders].sort().join(", ")}`,
    );
  }
}

function assertPromptAssets(code, artifactPath, packageRoot, packed) {
  const refs = new Set(
    [...code.matchAll(/["'](\.\.?\/prompts\/[A-Za-z0-9._-]+\.md)["']/g)].map((match) => match[1]),
  );
  if (refs.size === 0) {
    fail("no prompt asset references found in the artifact; the extraction pattern is stale");
  }
  for (const ref of refs) {
    const resolved = new URL(ref, pathToFileURL(artifactPath));
    if (!existsSync(resolved)) {
      fail(`prompt asset ${ref} does not resolve relative to the artifact (${artifactPath})`);
    }
    const packedRelative = toPosix(relative(packageRoot, fileURLToPath(resolved)));
    if (!packed.has(packedRelative)) {
      fail(
        `prompt asset ${ref} resolves to ${packedRelative}, which the packed file set does not contain`,
      );
    }
    if (readFileSync(resolved, "utf8").trim().length === 0) {
      fail(`prompt asset ${ref} is empty`);
    }
  }
  return refs;
}

async function assertLoadsThroughPiLoader(discoveryTarget, artifactPath, packageRoot) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-edit-verify-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-better-edit-verify-agent-"));
  try {
    const result = await discoverAndLoadExtensions([discoveryTarget], cwd, agentDir);
    if (result.errors.length > 0) {
      fail(
        `pi's extension loader rejected the artifact: ${result.errors.map(({ error }) => error).join("; ")}`,
      );
    }
    if (result.extensions.length !== 1) {
      fail(
        `expected exactly one extension, resolved ${result.extensions.length} (${result.extensions
          .map((extension) => extension.resolvedPath)
          .join(", ")})`,
      );
    }
    const [extension] = result.extensions;
    const expected = realpathSync.native(artifactPath);
    if (realpathSync.native(extension.resolvedPath) !== expected) {
      fail(
        `pi resolved ${extension.resolvedPath} instead of the artifact (${expected}); a manifest entry that does not exist falls back to source`,
      );
    }
    const tools = [...extension.tools.keys()];
    const missingTools = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    if (missingTools.length > 0) {
      fail(
        `the artifact does not default-export a working factory: missing tool registrations ${missingTools.join(", ")} (got ${tools.join(", ") || "none"})`,
      );
    }
    if (!extension.commands.has(REQUIRED_COMMAND)) {
      fail(`the artifact did not register the ${REQUIRED_COMMAND} command`);
    }
    return { tools, packedRelative: toPosix(relative(realpathSync.native(packageRoot), expected)) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(SCRIPT_ROOT, options.manifest ?? "package.json");
  const packageRoot = resolve(SCRIPT_ROOT, options.packageRoot ?? dirname(manifestPath));
  const manifest = readManifest(manifestPath);
  assertHostPackagesAreOptionalPeers(manifest);
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1) {
    fail(`pi.extensions must declare exactly one entry, found ${JSON.stringify(entries)}`);
  }
  const entry = toPosix(entries[0]).replace(/^\.\//, "");
  if (manifest.main !== entries[0]) {
    fail(`main (${manifest.main}) must be the same single entry as pi.extensions (${entries[0]})`);
  }
  if (entry.endsWith(".ts")) {
    fail(
      `pi.extensions points at source (${entries[0]}); the artifact is the only entry, with no fallback`,
    );
  }

  const packed = expandFiles(packageRoot, manifest.files);
  if (!packed.has(entry)) {
    fail(
      `the packed file set does not contain the manifest entry ${entry} (files: ${JSON.stringify(manifest.files)})`,
    );
  }

  const artifactPath = resolve(packageRoot, options.artifact ?? entry);
  if (!existsSync(artifactPath) || statSync(artifactPath).size === 0) {
    fail(
      `the artifact ${artifactPath} is missing or empty; pi would resolve zero extensions or fall back to source, silently`,
    );
  }

  if (!options.skipFreshness) {
    const newestInput = maxMtimeMs(FRESHNESS_INPUTS, packageRoot);
    const artifactMtime = statSync(artifactPath).mtimeMs;
    if (newestInput - artifactMtime > FRESHNESS_TOLERANCE_MS) {
      fail(
        `the artifact is stale: built at ${new Date(artifactMtime).toISOString()}, sources changed at ${new Date(newestInput).toISOString()}`,
      );
    }
  }

  const code = readFileSync(artifactPath, "utf8");
  assertSpecifiersResolve(code, manifest);
  const promptRefs = assertPromptAssets(code, artifactPath, packageRoot, packed);

  const artifactIsManifestEntry = resolve(packageRoot, entry) === artifactPath;
  const loaded = await assertLoadsThroughPiLoader(
    artifactIsManifestEntry ? packageRoot : artifactPath,
    artifactPath,
    packageRoot,
  );

  console.log(
    `verify-dist: ${loaded.packedRelative} loads through pi's loader (tools: ${loaded.tools.join(", ")}; command: ${REQUIRED_COMMAND}), specifiers resolve, ${promptRefs.size} prompt assets resolve from it`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ScriptFailure) {
    process.exitCode = 1;
    console.error(`verify-dist: ${error.message}`);
  } else {
    throw error;
  }
}
