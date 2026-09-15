import { describe, expect, it } from "vitest";
import {
  computeLCSPaths,
  pairSnapshots,
  type LineDescriptor,
} from "../../src/hashline/patience-pairing";

function descs(tokens: string[]): LineDescriptor[] {
  return tokens.map((token, index) => ({ lineNumber: index + 1, canonHash: token }));
}

type Pair = [number, number];

/**
 * Brute-force reference for spec §3.4.4: enumerate every **maximal traceback path** — a
 * maximum-size, strictly increasing pairing (embedding) of `prev` into `curr` — and return the
 * distinct ones. Two paths that visit the DP cells in a different order but match the same
 * lines are the *same* embedding and are deduplicated: only a different set of matched lines is
 * a different traceback path for uniqueness purposes.
 */
function maximalPairings(prev: string[], curr: string[]): Pair[][] {
  const rows = prev.length;
  const cols = curr.length;
  const suffix: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0),
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      suffix[i]![j] =
        prev[i] === curr[j]
          ? suffix[i + 1]![j + 1]! + 1
          : Math.max(suffix[i + 1]![j]!, suffix[i]![j + 1]!);
    }
  }

  const length = suffix[0]![0]!;
  const found: Pair[][] = [];
  const walk = (i: number, j: number, chosen: Pair[]): void => {
    if (chosen.length === length) {
      found.push([...chosen]);
      return;
    }
    const target = suffix[i]![j]!;
    if (prev[i] === curr[j] && suffix[i + 1]![j + 1]! + 1 === target) {
      walk(i + 1, j + 1, [...chosen, [i + 1, j + 1]]);
    }
    if (i + 1 <= rows && suffix[i + 1]![j] === target) walk(i + 1, j, chosen);
    if (j + 1 <= cols && suffix[i]![j + 1] === target) walk(i, j + 1, chosen);
  };
  if (length === 0) return [[]];
  walk(0, 0, []);

  const seen = new Set<string>();
  const distinct: Pair[][] = [];
  for (const pairing of found) {
    const key = pairKeys(pairing);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(pairing);
  }
  return distinct;
}

function pairKeys(pairs: readonly Pair[]): string {
  return [...pairs]
    .map(([prevLine, currLine]) => `${prevLine}->${currLine}`)
    .sort()
    .join(",");
}

function sharedPairs(pairings: Pair[][]): Set<string> {
  const [first, ...rest] = pairings;
  const shared = new Set((first ?? []).map(([p, c]) => `${p}->${c}`));
  for (const pairing of rest) {
    const keys = new Set(pairing.map(([p, c]) => `${p}->${c}`));
    for (const key of shared) if (!keys.has(key)) shared.delete(key);
  }
  return shared;
}

function* allSequences(alphabet: string[], maxLength: number): Generator<string[]> {
  for (let length = 0; length <= maxLength; length++) {
    if (length === 0) {
      yield [];
      continue;
    }
    const digits = Array.from({ length }, () => 0);
    for (;;) {
      yield digits.map((digit) => alphabet[digit]!);
      let cursor = length - 1;
      while (cursor >= 0 && digits[cursor] === alphabet.length - 1) {
        digits[cursor] = 0;
        cursor--;
      }
      if (cursor < 0) break;
      digits[cursor]++;
    }
  }
}

/**
 * One oracle case: every emitted pair must sit on *every* maximal traceback path, a single
 * maximal path must be reproduced exactly, and an ambiguous interval must emit nothing.
 */
function expectOracleAgreement(prev: string[], curr: string[]): void {
  const result = computeLCSPaths(descs(prev), descs(curr), 1, prev.length, 1, curr.length);
  const pairings = maximalPairings(prev, curr);
  const shared = sharedPairs(pairings);

  for (const [prevLine, currLine] of result.pairs) {
    expect(prev[prevLine - 1]).toBe(curr[currLine - 1]);
    expect(shared.has(`${prevLine}->${currLine}`)).toBe(true);
  }

  if (pairings.length === 1) {
    expect(result.isUnique).toBe(true);
    expect(pairKeys(result.pairs)).toBe(pairKeys(pairings[0]!));
    return;
  }
  expect(result.isUnique).toBe(false);
  expect(result.pairs).toEqual([]);
}

const SYMBOLS_2 = ["A", "B"];
const SYMBOLS_3 = ["A", "B", "C"];

describe("computeLCSPaths — embedding-level uniqueness", () => {
  it("agrees with the brute-force oracle for every 2-symbol pair up to length 6", () => {
    const sequences = [...allSequences(SYMBOLS_2, 6)];
    for (const prev of sequences) {
      for (const curr of sequences) expectOracleAgreement(prev, curr);
    }
  }, 20_000);

  it("agrees with the brute-force oracle for every 3-symbol pair up to length 5", () => {
    const sequences = [...allSequences(SYMBOLS_3, 5)];
    for (const prev of sequences) {
      for (const curr of sequences) expectOracleAgreement(prev, curr);
    }
  }, 20_000);

  it("retires an interval whose single LCS string has several embeddings", () => {
    const result = computeLCSPaths(descs(["A", "A", "A"]), descs(["A", "A"]), 1, 3, 1, 2);

    expect(maximalPairings(["A", "A", "A"], ["A", "A"]).length).toBe(3);
    expect(result.isUnique).toBe(false);
    expect(result.pairs).toEqual([]);
  });

  it("keeps a pairing that every traceback ordering selects despite several orderings", () => {
    const result = computeLCSPaths(descs(["A", "X", "B"]), descs(["A", "Y", "B"]), 1, 3, 1, 3);

    expect(maximalPairings(["A", "X", "B"], ["A", "Y", "B"])).toEqual([
      [
        [1, 1],
        [3, 3],
      ],
    ]);
    expect(result.isUnique).toBe(true);
    expect(pairKeys(result.pairs)).toBe("1->1,3->3");
  });

  it("keeps duplicated canons when the interval has exactly one maximal pairing", () => {
    const result = computeLCSPaths(descs(["A", "X", "A"]), descs(["A", "Y", "A"]), 1, 3, 1, 3);

    expect(maximalPairings(["A", "X", "A"], ["A", "Y", "A"]).length).toBe(1);
    expect(result.isUnique).toBe(true);
    expect(pairKeys(result.pairs)).toBe("1->1,3->3");
  });
});

describe("computeLCSPaths — [A, B] -> [B, B] regression", () => {
  it("pairs nothing for the equally optimal {2 <-> 1} and {2 <-> 2} embeddings", () => {
    const result = computeLCSPaths(descs(["A", "B"]), descs(["B", "B"]), 1, 2, 1, 2);

    expect(maximalPairings(["A", "B"], ["B", "B"])).toEqual([[[2, 1]], [[2, 2]]]);
    expect(result.isUnique).toBe(false);
    expect(result.pairs).toEqual([]);
  });

  it("leaves line 2 UNPAIRED / RETIRED through pairSnapshots", () => {
    const pairing = pairSnapshots(descs(["A", "B"]), descs(["B", "B"]));

    expect(pairing.size).toBe(0);
    expect(pairing.has(2)).toBe(false);
  });

  it("leaves the counterexample retired when anchored context pins nothing", () => {
    const pairing = pairSnapshots(descs(["H", "A", "B", "T"]), descs(["H", "B", "B", "T"]));

    expect([...pairing.entries()]).toEqual([
      [1, 1],
      [4, 4],
    ]);
  });
});
