import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * (ticket-04 rework, §11 #25) The hyphenated "old-file vs this-file" coinage is a RETIRED wire
 * term: the canonical vocabulary is `foreign-source` (a `text_ref` naming another served file)
 * versus the same-file reference.
 * The ban belongs repo-wide — `src/`, `prompts/`, and `test/` whole files — because the term
 * leaked back through comments and refusal wording once the ticket renamed it.
 *
 * The needle is BUILT DYNAMICALLY so this guard file never itself contains the retired string;
 * the one terminology record that must name the term to ban it (`CONTEXT.md` Avoid line, quoted
 * by the anchor-term baseline in `test/arch/terminology-synonyms.test.ts`) is carved out per
 * file and its need is re-asserted, shrink-only.
 */
const needle = new RegExp(["cross", "file"].join("[-_]?"), "i");

function allFiles(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) allFiles(path, exts, out);
    else if (entry.isFile() && exts.some((ext) => path.endsWith(ext))) out.push(path);
  }
  return out;
}

// WHY: the anchor-term baseline must quote the avoided synonym to define the ban
// (CONTEXT.md:32 is its source of truth); it is exempt, and its continued need is asserted
// below so the carve-out cannot outlive its purpose. Nothing else is exempt: `src/` and
// `prompts/` keep zero tolerance, `test/` keeps zero tolerance outside this one record file.
const CARVE_OUT = new Set(["test/arch/terminology-synonyms.test.ts"]);

function checkedFiles(): string[] {
  return [
    ...allFiles("src", [".ts"]),
    ...allFiles("prompts", [".md"]),
    ...allFiles("test", [".ts"]),
  ].filter((file) => !CARVE_OUT.has(file));
}

function filesNamingRetiredTerm(): string[] {
  return checkedFiles().filter((file) => needle.test(readFileSync(file, "utf-8")));
}

describe("retired term stays out of the repo (ticket-04 rework §11 #25)", () => {
  it("the retired hyphenated term names no surface in src/, prompts/ or test/ (carve-out excluded)", () => {
    expect(filesNamingRetiredTerm()).toEqual([]);
  });

  it("keeps the single carve-out needed: the anchor-term baseline still quotes the avoided term", () => {
    // WHY: shrink-only honesty — the moment the baseline no longer quotes the retired synonym,
    // the carve-out must be removed and the file joins the zero-tolerance set.
    expect(readFileSync("test/arch/terminology-synonyms.test.ts", "utf-8")).toContain(
      ["cross", "file"].join("-"),
    );
  });
});

describe("foreign-source discipline in the refusal renderers (ticket-04 rework §11 #25)", () => {
  it("the admission refusal for a foreign cut names the canonical foreign-source phrasing", () => {
    // PIN (green at HEAD — falsification owed by mutation phase: rewording the clause away
    // from `foreign-source` fails here).
    expect(readFileSync("src/payload-contract.ts", "utf-8")).toContain(
      "A foreign-source reference supports mode:",
    );
  });

  it("the engine's foreign rejection pass-through names the foreign-source reference", () => {
    // PIN (green at HEAD — §0 says the pass-through MUST NOT CHANGE, and this pins the
    // canonical wording of the fallback headline it wraps).
    expect(readFileSync("src/mutation-engine/pipeline.ts", "utf-8")).toContain(
      "the foreign-source reference to",
    );
  });
});
