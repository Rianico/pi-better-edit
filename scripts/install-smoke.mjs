#!/usr/bin/env node
/**
 * End-to-end install smoke for both install surfaces.
 *
 * WHY (ADR-0027): the artifact has to be the extension entry on the git source and on the
 * packed tarball, and pi drops a manifest entry whose path does not exist without a message.
 * So this drives the real pi CLI, not a model of it:
 *
 *   git surface     pi installs a git URL (served locally by `git daemon`), which clones the
 *                   repo, runs `git clean -fdx` — deleting the gitignored artifact — and runs
 *                   the package manager with devDependencies omitted, so `prepare` must build
 *                   the artifact from scratch.
 *   tarball surface `pnpm pack` produces the tarball; the entry must already be inside it, and
 *                   the extracted package must load with no bundler in its dependency tree.
 *   update          a new commit on the git source, then `pi update`, which resets, cleans and
 *                   re-runs the install; the rebuilt artifact must carry the new code.
 *
 * Each run then drives pi in RPC mode and asserts: no extension-load error, exactly one
 * extension resolved from the package, its registered command present, and the resolved
 * extension path is the artifact.
 *
 * Usage: node scripts/install-smoke.mjs [--keep] [--pi <binary>]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitAll, copyTrackedFiles, headRevision, initGitRepo, run } from "./lib/git-tree.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_COMMAND = "pi-better-edit";

let piBinary = process.env.PI_BIN ?? "pi";

function fail(message) {
  console.error(`install-smoke: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--keep") {
      keep = true;
      continue;
    }
    if (argv[index] === "--pi") {
      piBinary = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`unknown argument: ${argv[index]}`);
  }
  return { keep };
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() =>
        port === undefined ? rejectPort(new Error("no port")) : resolvePort(port),
      );
    });
  });
}

function pi(args, { cwd, home, input, allowFailure = false, offline = true } = {}) {
  const result = spawnSync(piBinary, args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      HUSKY: "0",
      NO_COLOR: "1",
      ...(offline ? { PI_OFFLINE: "1" } : {}),
    },
  });
  if (result.error) fail(`could not run ${piBinary}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(
      `${piBinary} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

/**
 * Drives pi in RPC mode and asserts the extension loaded from the artifact. pi suffixes a
 * command name when two extensions register it, so an unsuffixed `pi-better-edit` proves
 * exactly one extension registered it.
 */
