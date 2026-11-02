import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The spec records the index tables link to: bare `name.md` targets in
 * `docs/spec/README.md`. Links that leave the directory (`../.archive_adrs/…`)
 * name ADRs, not spec records, so only slash-free targets count.
 */
function linkedSpecFiles(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)\)/g)) {
    const target = match[1];
    if (target !== undefined && !target.includes("/")) out.push(target);
  }
  return out;
}

/** The index-table rows of the README: the tables are the index, so prose links stay out. */
function indexTableText(readme: string): string {
  return readme
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .join("\n");
}

/** Names linked more than once, in first-duplicate order. */
function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      if (!dupes.includes(name)) dupes.push(name);
    } else {
      seen.add(name);
    }
  }
  return dupes;
}

function specDirFiles(): string[] {
  return readdirSync(join("docs", "spec"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name);
}

describe("spec index", () => {
  it("links every spec record exactly once", () => {
    // WHY: the index is the only discoverable map of the specification set, so
    // WHY: a duplicated or missing entry silently misdirects a reader.
    const readme = readFileSync(join("docs", "spec", "README.md"), "utf-8");
    expect(duplicates(linkedSpecFiles(indexTableText(readme)))).toEqual([]);
  });

  it("registers every spec file on disk", () => {
    // WHY: a new spec record that is never registered is the sibling defect of
    // WHY: a duplicated row — present but unreachable through the index.
    const readme = readFileSync(join("docs", "spec", "README.md"), "utf-8");
    const linked = new Set(linkedSpecFiles(readme));
    for (const name of specDirFiles()) {
      expect(linked.has(name), name).toBe(true);
    }
  });

  it("reports a duplicated link through the same helper", () => {
    const fixture = "| **[`a.md`](a.md)** | x | **[`a.md`](a.md)** |";
    expect(duplicates(linkedSpecFiles(fixture))).toEqual(["a.md"]);
  });
});
