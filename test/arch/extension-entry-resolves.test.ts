import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// WHY: pi resolves `pi.extensions` strictly from the package root. For package sources
// (npm, git) a declared path that is missing on disk is dropped silently — the package
// contributes zero extensions and no warning is printed, so the failure looks like
// "tools did not register". See #163.

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  files?: string[];
  pi?: { extensions?: string[] };
};

const entries = pkg.pi?.extensions ?? [];
const hasGitCheckout = existsSync(".git");

const isCoveredByFiles = (path: string, patterns: string[]): boolean => {
  let covered = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const target = negated ? pattern.slice(1) : pattern;
    if (path === target || path.startsWith(`${target}/`)) covered = !negated;
  }
  return covered;
};

const isTrackedByGit = (path: string): boolean => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("extension entry is installable from every source", () => {
  it("declares a single entry", () => {
    expect(entries).toHaveLength(1);
  });

  it("entry exists relative to the package root", () => {
    for (const entry of entries) {
      expect(existsSync(join(process.cwd(), entry)), `${entry} is missing on disk`).toBe(true);
    }
  });

  it("entry is inside the npm files whitelist", () => {
    for (const entry of entries) {
      const relative = entry.replace(/^\.\//, "");
      expect(
        isCoveredByFiles(relative, pkg.files ?? []),
        `${entry} is excluded from the published tarball`,
      ).toBe(true);
    }
  });

  it.skipIf(!hasGitCheckout)("entry is tracked by git, so a git install can resolve it", () => {
    for (const entry of entries) {
      expect(
        isTrackedByGit(entry),
        `${entry} is not tracked — pi runs \`git clean -fdx\` on update, so untracked entries vanish`,
      ).toBe(true);
    }
  });
});
