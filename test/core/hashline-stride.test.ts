import { describe, expect, it } from "vitest";
import {
  HASH_PROBE_STRIDE,
  HASH_SPACE,
  USABLE_HASH_SPACE,
  _lineHashesPure,
  lineHashes,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

// WHY: the stride `3907 = 62^2 + 62 + 1` increments only the low three base-62
// WHY: digits, so consecutive 4-char anchors always differ in positions 1–3
// WHY: while the most-significant char may coincide — the helper below pins
// WHY: exactly that, not the width-3 "every character differs" claim.
function lowThreeCharsDiffer(a: string, b: string): boolean {
  return a[1] !== b[1] && a[2] !== b[2] && a[3] !== b[3];
}

describe("hash probe stride", () => {
  it("is coprime with the hash space so probing visits every index", () => {
    expect(gcd(HASH_PROBE_STRIDE, HASH_SPACE)).toBe(1);
    // WHY: the probe cycles the raw bitset where reserved indices are just set
    // WHY: bits — coprimality with the usable space too is what keeps that
    // WHY: cycling (and exhaustion detection) exact after the reservation.
    expect(gcd(HASH_PROBE_STRIDE, USABLE_HASH_SPACE)).toBe(1);
  });

  it("changes the low three base-62 digits between consecutive allocations", () => {
    const digit0 = HASH_PROBE_STRIDE % 62;
    const digit1 = Math.floor(HASH_PROBE_STRIDE / 62) % 62;
    const digit2 = Math.floor(HASH_PROBE_STRIDE / 62 ** 2) % 62;
    expect(digit0).not.toBe(0);
    expect(digit1).not.toBe(0);
    expect(digit1).not.toBe(61);
    expect(digit2).not.toBe(0);
    expect(digit2).not.toBe(61);
  });

  it("spreads blank lines so consecutive hashes differ in the low three positions", () => {
    const content = Array.from({ length: 20 }, () => "").join("\n");
    const hashes = _lineHashesPure(content);
    for (let i = 1; i < hashes.length; i++) {
      expect(lowThreeCharsDiffer(hashes[i - 1]!, hashes[i]!)).toBe(true);
    }
  });

  it("spreads repeated closing braces the same way", () => {
    const content = Array.from({ length: 20 }, () => "}").join("\n");
    const hashes = _lineHashesPure(content);
    for (let i = 1; i < hashes.length; i++) {
      expect(lowThreeCharsDiffer(hashes[i - 1]!, hashes[i]!)).toBe(true);
    }
  });

  it("spreads blank lines through the store path", async () => {
    const content = Array.from({ length: 20 }, () => "").join("\n");
    const hashes = await lineHashes(content, home.testPath);
    for (let i = 1; i < hashes.length; i++) {
      expect(lowThreeCharsDiffer(hashes[i - 1]!, hashes[i]!)).toBe(true);
    }
  });

  it("keeps blank-line hashes distinct from neighboring content lines", async () => {
    const content = ["const a = 1;", "", "const b = 2;", "", "const c = 3;"].join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("continues the stride sequence for appended identical lines via stable mapping", async () => {
    const oldContent = Array.from({ length: 10 }, () => "").join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = Array.from({ length: 11 }, () => "").join("\n");
    const newHashes = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });
    for (let i = 1; i < newHashes.length; i++) {
      expect(lowThreeCharsDiffer(newHashes[i - 1]!, newHashes[i]!)).toBe(true);
    }
  });
});
