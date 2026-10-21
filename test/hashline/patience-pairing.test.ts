import { describe, expect, it } from "vitest";
import {
  assertMonotonicPairing,
  findStablePinBackbone,
  findUniquePins,
  pairSnapshots,
  pairingScanBudget,
  type AnchorPin,
  type LineDescriptor,
} from "../../src/hashline/patience-pairing";

function descs(tokens: string[]): LineDescriptor[] {
  return tokens.map((token, index) => ({ lineNumber: index + 1, canonHash: token }));
}

/** Seed-pinned PRNG: the spec-corpus checks below must be deterministic, not flaky. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], rng: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function pinKey(pin: AnchorPin): string {
  return `${pin.prevLine}:${pin.currLine}`;
}

/**
 * Reference oracle for spec §3.4.3: enumerate every strictly increasing `currLine`
 * subsequence, keep the maximum-length minimum-Δ ones, and intersect them. Exponential
 * by construction, so it is only used on tiny corpora to pin the polynomial DP.
 */
function referenceStablePinBackbone(pins: AnchorPin[]): string[] {
  const subsequences: number[][] = [];
  const collect = (start: number, chosen: number[]): void => {
    subsequences.push([...chosen]);
    for (let i = start; i < pins.length; i++) {
      const last = chosen[chosen.length - 1];
      if (last !== undefined && pins[i]!.currLine <= pins[last]!.currLine) continue;
      chosen.push(i);
      collect(i + 1, chosen);
      chosen.pop();
    }
  };
  collect(0, []);

  const displacement = (chosen: number[]): number =>
    chosen.reduce((sum, i) => sum + Math.abs(pins[i]!.prevLine - pins[i]!.currLine), 0);
  const longest = Math.max(...subsequences.map((chosen) => chosen.length));
  const maximal = subsequences.filter((chosen) => chosen.length === longest);
  const minimal = Math.min(...maximal.map(displacement));
  const optimal = maximal.filter((chosen) => displacement(chosen) === minimal);
  const shared = optimal[0]!.filter((i) => optimal.every((chosen) => chosen.includes(i)));
  return shared.map((i) => pinKey(pins[i]!)).sort();
}

function asPairs(pairing: Map<number, number>): [number, number][] {
  return [...pairing.entries()].sort((a, b) => a[0] - b[0]);
}

describe("pairSnapshots — contested reorders", () => {
  it("pairs only the unanimous backbone when H and T pin a swapped A/B gap", () => {
    const prev = descs(["H", "A", "B", "T"]);
    const curr = descs(["H", "B", "A", "T"]);

    const pairing = pairSnapshots(prev, curr);

    expect(asPairs(pairing)).toEqual([
      [1, 1],
      [4, 4],
    ]);
    expect(pairing.has(2)).toBe(false);
    expect(pairing.has(3)).toBe(false);
  });

  it("leaves a bare symmetric swap unpaired, retiring both lines fail-closed", () => {
    const pairing = pairSnapshots(descs(["A", "B"]), descs(["B", "A"]));

    expect(pairing.size).toBe(0);
  });

  it("rebases the longer α3/β7 block and retires the displaced minority", () => {
    const prev = descs(["α1", "α2", "α3", "β1", "β2", "β3", "β4", "β5", "β6", "β7"]);
    const curr = descs(["β1", "β2", "β3", "β4", "β5", "β6", "β7", "α1", "α2", "α3"]);

    const pairing = pairSnapshots(prev, curr);

    expect(asPairs(pairing)).toEqual([
      [4, 1],
      [5, 2],
      [6, 3],
      [7, 4],
      [8, 5],
      [9, 6],
      [10, 7],
    ]);
    for (const alphaLine of [1, 2, 3]) expect(pairing.has(alphaLine)).toBe(false);
  });

  it("keeps every untouched middle when endpoints swap around an M1..M100 run", () => {
    const middles = Array.from({ length: 100 }, (_, i) => `M${i + 1}`);
    const prev = descs(["A", ...middles, "B"]);
    const curr = descs(["B", ...middles, "A"]);

    const pairing = pairSnapshots(prev, curr);

    const expected: [number, number][] = middles.map((_, i) => [i + 2, i + 2]);
    expect(asPairs(pairing)).toEqual(expected);
    expect(pairing.has(1)).toBe(false);
    expect(pairing.has(102)).toBe(false);
  });

  it("retires both blocks when equal-length swaps tie on length and displacement", () => {
    const prev = descs(["α1", "α2", "α3", "β1", "β2", "β3"]);
    const curr = descs(["β1", "β2", "β3", "α1", "α2", "α3"]);

    expect(pairSnapshots(prev, curr).size).toBe(0);
  });

  it("prefers the minimal-displacement LIS when maximal paths tie in length", () => {
    const prev = descs(["a", "b", "c", "d"]);
    const curr = descs(["a", "b", "d", "e", "c"]);

    const pairing = pairSnapshots(prev, curr);

    expect(asPairs(pairing)).toEqual([
      [1, 1],
      [2, 2],
      [4, 3],
    ]);
    expect(pairing.has(3)).toBe(false);
  });
});

