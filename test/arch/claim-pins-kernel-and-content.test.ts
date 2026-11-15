/**
 * Executable pins for the load-bearing claims the M3 comment drain deleted from
 * `src/store-kernel/*` and `src/file-content/*` (plus the three top-level modules whose
 * numbers are computed there). Each test names the M3 inventory item it pins, so a
 * claim whose mechanism breaks shows up as a failed number rather than a lost sentence.
 *
 * Claims 5, 7, 9 (the fallback half), 17 and 18 are pinned by existing tests and cited in
 * the ticket report rather than duplicated here; the gaps are recorded there too.
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_BYTES } from "../../src/constants.js";
import { DomainError } from "../../src/domain-errors.js";
import { computeDrift } from "../../src/drift.js";
import { genDiff } from "../../src/edit-diff.js";
import { batchAbortForMany, buildBatchResult } from "../../src/edit-response.js";
import { attachEnvelope, readEnvelope } from "../../src/error-envelope.js";
import { loadFileKindAndText } from "../../src/file-content/detection.js";
import {
  classifyCodepoint,
  invisibleName,
  scanInvisibleLine,
} from "../../src/file-content/invisible.js";
import { visibleLineTotal, walkLines } from "../../src/file-content/line-walker.js";
import { fmtReadPreview, StatIdentityMismatchError } from "../../src/file-content/preview.js";
import {
  ANCHOR_LEN,
  HASH_SEP,
  canon,
  canonDigest,
  defaultHashIdentity,
} from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher.js";
import { clearNoopLoop, runNoopPolicy, type NoopPolicyInput } from "../../src/noop-guard.js";
import { busyBudgetMs, resolveBusyBudget, withBusyRetry } from "../../src/store-kernel/busy.js";
import { HASH_STORE_BUSY_TIMEOUT } from "../../src/store-kernel/constants.js";
import { splitLines, visLines } from "../../src/utils.js";

/** Counts the byte-image reads `src/file-content/detection.ts` performs through `fs-write`. */
const byteReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/fs-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/fs-write.js")>();
  return {
    ...actual,
    readBytes: async (path: string): Promise<Buffer> => {
      byteReads.count += 1;
      return actual.readBytes(path);
    },
  };
});

let scratch = "";
/** Every codepoint the frozen classifier claims, derived from the classifier itself. */
let classified: number[] = [];

