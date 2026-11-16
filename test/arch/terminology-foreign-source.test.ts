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
 * the one terminology record that must name the term to ban it (`GLOSSARY.md` Avoid line, quoted
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
    const planted = ["cross", "file"].join("-");
    expect(needle.test(`refuses the ${planted} copy`)).toBe(true);
    expect(needle.test("foreign-source reference supports mode")).toBe(false);
  });

  it("keeps the single carve-out needed: the anchor-term baseline still quotes the avoided term", () => {
    expect(readFileSync("test/arch/terminology-synonyms.test.ts", "utf-8")).toContain(
      ["cross", "file"].join("-"),
    );
  });
});

/**
 * TEXT GUARD (remediation-2 B7), labelled as such: content scans, not behavioral witnesses. The
 * behavior they back is tested through the entry point by `edit.wire-contract.test.ts` and
 * `edit.foreign-attribution.test.ts`; this guard only pins that the canonical `foreign-source`
 * wording survives a rewording at the renderer source, and remediation-2 B3 collapsed the
 * admission-side duplicate into the engine pre-pass, so both refusal phrasings live in pipeline.ts.
 *
 * Falsifiability (04b §12.3): each arm mutates a FIXTURE OF THE SCANNED FILE — the real content with
 * the phrase surgically removed — never a hardcoded string, so the scan reads the same bytes the
 * pass arm reads. An oracle that cannot fail is not an oracle.
 */
const containsPhrase = (content: string, phrase: string): boolean => content.includes(phrase);

function rewordedFixture(pipeline: string, phrase: string): string {
  expect(pipeline, "the pass arm must have found the phrase to mutate").toContain(phrase);
  const mutated = pipeline.replaceAll(phrase, "[reworded away]");
  expect(mutated).not.toBe(pipeline);
  return mutated;
}

describe("foreign-source discipline in the refusal renderers (ticket-04 rework §11 #25)", () => {
  it("the deleted foreign-cut refusal stays deleted: cut is a transaction member, not a refused mode (04b)", () => {
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
    const pipeline = readFileSync("src/mutation-engine/pipeline.ts", "utf-8");
    const phrase = "the foreign-source reference to";
    expect(containsPhrase(pipeline, phrase)).toBe(true);
    expect(
      containsPhrase(rewordedFixture(pipeline, phrase), phrase),
      "the scan must be able to fail — the mutated fixture must not contain the phrase",
    ).toBe(false);
  });
});
