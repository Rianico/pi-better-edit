import { describe, expect, it } from "vitest";
import { parseHashRef } from "../../src/hashline/parse.js";
import { ALPHA, HASH_RE } from "../../src/hashline/alphabet.js";
import {
  DIGIT_ANCHOR_RE,
  HASH_LEN,
  HASH_SPACE,
  HashIdentity,
  MAX_HASH_LINES,
  USABLE_HASH_SPACE,
  contentOnlyHashes,
  fileHashesFor,
  lineHashes,
} from "../../src/hashline/index.js";
import {
  resEdit,
  type LeaseIdentityView,
  type LeaseSpanSource,
} from "../../src/hashline/resolve.js";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve.js";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();
// WHY: independent subcube arithmetic — derived from the public alphabet, not
// WHY: from the mask under test, so the regime pins cannot share its bug.
const BASE = ALPHA.length;
function spellingToIndex(spelling: string): number {
  let idx = 0;
  for (const ch of spelling) idx = idx * BASE + ALPHA.indexOf(ch);
  return idx;
}
function indexToSpelling(idx: number): string {
  let out = "";
  let m = idx;
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPHA[m % BASE] + out;
    m = Math.floor(m / BASE);
  }
  return out;
}
const SUBCUBE_START = spellingToIndex("0".repeat(HASH_LEN));
// WHY: reaches the production probe through the prototype so the assertions
// WHY: pin the shipped code, not a reimplementation.
const productionProbe = new HashIdentity() as unknown as {
  nextZeroBit(bits: Uint32Array, start: number): number;
};
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
    const hashes = contentOnlyHashes(content, blocked);
    expect(hashes).toHaveLength(lines.length);
    let digitCount = 0;
    for (const h of hashes) {
      expect(HASH_RE.test(h)).toBe(true);
      if (DIGIT_ANCHOR_RE.test(h)) digitCount++;
    }
    expect(digitCount).toBe(0);
  });

  it("reaches the reserved band on duplicate-heavy content and serves zero digit anchors", () => {
    // WHY: cursor arithmetic — `baseIdx = (xxh32(c) >>> 14) % HASH_SPACE` confines
    // WHY: content-derived base indices to `[0, 2**18)`, while the digit subcube
    // WHY: starts at `52 × (62^3 + 62^2 + 62 + 1) = 12,596,220 = SUBCUBE_START`;
    // WHY: ~3,907/step) advances into the band, needing ~3,200 consecutive probe
    // WHY: steps. Identical lines collide on one base index, so 20,000 of them
    // WHY: drive the cursor deep into the band — a distinct-line sample stays in
    // WHY: its base-index neighbourhood (≤282,297 at 100k lines) and the shipped
    // WHY: mixed 53k-line sample tops out at 11,705,777, below the band start,
    // WHY: so neither can ever observe the guard.
    const dupContent = Array.from({ length: 20_000 }, () => "dup line 9").join("\n");
    const hashes = contentOnlyHashes(dupContent);
    expect(hashes).toHaveLength(20_000);
    let maxIdx = -1;
    for (const h of hashes) {
      expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
      const idx = spellingToIndex(h);
      if (idx > maxIdx) maxIdx = idx;
    }
    // WHY: in-regime pin — without it a future edit could silently shorten the
    // WHY: sample back below the band and the zero-digit assertion would go vacuous.
    expect(maxIdx).toBeGreaterThanOrEqual(SUBCUBE_START);
  });

  it("probe skips reserved indices from any start", () => {
    // WHY: direct probe shape — a bitset holding exactly the reserved subcube
    // WHY: must never yield a reserved index, and a bitset with one free usable
    // WHY: bit must yield it from a usable start, a reserved start, and the top.
    const words = Math.ceil(HASH_SPACE / 32);
    const reservedOnly = new Uint32Array(words);
    const digitIdx = ALPHA.split("")
      .map((c, i) => (c >= "0" && c <= "9" ? i : -1))
      .filter((i) => i >= 0);
    for (let n = 0; n < digitIdx.length ** HASH_LEN; n++) {
      let idx = 0;
      let mult = 1;
      let m = n;
      for (let j = 0; j < HASH_LEN; j++) {
        idx += digitIdx[m % digitIdx.length]! * mult;
        m = Math.floor(m / digitIdx.length);
        mult *= BASE;
      }
      reservedOnly[idx >>> 5]! |= 1 << (idx & 31);
    }
    const landed = productionProbe.nextZeroBit(reservedOnly, SUBCUBE_START);
    expect(DIGIT_ANCHOR_RE.test(indexToSpelling(landed))).toBe(false);
    const FREE = 100;
    expect(DIGIT_ANCHOR_RE.test(indexToSpelling(FREE))).toBe(false);
    const singleFree = new Uint32Array(words).fill(0xff_ff_ff_ff);
    singleFree[FREE >>> 5]! &= ~(1 << (FREE & 31));
    for (const start of [0, SUBCUBE_START, HASH_SPACE - 1]) {
      expect(productionProbe.nextZeroBit(singleFree, start)).toBe(FREE);
    }
  });

  it("file scope changes anchors: same bytes differ by path and from content-only", () => {
    // WHY: refutable file-scoped claim — the same bytes under two paths, and
    // WHY: under no path, must all differ. A content-only regression (ignoring
    // WHY: the seed) would collapse all three to one set and fail loudly.
    const content = Array.from({ length: 5_000 }, (_, i) => `stable ${i}`).join("\n");
    const byPathA = fileHashesFor("/test/determinism-a.ts", content);
    const byPathB = fileHashesFor("/test/determinism-b.ts", content);
    const contentOnly = contentOnlyHashes(content);
    expect(byPathA).not.toEqual(byPathB);
    expect(byPathA).not.toEqual(contentOnly);
    expect(byPathB).not.toEqual(contentOnly);
    // WHY: and each deterministically — same inputs, same anchors, whatever caller.
    expect(fileHashesFor("/test/determinism-a.ts", content)).toEqual(byPathA);
    expect(new HashIdentity().hashesForSync(content, "/test/determinism-a.ts")).toEqual(byPathA);
    for (const h of byPathA) expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
  });

  it("keeps a pasted digit-shaped spelling on the ordinary shape path", () => {
    // WHY: criterion 3 — no resolve-time refusal of digit shapes was added, so
    // WHY: a 4-digit number stays shape-valid and fails only as an unserved lease.
    expect(parseHashRef("1234")).toEqual({ hash: "1234" });
    expect(parseHashRef("8334")).toEqual({ hash: "8334" });
  });
  it("delta path reserves on duplicate-heavy new content", async () => {
    // WHY: `mapStableHashes` is the second allocation site — the pure-path tests
    // WHY: above cannot observe its guard, so the delta path gets its own
    // WHY: in-regime sample: wholly fresh duplicate-heavy content forces the full
    // WHY: fresh-allocation probe inside the stable mapping.
    const oldContent = "old a\nold b\nold c\n";
    const priorHashes = await lineHashes(oldContent, home.testPath);
    const dupContent = Array.from({ length: 20_000 }, () => "dup line 27").join("\n");
    const fresh = await lineHashes(dupContent, home.testPath, {
      content: oldContent,
      hashes: priorHashes,
    });
    expect(fresh).toHaveLength(20_000);
    let maxIdx = -1;
    for (const h of fresh) {
      expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
      const idx = spellingToIndex(h);
      if (idx > maxIdx) maxIdx = idx;
    }
    expect(maxIdx).toBeGreaterThanOrEqual(SUBCUBE_START);
  });
  it("serves non-digit anchors that still resolve by exact spelling", async () => {
    // WHY: faithful copy — the reservation gates allocation, not resolution, so
    // WHY: a served non-digit anchor keeps resolving exactly through the leased
    // WHY: seam (fast path, served bounds [1,3]).
    const lines = ["alpha", "beta", "gamma"];
    const hashes = await lineHashes(lines.join("\n"), home.testPath);
    expect(hashes).toHaveLength(3);
    const leases: Record<string, LeaseIdentityView> = {};
    hashes.forEach((h, i) => {
      leases[h] = {
        canonHash: "0",
        lineId: i + 1,
        servedSnapshotHash: "S",
        servedLineNumber: i + 1,
        retiredAt: null,
      };
    });
    const source: LeaseSpanSource = {
      currentSnapshotHash: "S",
      leaseFor: (anchor) => leases[anchor],
      rebasedLineOf: (lineId) => lineId,
      anchorHomes: () => [],
    };
    const resolution = resolveLeasedEdit({
      edit: resEdit({ anchor_from: hashes[0]!, anchor_to: hashes[2]!, text: "X" }),
      snapshot: { fileHashes: hashes, fileLines: lines, filePath: "sample.ts" },
      served: hashes,
      source,
    });
    expect(resolution.status).toBe("fast");
    expect(resolution.resolved?.hash_bounds.map((b) => b.line)).toEqual([1, 3]);
  });
});
