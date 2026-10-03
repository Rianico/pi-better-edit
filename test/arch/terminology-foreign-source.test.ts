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
// `edit.wire-contract.test.ts` (engine-seam foreign cut, both halves: the deleted refusal and the
// transactional success) and
// `edit.foreign-attribution.test.ts` (leased wrap headlines). The guard only pins that the
// canonical `foreign-source` wording survives a rewording at the renderer source. The scan
// site moved with the wording: remediation-2 B3 collapsed the admission-side duplicate into the
// engine pre-pass, so BOTH refusal phrasings now live in pipeline.ts alone.
// (04b §12.3) the falsifiability arms operate on a FIXTURE OF THE SCANNED FILE — the real
// content with the phrase surgically removed — not a hardcoded constant string, so the arm
// exercises the same scanner over the same bytes the pass arm reads. An oracle that cannot
// fail is not an oracle.
const containsPhrase = (content: string, phrase: string): boolean => content.includes(phrase);

function rewordedFixture(pipeline: string, phrase: string): string {
  expect(pipeline, "the pass arm must have found the phrase to mutate").toContain(phrase);
  const mutated = pipeline.replaceAll(phrase, "[reworded away]");
  expect(mutated).not.toBe(pipeline);
  return mutated;
}

describe("foreign-source discipline in the refusal renderers (ticket-04 rework §11 #25)", () => {
  it("the deleted foreign-cut refusal stays deleted: cut is a transaction member, not a refused mode (04b)", () => {
    // (04b §12.3) This arm pinned the item-(iv) refusal's canonical wording
    // ("A foreign-source reference supports mode:"). The refusal was deleted as an intentional
    // act, in the same commit as the correlated multi-file transaction that enables foreign
    // `mode: "cut"` — `edit.foreign-cut.test.ts` and `edit.wire-contract.test.ts` witness both
    // halves. What must not regress is the DELETION: a future re-introduction of a copy-only
    // refusal would silently re-negate ticket-04b, so the absence arm is the guard now, and the
    // fixture arm keeps this scan falsifiable by mutating the surviving transaction wording.
    const pipeline = readFileSync("src/mutation-engine/pipeline.ts", "utf-8");
    const deletedRefusal = "supports mode:";
    expect(
      containsPhrase(pipeline, deletedRefusal),
      "the item-(iv) copy-only refusal must stay deleted (ADR-0028): foreign cut commits",
    ).toBe(false);
    const phrase = "foreign-source cut as one correlated multi-file transaction";
    expect(containsPhrase(pipeline, phrase)).toBe(true);
    expect(
      containsPhrase(rewordedFixture(pipeline, phrase), phrase),
      "the scan must be able to fail — the mutated fixture must not contain the phrase",
    ).toBe(false);
  });

  it("the engine's foreign rejection headlines name the foreign-source reference", () => {
    // PIN (§0 keeps the pass-through wording; the remediation-2 leased wrap adds the same shape).
    const pipeline = readFileSync("src/mutation-engine/pipeline.ts", "utf-8");
    const phrase = "the foreign-source reference to";
    expect(containsPhrase(pipeline, phrase)).toBe(true);
    expect(
      containsPhrase(rewordedFixture(pipeline, phrase), phrase),
      "the scan must be able to fail — the mutated fixture must not contain the phrase",
    ).toBe(false);
  });
});
