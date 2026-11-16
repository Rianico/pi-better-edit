/**
 * The all-digit subcube is reserved, so an allocated anchor can never match
 * `DIGIT_ANCHOR_RE`. Two things keep the assertions here meaningful: the sample must reach
 * the band — content-derived base indices stay below `SUBCUBE_START` (12,596,220), so only
 * duplicate-heavy content drives the probe ~3,200 steps deep into it — and the arithmetic
 * below derives from the public alphabet, never from the mask under test, so a bug in the
 * mask cannot make both sides agree.
 */
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
} from "../../src/hashline/hash-identity.js";
import {
  resEdit,
  type LeaseIdentityView,
  type LeaseSpanSource,
} from "../../src/hashline/resolve.js";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve.js";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();
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
const productionProbe = new HashIdentity() as unknown as {
  nextZeroBit(bits: Uint32Array, start: number): number;
};
describe("all-digit anchor reservation", () => {
  it("derives the usable space from the alphabet with no new literals", () => {
    expect(USABLE_HASH_SPACE).toBe(HASH_SPACE - 10 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(USABLE_HASH_SPACE);
    expect(USABLE_HASH_SPACE).toBe(14_766_336);
  });

  it("never serves an all-digit anchor over a broad sample with probing forced", () => {
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
    const dupContent = Array.from({ length: 20_000 }, () => "dup line 9").join("\n");
    const hashes = contentOnlyHashes(dupContent);
    expect(hashes).toHaveLength(20_000);
    let maxIdx = -1;
    for (const h of hashes) {
      expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
      const idx = spellingToIndex(h);
      if (idx > maxIdx) maxIdx = idx;
    }
    expect(maxIdx).toBeGreaterThanOrEqual(SUBCUBE_START);
  });

  it("probe skips reserved indices from any start", () => {
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
    const content = Array.from({ length: 5_000 }, (_, i) => `stable ${i}`).join("\n");
    const byPathA = fileHashesFor("/test/determinism-a.ts", content);
    const byPathB = fileHashesFor("/test/determinism-b.ts", content);
    const contentOnly = contentOnlyHashes(content);
    expect(byPathA).not.toEqual(byPathB);
    expect(byPathA).not.toEqual(contentOnly);
    expect(byPathB).not.toEqual(contentOnly);
    expect(fileHashesFor("/test/determinism-a.ts", content)).toEqual(byPathA);
    expect(new HashIdentity().hashesForSync(content, "/test/determinism-a.ts")).toEqual(byPathA);
    for (const h of byPathA) expect(DIGIT_ANCHOR_RE.test(h)).toBe(false);
  });

  it("keeps a pasted digit-shaped spelling on the ordinary shape path", () => {
    expect(parseHashRef("1234")).toEqual({ hash: "1234" });
    expect(parseHashRef("8334")).toEqual({ hash: "8334" });
  });
  it("delta path reserves on duplicate-heavy new content", async () => {
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
