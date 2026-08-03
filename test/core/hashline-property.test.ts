import { describe, expect, it } from "vitest";
import {
  _lineHashesPure,
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline";
import { firstNonEmpty, lastNonEmpty, splitLines } from "../../src/utils";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

const VOCAB = [
  "",
  "}",
  "  foo",
  "import x",
  "dup",
  "dup",
  "a = 1;",
  "// c",
  "  bar",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

function randLine(rnd: () => number): string {
  return VOCAB[randInt(rnd, 0, VOCAB.length - 1)]!;
}

function randContent(rnd: () => number): string {
  return Array.from({ length: randInt(rnd, 0, 25) }, () => randLine(rnd)).join("\n");
}

function randReplacement(rnd: () => number): string[] {
  return Array.from({ length: randInt(rnd, 0, 5) }, () => randLine(rnd));
}

function randSpan(
  rnd: () => number,
  lines: string[],
  avoid: { s: number; e: number; repl: string[] }[],
  noTrailingNewline: boolean,
): { s: number; e: number; repl: string[] } | null {
  const n = lines.length;
  const isEofDeletion = (sp: { s: number; e: number; repl: string[] }): boolean =>
    sp.repl.length === 0 && sp.e === n && noTrailingNewline;
  const isMidDeletion = (sp: { s: number; e: number; repl: string[] }): boolean =>
    sp.repl.length === 0 && sp.e < n;
  for (let attempt = 0; attempt < 20; attempt++) {
    const s = randInt(rnd, 1, n);
    const e = randInt(rnd, s, n);
    if (avoid.some((other) => s <= other.e && other.s <= e)) continue;
    const repl = randReplacement(rnd);
    const span = { s, e, repl };
    if (avoid.some((other) =>
      (isEofDeletion(other) && isMidDeletion(span) && span.e === other.s - 1) ||
      (isEofDeletion(span) && isMidDeletion(other) && other.e === span.s - 1),
    )) continue;
    const first = firstNonEmpty(repl);
    const last = lastNonEmpty(repl);
    const prev = s >= 2 ? lines[s - 2] : undefined;
    const next = e < n ? lines[e] : undefined;
    if ((first !== undefined && first === prev) || (last !== undefined && last === next)) continue;
    if (avoid.some((other) =>
      (first !== undefined && other.e === s - 1 && lastNonEmpty(other.repl) === first) ||
      (last !== undefined && other.s === e + 1 && firstNonEmpty(other.repl) === last),
    )) continue;
    if (repl.length === 0 && s === 1 && e === n) continue;
    return span;
  }
  return null;
}

function assertMappingInvariants(
  oldLines: string[],
  oldHashes: string[],
  spans: { s: number; e: number }[],
  newLines: string[],
  newHashes: string[],
): void {
  expect(new Set(newHashes).size).toBe(newHashes.length);
  const oldHashToLine = new Map<string, string>();
  for (let i = 0; i < oldHashes.length; i++) {
    oldHashToLine.set(oldHashes[i]!, oldLines[i]!);
  }
  const outsideByContent = new Map<string, { index: number; hash: string }[]>();
  for (let i = 0; i < oldHashes.length; i++) {
    if (spans.some((sp) => i >= sp.s - 1 && i <= sp.e - 1)) continue;
    const list = outsideByContent.get(oldLines[i]!) ?? [];
    list.push({ index: i, hash: oldHashes[i]! });
    outsideByContent.set(oldLines[i]!, list);
  }
  const newCounts = new Map<string, number>();
  for (const line of newLines) {
    newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  }
  for (const [content, entries] of outsideByContent) {
    const newCount = newCounts.get(content) ?? 0;
    const preserved = entries.filter((entry) => {
      const j = newHashes.indexOf(entry.hash);
      return j >= 0 && newLines[j] === content;
    });
    if (newCount >= entries.length) {
      expect(preserved).toHaveLength(entries.length);
    } else {
      expect(preserved).toHaveLength(newCount);
      const lost = entries.filter((entry) => !preserved.includes(entry));
      for (const entry of lost) {
        expect(content, `non-empty outside line ${entry.index + 1} lost its hash`).toBe("");
      }
    }
  }
  for (let j = 0; j < newHashes.length; j++) {
    const oldLine = oldHashToLine.get(newHashes[j]!);
    if (oldLine !== undefined) {
      expect(newLines[j], `hash ${newHashes[j]} reused at a line with different content`).toBe(oldLine);
    }
  }
}

describe("property: single random edit per call", () => {
  it("applies the edit exactly and keeps mapping invariants for 400 random cases", async () => {
    for (let iter = 0; iter < 400; iter++) {
      const rnd = mulberry32(iter * 7919 + 13);
      const content = randContent(rnd);
      const lines = splitLines(content);
      const hashes = await lineHashes(content, home.testPath);
      const span = randSpan(rnd, lines, [], !content.endsWith("\n"));
      if (!span) continue;
      let expected = [
        ...lines.slice(0, span.s - 1),
        ...span.repl,
        ...lines.slice(span.e),
      ].join("\n");
      if (content.endsWith("\n")) {
        expected += "\n";
      }
      const edit = resEdit({
        hash_range_inclusive: [hashes[span.s - 1]!, hashes[span.e - 1]!],
        content_lines: span.repl,
      });
      const result = applyEdit(content, edit, undefined, hashes, home.testPath);
      expect(result.content).toBe(expected);
      expect(result.autoFixes).toBeUndefined();
      const removedHashes = new Set(hashes.slice(span.s - 1, span.e));
      const resultHashes = await lineHashes(expected, home.testPath, {
        content,
        hashes,
        removedHashes,
      });
      assertMappingInvariants(
        lines,
        hashes,
        [span],
        splitLines(expected),
        resultHashes,
      );
    }
  }, 60_000);
});

describe("property: sequential random edits", () => {
  it("applies sequential single edits exactly and keeps mapping invariants for 150 random cases", async () => {
    for (let iter = 0; iter < 150; iter++) {
      const rnd = mulberry32(iter * 104729 + 7);
      const content = randContent(rnd);
      const lines = splitLines(content);
      const hashes = await lineHashes(content, home.testPath);
      const spans: { s: number; e: number; repl: string[] }[] = [];
      for (let i = 0; i < 3 && spans.length < 3; i++) {
        const span = randSpan(rnd, lines, spans, !content.endsWith("\n"));
        if (span) spans.push(span);
      }
      if (spans.length < 2) continue;
      let expectedLines = lines;
      for (const span of [...spans].sort((a, b) => b.s - a.s)) {
        expectedLines = [
          ...expectedLines.slice(0, span.s - 1),
          ...span.repl,
          ...expectedLines.slice(span.e),
        ];
      }
      let expected = expectedLines.join("\n");
      if (content.endsWith("\n")) {
        expected += "\n";
      }
      let current = content;
      for (const span of [...spans].sort((a, b) => b.s - a.s)) {
        const currentHashes = await lineHashes(current, home.testPath);
        const edit = resEdit({
          hash_range_inclusive: [currentHashes[span.s - 1]!, currentHashes[span.e - 1]!],
          content_lines: span.repl,
        });
        const result = applyEdit(current, edit, undefined, currentHashes, home.testPath);
        current = result.content;
      }
      expect(current).toBe(expected);
      const removedHashes = new Set<string>();
      for (const span of spans) {
        for (const hash of hashes.slice(span.s - 1, span.e)) {
          removedHashes.add(hash);
        }
      }
      const resultHashes = await lineHashes(expected, home.testPath, {
        content,
        hashes,
        removedHashes,
      });
      assertMappingInvariants(
        lines,
        hashes,
        spans,
        splitLines(expected),
        resultHashes,
      );
    }
  }, 60_000);
});

describe("property: pure hashing uniqueness", () => {
  it("assigns unique anchors for 100 random files up to 200 lines", () => {
    for (let iter = 0; iter < 100; iter++) {
      const rnd = mulberry32(iter * 15485863 + 3);
      const content = Array.from(
        { length: randInt(rnd, 0, 200) },
        () => randLine(rnd),
      ).join("\n");
      const hashes = _lineHashesPure(content);
      expect(hashes).toHaveLength(splitLines(content).length);
      expect(new Set(hashes).size).toBe(hashes.length);
    }
  }, 60_000);
});

describe("property: chained stable mapping at every step", () => {
  it("keeps mapping invariants across sequential edits with mapStableHashes per step", async () => {
    for (let iter = 0; iter < 60; iter++) {
      const rnd = mulberry32(iter * 1000003 + 17);
      const chainPath = `${home.testPath}-chain-${iter}`;
      let content = randContent(rnd);
      let lines = splitLines(content);
      let hashes = await lineHashes(content, chainPath);
      let edited = 0;
      for (let step = 0; step < 8 && edited < 6; step++) {
        const span = randSpan(rnd, lines, [], !content.endsWith("\n"));
        if (!span) break;
        const edit = resEdit({
          hash_range_inclusive: [hashes[span.s - 1]!, hashes[span.e - 1]!],
          content_lines: span.repl,
        });
        let result;
        try {
          result = applyEdit(content, edit, undefined, hashes, chainPath);
        } catch {
          continue;
        }
        if (result.content === content) continue;
        expect(result.autoFixes).toBeUndefined();
        let expected = [
          ...lines.slice(0, span.s - 1),
          ...span.repl,
          ...lines.slice(span.e),
        ].join("\n");
        if (content.endsWith("\n")) expected += "\n";
        expect(result.content).toBe(expected);
        const removedHashes = new Set(hashes.slice(span.s - 1, span.e));
        const nextHashes = await lineHashes(expected, chainPath, {
          content,
          hashes,
          removedHashes,
        });
        expect(nextHashes).toHaveLength(splitLines(expected).length);
        assertMappingInvariants(
          lines,
          hashes,
          [span],
          splitLines(expected),
          nextHashes,
        );
        content = expected;
        lines = splitLines(expected);
        hashes = nextHashes;
        edited++;
      }
      if (edited > 0) {
        const reloaded = await lineHashes(content, chainPath);
        expect(reloaded).toEqual(hashes);
      }
    }
  }, 120_000);
});
