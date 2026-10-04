import { describe, expect, it } from "vitest";
import { parseHashRef } from "../../src/hashline/parse.js";
import { HASH_RE } from "../../src/hashline/alphabet.js";
import {
  DIGIT_ANCHOR_RE,
  HASH_LEN,
  HASH_SPACE,
  HashIdentity,
  MAX_HASH_LINES,
  USABLE_HASH_SPACE,
  _lineHashesPure,
  lineHashes,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("all-digit anchor reservation", () => {
  it("derives the usable space from the alphabet with no new literals", () => {
    // WHY: the reservation is `(#digit chars) ** HASH_LEN` — a restated 10_000
    // WHY: here would let the cap drift from the alphabet the leases enforce.
    expect(USABLE_HASH_SPACE).toBe(HASH_SPACE - 10 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(USABLE_HASH_SPACE);
    expect(USABLE_HASH_SPACE).toBe(14_766_336);
  });

  it("never serves an all-digit anchor over a broad sample with probing forced", () => {
    // WHY: criterion 1 — no allocated anchor may match `DIGIT_ANCHOR_RE`. The
    // WHY: sample mixes distinct, duplicate, and moved lines plus a blocked set
    // WHY: that forces the probe off content-derived base indices.
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(`sample line ${i}`);
    for (let i = 0; i < 2_000; i++) lines.push(`duplicate ${i % 50}`);
    for (let i = 0; i < 1_000; i++) lines.push(`sample line ${i}`);
    const content = lines.join("\n");
    const blocked = new Set<string>();
    for (let i = 0; i < 500; i++) blocked.add(`B${i}`);
    const hashes = _lineHashesPure(content, blocked);
    expect(hashes).toHaveLength(lines.length);
    let digitCount = 0;
    for (const h of hashes) {
      expect(HASH_RE.test(h)).toBe(true);
      if (DIGIT_ANCHOR_RE.test(h)) digitCount++;
    }
    expect(digitCount).toBe(0);
  });

  it("keeps identical content on identical anchors across runs and identities", () => {
    // WHY: the reservation is a fixed mask, so allocation stays a pure function
    // WHY: of content — same bytes, same anchors, whatever the caller.
    const content = Array.from({ length: 5_000 }, (_, i) => `stable ${i}`).join("\n");
    const first = _lineHashesPure(content);
    const second = _lineHashesPure(content);
    expect(second).toEqual(first);
    const fresh = new HashIdentity().hashesForSync(content);
    expect(fresh).toEqual(first);
    for (const h of first) expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
  });

  it("keeps a pasted digit-shaped spelling on the ordinary shape path", () => {
    // WHY: criterion 3 — no resolve-time refusal of digit shapes was added, so
    // WHY: a 4-digit number stays shape-valid and fails only as an unserved lease.
    expect(parseHashRef("1234")).toEqual({ hash: "1234" });
    expect(parseHashRef("8334")).toEqual({ hash: "8334" });
  });
  it("serves non-digit anchors that still resolve by exact spelling", async () => {
    // WHY: faithful copy — the reservation gates allocation, not resolution, so
    // WHY: a served non-digit anchor keeps resolving exactly.
    const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(3);
    for (const h of hashes) expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
  });
});
