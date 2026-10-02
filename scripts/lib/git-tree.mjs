#!/usr/bin/env node
/**
 * Helpers for the install-surface checks: build a git-checkout-shaped tree from the tracked
 * files of this working copy, and drive git on it.
 *
 * WHY: pi installs a git source by cloning it, running `git clean -fdx`, and then running the
 * package manager with devDependencies omitted. A tree built from the tracked files plus the
 * untracked-but-not-ignored ones reproduces the shape `git clean -fdx` leaves behind — no
 * ignored build output, no node_modules — and carries the working-tree content of every file
 * a clone of this branch would contain, so a check can run against the changes being
 * validated rather than against the last commit.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  if (result.error)
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

export function copyTrackedFiles(sourceRoot, destinationDir) {
  const listed = run("git", [
    "-C",
    sourceRoot,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]).stdout;
  const files = listed.split("\0").filter((entry) => entry.length > 0);
  let copied = 0;
  for (const relativePath of files) {
    const source = join(sourceRoot, relativePath);
    if (!existsSync(source)) continue;
    const destination = join(destinationDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied += 1;
  }
  if (copied === 0) throw new Error(`no tracked files copied from ${sourceRoot}`);
  return copied;
}

export function initGitRepo(directory, identity = "pi-better-edit smoke <smoke@example.invalid>") {
  run("git", ["init", "-q"], { cwd: directory });
  run("git", ["config", "user.email", identity.match(/<(.+)>/)?.[1] ?? identity], {
    cwd: directory,
  });
  run("git", ["config", "user.name", identity.replace(/\s*<.*$/, "")], { cwd: directory });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: directory });
}

export function commitAll(directory, message) {
  run("git", ["add", "-A"], { cwd: directory });
  run("git", ["commit", "-q", "-m", message], { cwd: directory });
  return run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim();
}

export function gitClean(directory) {
  run("git", ["clean", "-fdx"], { cwd: directory });
}

export function headRevision(directory) {
  return run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim();
}
