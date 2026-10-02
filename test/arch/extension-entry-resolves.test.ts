import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// WHY: pi resolves `pi.extensions` strictly from the package root. For package sources
// (npm, git) a declared path that is missing on disk is dropped silently — the package
// contributes zero extensions and no warning is printed, so the failure looks like
// "tools did not register". See #163.
//
// WHY: ADR-0027 makes the built artifact the only entry on both install surfaces and keeps it
// out of version control, so `git clean -fdx` removes it and `prepare` has to rebuild it.
// The guards below are the ones a manifest alone cannot express: the artifact must be
// gitignored, and neither `prepare` nor `prepack` may swallow a build failure.

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  files?: string[];
  main?: string;
  scripts?: Record<string, string>;
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

const isIgnoredByGit = (path: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("extension entry is installable from every source", () => {
  it("declares a single entry", () => {
    expect(entries).toHaveLength(1);
  });

  it("points main at the same single entry", () => {
    expect(pkg.main).toBe(entries[0]);
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

  it("entry is the built artifact, not the TypeScript source", () => {
    for (const entry of entries) {
      expect(entry.endsWith(".ts"), `${entry} is source; the artifact is the only entry`).toBe(
        false,
      );
    }
  });

  it.skipIf(!hasGitCheckout)(
    "entry is gitignored, so prepare must rebuild it after git clean",
    () => {
      for (const entry of entries) {
        expect(
          isIgnoredByGit(entry),
          `${entry} is tracked — a build artifact in every diff is what ADR-0027 rejects`,
        ).toBe(true);
      }
    },
  );

  it("prepare and prepack cannot swallow a failed build", () => {
    const prepare = pkg.scripts?.prepare ?? "";
    const prepack = pkg.scripts?.prepack ?? "";
    expect(prepare).not.toContain("|| true");
    expect(prepare).not.toContain("husky");
    expect(prepare).toContain("prepare.mjs");
    expect(prepack).toContain("build-dist.mjs");
    expect(prepack).toContain("verify-dist.mjs");
  });
});