describe("pairSnapshots — rigid block shift (Probe N)", () => {
  it("zips an identical 3,000-line duplicate run shifted by an exterior insert", () => {
    const run = Array.from({ length: 3000 }, () => "}");
    const prev = descs(["H", ...run, "F"]);
    const curr = descs(["n1", "n2", "n3", "n4", "n5", "H", ...run, "F"]);

    const pairing = pairSnapshots(prev, curr);

    expect(pairing.size).toBe(3002);
    expect(pairing.get(1)).toBe(6);
    expect(pairing.get(1500)).toBe(1505);
    expect(pairing.get(3001)).toBe(3006);
    expect(pairing.get(3002)).toBe(3007);
  });

  it("leaves an over-budget duplicate interval unpaired instead of guessing", () => {
    const prev = descs(Array.from({ length: 2001 }, () => "x"));
    const curr = descs([...Array.from({ length: 2000 }, () => "x"), "y"]);

    const pairing = pairSnapshots(prev, curr);

    expect(pairing.size).toBe(0);
  });
});

describe("pairSnapshots — leaf alignment", () => {
  it("pairs a unique LCS traceback without anchor pins", () => {
    const pairing = pairSnapshots(descs(["A", "B", "A"]), descs(["A", "A"]));

    expect(asPairs(pairing)).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it("retires every line when duplicate tracebacks make the LCS ambiguous", () => {
    const pairing = pairSnapshots(descs(["A", "A"]), descs(["A", "A", "A"]));

    expect(pairing.size).toBe(0);
  });
});

describe("pairSnapshots — budget guard", () => {
  it("scales the scan budget as MAX(100000, 4*(prev+curr))", () => {
    expect(pairingScanBudget(1, 1)).toBe(100000);
    expect(pairingScanBudget(30000, 30000)).toBe(240000);
    expect(pairingScanBudget(30000, 30005)).toBe(240020);
  });

  it("halts alignment when the scan budget cannot cover the interval", () => {
    const prev = descs(["H", "A", "B", "T"]);
    const curr = descs(["H", "B", "A", "T"]);

    const pairing = pairSnapshots(prev, curr, { scanBudget: 1 });

    expect(pairing.size).toBe(0);
    expect(asPairs(pairSnapshots(prev, curr))).toEqual([
      [1, 1],
      [4, 4],
    ]);
  });

  it("leaves later sub-intervals unpaired once the budget is spent mid-recursion", () => {
    const run = Array.from({ length: 40 }, () => "d");
    const prev = descs(["H", ...run, "T"]);
    const curr = descs(["H", ...run, "T"]);

    // WHY: the top-level interval costs 84, leaving 16 < 80 for the duplicate middle run,
    // WHY: so the two unanimous pins still pair while the over-budget rigid run is retired
    // WHY: instead of being zipped; the default scaled budget aligns all 42 lines.
    expect(asPairs(pairSnapshots(prev, curr, { scanBudget: 100 }))).toEqual([
      [1, 1],
      [42, 42],
    ]);
    expect(pairSnapshots(prev, curr).size).toBe(42);
  });

  it("returns an empty pairing when either snapshot is empty", () => {
    expect(pairSnapshots([], descs(["A"])).size).toBe(0);
    expect(pairSnapshots(descs(["A"]), []).size).toBe(0);
  });
});

describe("findUniquePins", () => {
  it("keeps only canons that occur exactly once in both intervals", () => {
    const prev = descs(["H", "A", "A", "T"]);
    const curr = descs(["H", "A", "T", "A"]);

    expect(findUniquePins(prev, curr, 1, 4, 1, 4)).toEqual([
      { prevLine: 1, currLine: 1 },
      { prevLine: 4, currLine: 3 },
    ]);
  });

  it("restricts counts to the requested interval bounds", () => {
    const prev = descs(["A", "B"]);
    const curr = descs(["A", "B"]);

    expect(findUniquePins(prev, curr, 2, 2, 1, 2)).toEqual([{ prevLine: 2, currLine: 2 }]);
  });
});

describe("findStablePinBackbone", () => {
  it("returns empty when two optimal candidates tie at the same rank", () => {
    const backbone = findStablePinBackbone([
      { prevLine: 1, currLine: 2 },
      { prevLine: 2, currLine: 1 },
    ]);

    expect(backbone).toEqual([]);
  });

  it("returns the deterministic backbone for a nested reversal", () => {
    const backbone = findStablePinBackbone([
      { prevLine: 1, currLine: 1 },
      { prevLine: 2, currLine: 3 },
      { prevLine: 3, currLine: 2 },
      { prevLine: 4, currLine: 4 },
    ]);

    expect(backbone).toEqual([
      { prevLine: 1, currLine: 1 },
      { prevLine: 4, currLine: 4 },
    ]);
  });
});

describe("spec definition equivalence", () => {
  it("matches the ∩LIS_minΔ reference oracle on a seed-pinned pin corpus", () => {
    const rng = mulberry32(0x83);
    for (let trial = 0; trial < 200; trial++) {
      const count = 1 + Math.floor(rng() * 8);
      const pool = Array.from({ length: count + 3 }, (_, i) => i + 1);
      const cValues = shuffled(pool, rng).slice(0, count);
      const pins: AnchorPin[] = cValues.map((currLine, index) => ({
        prevLine: index + 1,
        currLine,
      }));

      const backbone = findStablePinBackbone(pins).map(pinKey).sort();

      expect(backbone).toEqual(referenceStablePinBackbone(pins));
    }
  });

  it("keeps canon equality, strict monotonicity and in-range coordinates on a mixed corpus", () => {
    const rng = mulberry32(0x5a);
    const alphabet = ["a", "b", "c", "d"];
    for (let trial = 0; trial < 400; trial++) {
      const draw = (): string[] =>
        Array.from({ length: 1 + Math.floor(rng() * 9) }, () => alphabet[Math.floor(rng() * 4)]!);
      const prev = descs(draw());
      const curr = descs(draw());

      const pairs = asPairs(pairSnapshots(prev, curr));
      let lastCurr = 0;
      for (const [prevLine, currLine] of pairs) {
        expect(prev[prevLine - 1]!.canonHash).toBe(curr[currLine - 1]!.canonHash);
        expect(prevLine).toBeGreaterThanOrEqual(1);
        expect(prevLine).toBeLessThanOrEqual(prev.length);
        expect(currLine).toBeGreaterThan(lastCurr);
        expect(currLine).toBeLessThanOrEqual(curr.length);
        lastCurr = currLine;
      }
    }
  });
});

describe("assertMonotonicPairing", () => {
  it("accepts a strictly increasing pairing", () => {
    expect(() =>
      assertMonotonicPairing(
        new Map([
          [1, 1],
          [2, 3],
        ]),
      ),
    ).not.toThrow();
  });

  it("throws when coordinates stop being strictly monotonic", () => {
    expect(() =>
      assertMonotonicPairing(
        new Map([
          [1, 2],
          [2, 1],
        ]),
      ),
    ).toThrow(/monotonicity violation/);
    expect(() =>
      assertMonotonicPairing(
        new Map([
          [1, 2],
          [2, 2],
        ]),
      ),
    ).toThrow(/monotonicity violation/);
  });
});

/**
 * Ticket #163: an edit that changes one region must not pay patience pairing over the
 * unchanged prefix and suffix. The trim is a pure evaluation shortcut: every pairing it
 * makes is forced (the canon is unique in both snapshots), so the result must equal the
 * untrimmed engine's on every corpus. `trim: false` is the differential reference.
 */
describe("pairSnapshots — unchanged boundary trim (issue #163)", () => {
  const uniqueRun = (count: number, prefix = "u"): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);

  it("maps an unchanged prefix and suffix positionally and leaves the changed middle unpaired", () => {
    const prev = descs(["a", "b", "c", "X", "d", "e"]);
    const curr = descs(["a", "b", "c", "Y", "d", "e"]);

    expect(asPairs(pairSnapshots(prev, curr))).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [5, 5],
      [6, 6],
    ]);
  });

  it("returns the untrimmed engine's pairing exactly on randomized corpora", () => {
    const rng = mulberry32(0x163);
    const alphabet = ["a", "b", "c", "d", "e"];
    for (let trial = 0; trial < 300; trial++) {
      const draw = (): string[] =>
        Array.from({ length: Math.floor(rng() * 13) }, () => alphabet[Math.floor(rng() * 5)]!);
      const prev = descs(draw());
      const curr = descs(draw());
      // WHY: shared boundaries are what the trim acts on; force them often so the differential
      // WHY: is not dominated by corpora the shortcut never touches.
      const shared = Math.floor(rng() * Math.min(prev.length, curr.length));
      for (let i = 0; i < shared; i++) {
        const token = `s${i}`;
        prev[i] = { lineNumber: i + 1, canonHash: token };
        curr[i] = { lineNumber: i + 1, canonHash: token };
      }

      expect(asPairs(pairSnapshots(prev, curr))).toEqual(
        asPairs(pairSnapshots(prev, curr, { trim: false })),
      );
    }
  });

  it("falls back when a boundary canon is duplicated, without guessing which copy survived", () => {
    const prev = descs(["A", "A", "B", "C"]);
    const curr = descs(["A", "A", "B", "D"]);

    const pairing = pairSnapshots(prev, curr);

    // The boundary canon is duplicated, so the trim cannot prove which copy survived and stands
    // down. The engine then handles it: B is a unique pin, and the identical A run is a rigid zip.
    expect(asPairs(pairing)).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(asPairs(pairing)).toEqual(asPairs(pairSnapshots(prev, curr, { trim: false })));
  });

  it("falls back on a fully changed file", () => {
    const prev = descs(["a", "b", "c"]);
    const curr = descs(["x", "y", "z"]);

    expect(pairSnapshots(prev, curr).size).toBe(0);
    expect(asPairs(pairSnapshots(prev, curr))).toEqual(
      asPairs(pairSnapshots(prev, curr, { trim: false })),
    );
  });

  it("covers edge insertions, edge deletions, moved blocks and duplicates like the untrimmed engine", () => {
    const cases: Array<[string, string[], string[]]> = [
      ["insertion at the head", ["b", "c", "d"], ["a", "b", "c", "d"]],
      ["insertion at the tail", ["a", "b", "c"], ["a", "b", "c", "d"]],
      ["deletion at the head", ["a", "b", "c", "d"], ["b", "c", "d"]],
      ["deletion at the tail", ["a", "b", "c", "d"], ["a", "b", "c"]],
      ["moved block", ["a", "b", "c", "d"], ["a", "c", "b", "d"]],
      ["duplicated middle", ["a", "b", "b", "c"], ["a", "b", "b", "d"]],
      ["duplicated boundary", ["a", "a", "b", "c", "c"], ["a", "a", "b", "d", "c", "c"]],
      ["whole file duplicated", ["x", "x", "x"], ["x", "x", "x", "x"]],
    ];
    for (const [label, prevTokens, currTokens] of cases) {
      const prev = descs(prevTokens);
      const curr = descs(currTokens);
      expect(asPairs(pairSnapshots(prev, curr)), label).toEqual(
        asPairs(pairSnapshots(prev, curr, { trim: false })),
      );
    }
  });

  it("scans only the changed middle: a one-line change is far cheaper than whole-file pairing", () => {
    const lines = uniqueRun(20_000);
    const changed = [...lines.slice(0, 10_000), "changed", ...lines.slice(10_001)];
    const prev = descs(lines);
    const curr = descs(changed);
    // WHY: warm both paths on a tiny corpus first, so the ratio measures the trim and not JIT.
    pairSnapshots(descs(uniqueRun(50)), descs(uniqueRun(50)));
    pairSnapshots(descs(uniqueRun(50)), descs(uniqueRun(50)), { trim: false });

    const quickest = (run: () => Map<number, number>): number => {
      let best = Infinity;
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const full = quickest(() => pairSnapshots(prev, curr, { trim: false }));
    const trimmed = quickest(() => pairSnapshots(prev, curr));

    expect(trimmed).toBeLessThan(full / 4);
    expect(asPairs(pairSnapshots(prev, curr))).toEqual(
      asPairs(pairSnapshots(prev, curr, { trim: false })),
    );
  });
});