function assertExtensionLoads({ home, cwd, expectedEntry, label }) {
  const result = pi(["--mode", "rpc"], {
    cwd,
    home,
    input: `${JSON.stringify({ id: "smoke", type: "get_commands" })}\n`,
  });
  const stderr = result.stderr ?? "";
  if (stderr.includes("Failed to load extension")) {
    fail(`${label}: pi reported an extension-load error:\n${stderr}`);
  }
  const response = (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((message) => message?.type === "response" && message.command === "get_commands");
  if (response === undefined) {
    fail(
      `${label}: pi returned no get_commands response in RPC mode\n${result.stdout ?? ""}${stderr}`,
    );
  }
  const commands = response.data.commands.filter((command) => command.name === EXTENSION_COMMAND);
  if (commands.length !== 1) {
    fail(
      `${label}: expected exactly one ${EXTENSION_COMMAND} command, found ${commands.length} (${commands.map((command) => command.name).join(", ")})`,
    );
  }
  const [command] = commands;
  if (command.source !== "extension" || command.sourceInfo?.origin !== "package") {
    fail(
      `${label}: ${EXTENSION_COMMAND} is not a package extension: ${JSON.stringify(command.sourceInfo)}`,
    );
  }
  if (!String(command.sourceInfo.path).endsWith(expectedEntry)) {
    fail(
      `${label}: pi resolved ${command.sourceInfo.path}, expected it to end with ${expectedEntry}`,
    );
  }
  const packageExtensions = response.data.commands.filter(
    (entry) => entry.sourceInfo?.origin === "package",
  );
  if (packageExtensions.length !== 1) {
    fail(
      `${label}: expected exactly one resolved package extension, found ${packageExtensions.length}`,
    );
  }
  console.log(
    `install-smoke: ${label}: pi loaded ${command.sourceInfo.path} as the single package extension`,
  );
}

async function startGitDaemon(scratch) {
  const port = await freePort();
  const pidFile = join(scratch, "gitd.pid");
  run("git", [
    "daemon",
    "--export-all",
    "--reuseaddr",
    `--base-path=${scratch}`,
    `--port=${port}`,
    "--detach",
    `--pid-file=${pidFile}`,
  ]);
  const url = `git://localhost:${port}/source/pi-better-edit`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = run("git", ["ls-remote", url, "HEAD"], { allowFailure: true });
    if (probe.status === 0) return { url, pidFile };
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(`git daemon did not serve ${url}`);
}

function packTarball(scratch) {
  const destination = join(scratch, "tarball");
  mkdirSync(destination, { recursive: true });
  const result = run("pnpm", ["pack", "--pack-destination", destination], {
    cwd: ROOT,
    allowFailure: true,
  });
  if (result.status !== 0) {
    fail(`pnpm pack failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  const tarball = readdirSync(destination)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(destination, name))
    .at(0);
  if (tarball === undefined) fail("pnpm pack produced no tarball");
  const listing = run("tar", ["-tzf", tarball])
    .stdout.split("\n")
    .filter((line) => line.length > 0);
  return { tarball, listing };
}

async function main() {
  const { keep } = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync(join(tmpdir(), "pi-better-edit-smoke-"));
  const source = join(scratch, "source", "pi-better-edit");
  const project = join(scratch, "project");
  const gitHome = join(scratch, "home-git");
  const tarballHome = join(scratch, "home-tarball");
  let daemon;
  let exitCode = 0;
  try {
    mkdirSync(project, { recursive: true });
    copyTrackedFiles(ROOT, source);
    initGitRepo(source);
    commitAll(source, "smoke source");
    daemon = await startGitDaemon(scratch);

    const sourceSpec = `git:${daemon.url}`;
    const installed = join(gitHome, ".pi", "agent", "git", "localhost", "source", "pi-better-edit");
    const installedArtifact = join(installed, "dist", "index.js");

    pi(["install", sourceSpec], { cwd: project, home: gitHome });
    if (!existsSync(installedArtifact)) {
      fail(
        `the git install left no artifact at ${installedArtifact}; pi would resolve zero extensions silently`,
      );
    }
    if (existsSync(join(installed, "node_modules", "esbuild"))) {
      fail("the git install put a bundler in the installed tree");
    }
    console.log(
      `install-smoke: git surface installed ${sourceSpec} and built dist/index.js with devDependencies omitted`,
    );
    assertExtensionLoads({
      home: gitHome,
      cwd: project,
      expectedEntry: "dist/index.js",
      label: "git surface",
    });

    const { tarball, listing } = packTarball(scratch);
    for (const required of [
      "package/dist/index.js",
      "package/prompts/read.md",
      "package/package.json",
    ]) {
      if (!listing.includes(required)) {
        fail(
          `the packed tarball does not contain ${required}; the manifest entry would resolve to nothing`,
        );
      }
    }
    const consumer = join(scratch, "consumer", "node_modules", "pi-better-edit");
    mkdirSync(consumer, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", consumer, "--strip-components=1"]);
    if (!existsSync(join(consumer, "dist", "index.js"))) {
      fail("the extracted tarball has no dist/index.js before any install script runs");
    }
    const install = run(
      "npm",
      [
        "install",
        "--omit=dev",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: consumer,
        allowFailure: true,
      },
    );
    if (install.status !== 0)
      fail(
        `npm install in the extracted package failed\n${install.stdout ?? ""}${install.stderr ?? ""}`,
      );
    if (
      existsSync(join(consumer, "node_modules", "esbuild")) ||
      existsSync(join(consumer, "node_modules", ".bin", "esbuild"))
    ) {
      fail("installing from the tarball added a bundler to the dependency tree");
    }
    console.log(
      `install-smoke: tarball surface: ${listing.length} packed files, entry and prompt assets present, no bundler installed`,
    );
    pi(["install", consumer], { cwd: project, home: tarballHome });
    assertExtensionLoads({
      home: tarballHome,
      cwd: project,
      expectedEntry: "dist/index.js",
      label: "tarball surface",
    });

    const marker = `smoke-marker-${Date.now().toString(36)}`;
    // WHY: the marker goes on the entry, not on a bundled module — esbuild drops an unused
    // export of a bundled module, and the rebuild has to be observable in the artifact.
    const sourceEntry = join(source, "index.ts");
    writeFileSync(
      sourceEntry,
      `${readFileSync(sourceEntry, "utf8")}\nexport const SMOKE_MARKER = "${marker}";\n`,
      "utf8",
    );
    commitAll(source, "smoke marker commit");
    const updatedRevision = headRevision(source);
    pi(["update", sourceSpec], { cwd: project, home: gitHome, offline: false });
    if (headRevision(installed) !== updatedRevision) {
      fail(`pi update did not move the git install to ${updatedRevision}`);
    }
    const rebuilt = readFileSync(installedArtifact, "utf8");
    if (!rebuilt.includes(marker)) {
      fail("pi update did not rebuild the artifact from the new commit");
    }
    console.log(
      `install-smoke: update surface: pi update rebuilt dist/index.js from ${updatedRevision.slice(0, 12)}`,
    );
    assertExtensionLoads({
      home: gitHome,
      cwd: project,
      expectedEntry: "dist/index.js",
      label: "after update",
    });

    console.log(
      "install-smoke: all install surfaces resolve exactly one extension from the artifact",
    );
  } catch (error) {
    exitCode = 1;
    console.error(`install-smoke: ${error.message}`);
  } finally {
    if (daemon !== undefined && existsSync(daemon.pidFile)) {
      const pid = Number.parseInt(readFileSync(daemon.pidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          console.log("install-smoke: git daemon already stopped");
        }
      }
    }
    if (keep) console.log(`install-smoke: kept ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

await main();
