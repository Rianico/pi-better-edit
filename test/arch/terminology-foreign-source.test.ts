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

  it("planted-term self-test: the scan mechanism sees a planted occurrence and stays quiet otherwise (remediation-2 B7)", () => {
    // WHY: a text guard that cannot be seen failing proves nothing. The planted spelling is
    // WHY: built dynamically so this file stays clean, and the quiet arm pins that the canonical
    // WHY: vocabulary does not trip the needle.
    const planted = ["cross", "file"].join("-");
    expect(needle.test(`refuses the ${planted} copy`)).toBe(true);
    expect(needle.test("foreign-source reference supports mode")).toBe(false);
  });

  it("keeps the single carve-out needed: the anchor-term baseline still quotes the avoided term", () => {
    // WHY: shrink-only honesty — the moment the baseline no longer quotes the retired synonym,
    // the carve-out must be removed and the file joins the zero-tolerance set.
    expect(readFileSync("test/arch/terminology-synonyms.test.ts", "utf-8")).toContain(
      ["cross", "file"].join("-"),
    );
  });
});

// TEXT GUARD (remediation-2 B7), labelled as such: these are content scans, not behavioral
// witnesses — the behavior they back is tested through the entry point by
// `edit.wire-contract.test.ts` (engine-seam foreign-cut refusal) and
// `edit.foreign-attribution.test.ts` (leased wrap headlines). The guard only pins that the
// canonical `foreign-source` wording survives a rewording at the renderer source. The scan
// site moved with the wording: remediation-2 B3 collapsed the admission-side duplicate into the
// engine pre-pass, so BOTH refusal phrasings now live in pipeline.ts alone.
const containsPhrase = (content: string, phrase: string): boolean => content.includes(phrase);

describe("foreign-source discipline in the refusal renderers (ticket-04 rework §11 #25)", () => {
  it("the engine refusal for a foreign cut names the canonical foreign-source phrasing", () => {
    // PIN (green on the fixed tree; falsified by rewording the clause away from `foreign-source`,
    // seen failing in the arm below).
    const pipeline = readFileSync("src/mutation-engine/pipeline.ts", "utf-8");
    expect(containsPhrase(pipeline, "A foreign-source reference supports mode:")).toBe(true);
    expect(
      containsPhrase(
        "a reworded sample that drops the term",
        "A foreign-source reference supports mode:",
      ),
      "the scan must be able to fail",
    ).toBe(false);
  });

  it("the engine's foreign rejection headlines name the foreign-source reference", () => {
    // PIN (§0 keeps the pass-through wording; the remediation-2 leased wrap adds the same shape).
    const pipeline = readFileSync("src/mutation-engine/pipeline.ts", "utf-8");
    expect(containsPhrase(pipeline, "the foreign-source reference to")).toBe(true);
    expect(
      containsPhrase("a reworded sample that drops the term", "the foreign-source reference to"),
      "the scan must be able to fail",
    ).toBe(false);
  });
});