beforeAll(async () => {
  await initHasher();
  scratch = mkdtempSync(join(tmpdir(), "claim-pins-"));
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if (classifyCodepoint(codePoint) !== undefined) classified.push(codePoint);
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function hasDecodeErrors(file: unknown): boolean {
  return (file as { hadUtf8DecodeErrors?: boolean }).hadUtf8DecodeErrors === true;
}

describe("store-kernel contention budget (M3 #1-#4)", () => {
  it("#1 prices one contention episode at 4300ms", () => {
    expect(busyBudgetMs()).toBe(4300);
  });

  it("#1 scales the 100-attempt illustration to 68.7s", () => {
    expect(busyBudgetMs({ maxAttempts: 100 })).toBe(68_700);
  });

  it("#1 puts the corrupt-store rebuild worst case at 3 x 4300ms", () => {
    expect(3 * busyBudgetMs()).toBe(12_900);
  });

  it("#1 recomputes from whichever constants it is handed, never from a global cap", () => {
    expect(busyBudgetMs({ backoffCapMs: 800 })).toBe(5_500);
    expect(busyBudgetMs({ maxAttempts: 4 })).toBe(1_500);
  });

  it("#2 ends an episode BELOW maxAttempts once the deadline has passed", () => {
    const failure = Object.assign(new Error("SQLITE_BUSY"), { errcode: 5 });
    let clockReads = 0;
    const now = (): number => (clockReads++ === 0 ? 0 : 4_300);
    let attempts = 0;
    let caught: unknown;
    try {
      withBusyRetry(
        () => {
          attempts += 1;
          throw failure;
        },
        { maxAttempts: 8, now },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(attempts).toBe(1);
    expect(resolveBusyBudget({ maxAttempts: 8 }).maxAttempts).toBe(8);
  });

  it("#3 floors maxAttempts at one, so 0 and -1 both cost a single 250ms attempt", () => {
    const failure = Object.assign(new Error("SQLITE_BUSY"), { errcode: 5 });
    for (const maxAttempts of [0, -1]) {
      let attempts = 0;
      let caught: unknown;
      try {
        withBusyRetry(
          () => {
            attempts += 1;
            throw failure;
          },
          { maxAttempts },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(attempts).toBe(1);
      expect(resolveBusyBudget({ maxAttempts }).maxAttempts).toBe(1);
      expect(busyBudgetMs({ maxAttempts })).toBe(250);
    }
    expect(resolveBusyBudget({ maxAttempts: 3.9 }).maxAttempts).toBe(3);
  });

  it("#4 pins the per-statement wait at 250ms, the value the model was computed against", () => {
    expect(HASH_STORE_BUSY_TIMEOUT).toBe(250);
    expect(busyBudgetMs({ timeoutMs: 1_000 })).toBe(10_300);
  });
});

describe("line walker empty-text divergence (M3 #8)", () => {
  it("makes the empty text the one case where visLines and splitLines disagree", () => {
    for (const text of ["a", "a\n", "a\nb", "a\nb\n", "\n", "a\n\n"]) {
      expect(visLines(text)).toEqual(splitLines(text));
    }
    expect(splitLines("")).toEqual([""]);
    expect(visLines("")).toEqual([]);
    expect(splitLines("a\n")).toHaveLength(1);
    expect(visLines("a\n")).toHaveLength(1);
  });

  it("keeps a terminal newline as a sentinel in the walk, never as a line", () => {
    expect(walkLines("a\n").total).toBe(1);
    expect(walkLines("a\nb\n").total).toBe(2);
    expect(walkLines("a\nb").total).toBe(2);
    expect(walkLines("a\nb\n").ranges).toEqual([]);
    expect(visibleLineTotal("a\nb\n", walkLines("a\nb\n").total)).toBe(2);
  });

  it("carries the walk total as the snapshot count, with the empty text as its one sentinel", () => {
    for (const text of ["", "a", "a\n", "a\nb\n", "\n\n"]) {
      expect(walkLines(text).total).toBe(splitLines(text).length);
    }
    expect(walkLines("").total).toBe(1);
    expect(splitLines("")).toHaveLength(1);
    expect(visibleLineTotal("", 1)).toBe(visLines("").length);
    expect(visibleLineTotal("", 1)).toBe(0);
  });
});

describe("invisible codepoint class derivations (M3 #12)", () => {
  it("derives the control class as C0 minus TAB/LF/CR, plus DEL, plus C1", () => {
    const expected = new Set<number>();
    for (let codePoint = 0x00; codePoint <= 0x1f; codePoint += 1) expected.add(codePoint);
    for (const textWhitespace of [0x09, 0x0a, 0x0d]) expected.delete(textWhitespace);
    expected.add(0x7f);
    for (let codePoint = 0x80; codePoint <= 0x9f; codePoint += 1) expected.add(codePoint);

    const derived = classified.filter(
      (codePoint) => classifyCodepoint(codePoint) === "non_printable_control",
    );
    expect(derived).toHaveLength(62);
    expect(derived).toEqual([...expected]);
    expect(classifyCodepoint(0x0085)).toBe("non_printable_control");
  });

  it("counts 21 non-ASCII canon codepoints, with U+0085 claimed by the control class", () => {
    for (const textWhitespace of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) {
      expect(canon(String.fromCodePoint(textWhitespace))).toBe("");
    }
    const stripped = classified.filter(
      (codePoint) => classifyCodepoint(codePoint) === "canon_stripped",
    );
    expect(stripped).toHaveLength(21);
    expect(stripped.every((codePoint) => codePoint >= 0x80)).toBe(true);
    expect(stripped.every((codePoint) => canon(String.fromCodePoint(codePoint)) === "")).toBe(true);

    const controlAndCanon = classified.filter(
      (codePoint) =>
        classifyCodepoint(codePoint) === "non_printable_control" &&
        canon(String.fromCodePoint(codePoint)) === "",
    );
    expect(controlAndCanon).toEqual([0x0b, 0x0c, 0x0085]);
    expect(controlAndCanon.filter((codePoint) => codePoint >= 0x80)).toEqual([0x0085]);
  });

  it("keeps 16 canon-surviving codepoints, 12 of them carrying the bidi hazard", () => {
    const surviving = classified.filter(
      (codePoint) => classifyCodepoint(codePoint) === "canon_surviving",
    );
    expect(surviving).toHaveLength(16);
    for (const codePoint of surviving) {
      expect(canon(String.fromCodePoint(codePoint))).not.toBe("");
    }

    const bidi = classified.filter(
      (codePoint) => scanInvisibleLine(String.fromCodePoint(codePoint))[0]?.bidi === true,
    );
    expect(bidi).toHaveLength(12);
  });

  it("names every claimed codepoint, naming U+0085 and U+FEFF with their Unicode aliases", () => {
    const unnamed = classified
      .filter((codePoint) => invisibleName(codePoint) === undefined)
      .map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    expect(unnamed).toEqual([]);
    expect(invisibleName(0x0085)).toBe("NEXT LINE");
    expect(invisibleName(0xfeff)).toBe("ZERO WIDTH NO-BREAK SPACE");
    expect(invisibleName(0x00ad)).toBe("SOFT HYPHEN");
  });
});

describe("UTF-8 decoding: suspicion versus byte comparison (M3 #10-#11)", () => {
  it("#10 treats a literal U+FFFD as proof of nothing and lets the byte comparison report", async () => {
    const clean = join(scratch, "clean.txt");
    const literal = join(scratch, "literal-replacement.txt");
    const invalid = join(scratch, "invalid-byte.txt");
    writeFileSync(clean, "const a = 1;\n", "utf-8");
    writeFileSync(literal, "const a = '\uFFFD';\n", "utf-8");
    writeFileSync(invalid, Buffer.from([0x61, 0x3d, 0xff, 0x0a]));

    byteReads.count = 0;
    const cleanFile = await loadFileKindAndText(clean);
    expect(cleanFile.kind).toBe("text");
    expect(byteReads.count).toBe(0);
    expect(hasDecodeErrors(cleanFile)).toBe(false);

    byteReads.count = 0;
    const literalFile = await loadFileKindAndText(literal);
    expect(byteReads.count).toBe(1);
    expect(hasDecodeErrors(literalFile)).toBe(false);

    byteReads.count = 0;
    const invalidFile = await loadFileKindAndText(invalid);
    expect(byteReads.count).toBe(1);
    expect(hasDecodeErrors(invalidFile)).toBe(true);
  });

  it("#11 keeps the BOM so the whole byte image round-trips", async () => {
    const path = join(scratch, "bom.txt");
    writeFileSync(path, Buffer.from("\uFEFFconst a = '\uFFFD';\n", "utf-8"));

    byteReads.count = 0;
    const file = await loadFileKindAndText(path);
    expect(byteReads.count).toBe(1);
    expect(hasDecodeErrors(file)).toBe(false);
    expect((file as { text?: string }).text?.startsWith("\uFEFF")).toBe(true);
  });
});

describe("the 100MB load guard and the served anchor set (M3 #6)", () => {
  it("refuses an over-limit file as binary before reading it, in both render modes", async () => {
    const path = join(scratch, "over-limit.txt");
    writeFileSync(path, "");
    truncateSync(path, MAX_BYTES + 1);

    expect(MAX_BYTES).toBe(104_857_600);
    expect(await loadFileKindAndText(path)).toEqual({
      kind: "binary",
      description: "file exceeds 104857600 byte limit",
    });
    expect(await loadFileKindAndText(path, { maxLines: 5 })).toEqual({
      kind: "binary",
      description: "file exceeds 104857600 byte limit",
    });
  });

  it("retains one anchor per hashed line even for lines the page never shows", async () => {
    const text = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")}\n`;
    const walk = await defaultHashIdentity.anchorsForWalk(text, { path: "/repo/anchors.txt" });
    const preview = await fmtReadPreview(text, { offset: 1, limit: 5 }, walk, "/repo/anchors.txt");

    expect(preview.lineTotals.visible).toBe(100);
    expect(preview.served).toHaveLength(5);
    expect(preview.text.split("\n")).toHaveLength(5);
    expect(preview.hashes).toHaveLength(100);
  });
});

describe("a stat-matched source that disagrees with the file (M3 #9)", () => {
  it("refuses the source, naming both line counts, when the count disagrees", async () => {
    const text = "alpha\nbravo\ncharlie\ndelta\n";
    const source = { anchorCount: 3, range: async (): Promise<never[]> => [] };

    await expect(fmtReadPreview(text, {}, source, "/repo/disagree.txt")).rejects.toBeInstanceOf(
      StatIdentityMismatchError,
    );
    await expect(fmtReadPreview(text, {}, source, "/repo/disagree.txt")).rejects.toThrow(
      "stat-matched snapshot has 3 lines, file has 4.",
    );
  });

  it("refuses the source when a served line's canon digest disagrees", async () => {
    const text = "alpha\nbravo\n";
    const source = {
      anchorCount: 2,
      range: async (start: number, end: number) =>
        [
          { anchor: "aaaa", canonHash: canonDigest("alpha") },
          { anchor: "bbbb", canonHash: canonDigest("charlie") },
        ].slice(start, end),
    };

    await expect(fmtReadPreview(text, {}, source, "/repo/moved.txt")).rejects.toThrow(
      "stat-matched snapshot line 2 no longer matches the file.",
    );
  });
});

describe("drift episode judgement (M3 #13)", () => {
  const lines = ["one", "two", "three", "four"];

  it("#13 excludes drift inside the served window", () => {
    const result = computeDrift({
      served: ["a1", "a2", "a3", "a4"],
      resultHashes: ["b1", "b2", "b3", "b4"],
      resultLines: lines,
      range: { startLine: 2, endLine: 3, startHash: "a2", endHash: "a3", delta: 0 },
      reported: new Set(),
    });

    expect(result?.total).toBe(2);
  });

  it("#13 treats a zero-width insertion as an empty interval, never a width-1 window", () => {
    const result = computeDrift({
      served: ["a1", "a2", "a3", "a4"],
      resultHashes: ["b1", "b2", "b3", "b4"],
      resultLines: lines,
      intervals: [{ startLine: 3, endLine: 2, startHash: "a2", endHash: "a2", delta: 1 }],
      reported: new Set(),
    });

    expect(result?.total).toBe(4);
  });

  it("#13 falls back to the served line numbers when a range hash is not unique", () => {
    const result = computeDrift({
      served: ["dup", "a1", "a2", "b1", "dup"],
      resultHashes: ["c1", "c2", "c3", "c4", "c5"],
      resultLines: lines,
      range: { startLine: 2, endLine: 3, startHash: "dup", endHash: "dup", delta: 0 },
      reported: new Set(),
    });

    expect(result?.total).toBe(3);
  });

  it("#13 spares a rotated survivor through the canon digests and reports it without them", () => {
    const input = {
      served: ["h0", "gone"],
      resultHashes: ["n0", "n1"],
      resultLines: ["alpha", "beta"],
      range: { startLine: 1, endLine: 1, startHash: "h0", endHash: "h0", delta: 0 },
      reported: new Set<string>(),
    };

    expect(
      computeDrift({ ...input, servedCanonDigests: [canonDigest("alpha"), canonDigest("beta")] }),
    ).toBeUndefined();
    expect(computeDrift(input)?.total).toBe(1);
  });
});

describe("diff projection limits (M3 #14)", () => {
  const gutter = " ".repeat(ANCHOR_LEN + 1) + HASH_SEP;
  const hashes = Array.from({ length: 10 }, (_, index) => `h${index}`);
  const subRows = (diff: string): string[] =>
    diff.split("\n").filter((line) => line.startsWith(gutter));

  it("#14 keeps the caret at exactly the 200-byte sub-row cap and drops it one byte past", () => {
    const atCap = genDiff("x\n", `x\n${" ".repeat(160)}\u0000\n`, 2, ["h0", "h1"]).diff;
    const overCap = genDiff("x\n", `x\n${" ".repeat(161)}\u0000\n`, 2, ["h0", "h1"]).diff;
    const caretForm = (padding: number, body: string): string =>
      `${gutter}${" ".repeat(padding)}▲ ${body}`;

    expect(Buffer.byteLength(caretForm(160, "[col 161: U+0000 NULL added]"), "utf-8")).toBe(200);
    expect(Buffer.byteLength(caretForm(161, "[col 162: U+0000 NULL added]"), "utf-8")).toBe(201);

    expect(subRows(atCap)).toEqual([`${gutter}${" ".repeat(160)}▲ [col 161: U+0000 NULL added]`]);
    expect(subRows(overCap)).toEqual([`${gutter} [col 162: U+0000 NULL added]`]);
  });

  it("#14 keeps every entry's column and full name past the cap", () => {
    const diff = genDiff("x\n", `x\n${" ".repeat(180)}\u0000\u0007\n`, 2, ["h0", "h1"]).diff;

    expect(subRows(diff)).toEqual([`${gutter} [col 181: U+0000 NULL; col 182: U+0007 BELL added]`]);
  });

  it("#14 renders a middle gap whole at 2x context and collapses it to one counted marker", () => {
    const before = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"].join("\n");
    const smallGap = ["L0", "L1", "X2", "L3", "L4", "L5", "L6", "X7", "L8", "L9"].join("\n");
    const largeGap = ["L0", "L1", "X2", "L3", "L4", "L5", "L6", "L7", "X8", "L9"].join("\n");

    const small = genDiff(`${before}\n`, `${smallGap}\n`, 2, hashes).diff;
    const large = genDiff(`${before}\n`, `${largeGap}\n`, 2, hashes).diff;
    const noContext = genDiff(`${before}\n`, `${smallGap}\n`, 0, hashes).diff;

    expect(small).not.toContain("lines untouched");
    expect(large.match(/lines untouched/g)).toHaveLength(1);
    expect(large).toContain(" ... [1 lines untouched] ...");
    expect(noContext.match(/lines untouched/g)).toHaveLength(1);
    expect(noContext).toContain(" ... [4 lines untouched] ...");
  });

  it("#14 keeps every anchor after a marker at its true file position", () => {
    const before = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"].join("\n");
    const after = ["L0", "L1", "X2", "L3", "L4", "L5", "L6", "X7", "L8", "L9"].join("\n");
    const diff = genDiff(`${before}\n`, `${after}\n`, 1, hashes).diff;

    const anchored = diff
      .split("\n")
      .filter((line) => line.startsWith(" ") && line.includes(HASH_SEP));
    expect(anchored).toContain(` ${hashes[6]}${HASH_SEP}L6`);
    expect(anchored).toContain(` ${hashes[8]}${HASH_SEP}L8`);
  });
});

describe("edit response composition (M3 #15)", () => {
  it("#15 renders the batch diff from the carried render, keeping one render per commit", () => {
    const result = buildBatchResult([
      {
        path: "a.ts",
        originalNormalized: "alpha\n",
        result: "beta\n",
        originalHashes: ["o0"],
        resultHashes: ["r0"],
        resultHash: "snap-a",
        warnings: undefined,
        driftNotice: undefined,
        appliedCount: 1,
        noopCount: 0,
        totalAddedLines: 1,
        totalRemovedLines: 1,
        renderedDiff: { diff: "SENTINEL-RENDER", firstChangedLine: 42, lastChangedLine: 43 },
      },
    ]);

    expect(result.details.diff).toBe(`--- a.ts ---\nSENTINEL-RENDER`);
    expect(result.content[0]?.text).toContain("SENTINEL-RENDER");
    expect(result.details.servedByPath?.[0]?.firstChangedLine).toBe(42);
    expect(result.details.servedByPath?.[0]?.lastChangedLine).toBe(43);
  });

  it("#15 carries the forwarded payload through the one writer/reader pair", () => {
    const rejection = new Error("[MODEL] rejected");
    const envelope = {
      code: "E_BAD_PAYLOAD" as const,
      cause: "served span" as const,
      servedRows: [{ position: 3, hash: "abcdef" }],
      servedBlock: "abcdef│line",
      payloadMessage: 'Edit request field "anchor_from" is not a hash.',
    };

    attachEnvelope(rejection, envelope);
    expect(readEnvelope(rejection)).toEqual(envelope);
    expect(readEnvelope({ code: "E_NOT_A_REGISTRY_CODE" })).toEqual({});
  });

  it("#15 promotes the FIRST item's raw string code, not a later registry member", () => {
    const unknownHead = Object.assign(new Error("head"), { code: "E_NOT_A_REGISTRY_CODE" });
    const later = new DomainError("E_BAD_PAYLOAD", { message: "bad anchor" });

    const headUnknown = batchAbortForMany({
      failures: [
        { error: unknownHead, index: 0 },
        { error: later, index: 1 },
      ],
      path: "a.ts",
    });
    const headKnown = batchAbortForMany({
      failures: [
        { error: later, index: 0 },
        { error: unknownHead, index: 1 },
      ],
      path: "a.ts",
    });

    expect(readEnvelope(headUnknown)?.code).toBeUndefined();
    expect(readEnvelope(headKnown)?.code).toBe("E_BAD_PAYLOAD");
  });
});

describe("noop-loop slot shape (M3 #16)", () => {
  function input(sessionKey: string, absolutePath: string, ref: string): NoopPolicyInput {
    return {
      absolutePath,
      removeFrom: "h1",
      removeTo: "h1",
      replacementText: "next",
      ref,
      batch: false,
      range: { startLine: 1, endLine: 1, startHash: "h1", endHash: "h1", delta: 0 },
      hashes: ["h1"],
      lines: ["alpha"],
      sessionKey,
      contentHash: "snap",
    };
  }

  it("#16 keys one slot per session, path and ref, so siblings cannot reset each other", async () => {
    const sessionKey = "claim-pins-noop-siblings";
    const siblingSession = `${sessionKey}-other`;
    try {
      expect(await runNoopPolicy(input(sessionKey, "/repo/a.ts", "h1"))).toEqual({
        action: "proceed",
        count: 1,
      });
      expect(await runNoopPolicy(input(sessionKey, "/repo/b.ts", "h1"))).toEqual({
        action: "proceed",
        count: 1,
      });
      expect(await runNoopPolicy(input(sessionKey, "/repo/a.ts", "h2"))).toEqual({
        action: "proceed",
        count: 1,
      });
      expect(await runNoopPolicy(input(siblingSession, "/repo/a.ts", "h1"))).toEqual({
        action: "proceed",
        count: 1,
      });
      expect(await runNoopPolicy(input(sessionKey, "/repo/a.ts", "h1"))).toEqual({
        action: "warn",
        count: 2,
        notice: expect.stringContaining("W_NOOP"),
      });
    } finally {
      clearNoopLoop(sessionKey);
      clearNoopLoop(siblingSession);
    }
  });
});
