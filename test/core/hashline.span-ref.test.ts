import { describe, expect, it, beforeAll } from "vitest";
import { contentOnlyHashes } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit, serializeLineList } from "../../src/hashline/apply";
import { HASH_SEP, canonDigest } from "../../src/hashline/hash-identity";
import { splitLines } from "../../src/utils";
import type { HEdit, LeaseSpanSource } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

const FILE = "a\nb\nX\nY\nc\n";
const H = contentOnlyHashes(FILE);

// WHY: the span-ref arm's internal-seam shape (ticket-02): the target names where the text lands,
// WHY: `source` names the same-file line span to copy from, and `retire` distinguishes move from
// WHY: copy. `content_lines` is the empty placeholder the implementation materializes from the
// WHY: pre-item buffer — the caller never hand-writes copied text.
function spanRefEdit(
  target: [number, number],
  source: [number, number],
  retire: boolean,
  placement?: HEdit["placement"],
): HEdit {
  return {
    content_lines: [],
    hash_bounds: [{ hash: H[target[0] - 1]! }, { hash: H[target[1] - 1]! }],
    ...(placement !== undefined ? { placement } : {}),
    source: {
      bounds: [{ hash: H[source[0] - 1]! }, { hash: H[source[1] - 1]! }],
      retire,
    },
  } as HEdit;
}

function expectErrorCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("applyEdit — span-ref copy (source survives)", () => {
  it("copies a multi-line source onto a replace target that lies before the source", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], false), undefined, H);
    expect(result.content).toBe("X\nY\nb\nX\nY\nc\n");
  });

  it("copies a multi-line source onto a replace target that lies after the source", () => {
    const result = applyEdit(FILE, spanRefEdit([5, 5], [3, 4], false), undefined, H);
    expect(result.content).toBe("a\nb\nX\nY\nX\nY\n");
  });

  it("copies with an insertion placement (before) — a zero-width splice, source untouched", () => {
    const result = applyEdit(FILE, spanRefEdit([2, 2], [3, 4], false, "before"), undefined, H);
    expect(result.content).toBe("a\nX\nY\nb\nX\nY\nc\n");
  });

  it("copies with an insertion placement (after) adjacent to the source — source untouched", () => {
    const result = applyEdit(FILE, spanRefEdit([4, 4], [3, 4], false, "after"), undefined, H);
    expect(result.content).toBe("a\nb\nX\nY\nX\nY\nc\n");
  });

  it("a self-copy is the honest noop — bytes unchanged, noopEdit present", () => {
    const result = applyEdit(FILE, spanRefEdit([2, 2], [2, 2], false), undefined, H);
    expect(result.content).toBe(FILE);
    expect(result.noopEdit).toBeDefined();
  });
});

describe("applyEdit — span-ref move (source retired)", () => {
  it("moves onto a replace target before the source — no duplication, no residue", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], true), undefined, H);
    expect(result.content).toBe("X\nY\nb\nc\n");
  });

  it("moves onto a replace target adjacent to (immediately after) the source", () => {
    // The result bytes coincide with a plain target deletion here, so the applied-not-noop status
    // and the retired source span (invariant 7's carrier) are what refute a half-implementation.
    const result = applyEdit(FILE, spanRefEdit([5, 5], [3, 4], true), undefined, H);
    expect(result.content).toBe("a\nb\nX\nY\n");
    expect(result.noopEdit).toBeUndefined();
    expect(result.sourceRange).toEqual({
      startLine: 3,
      endLine: 4,
      startHash: H[2]!,
      endHash: H[3]!,
      delta: -2,
    });
  });

  it("moves onto an insertion target — the retired lines re-enter once, at the point", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], true, "after"), undefined, H);
    expect(result.content).toBe("a\nX\nY\nb\nc\n");
  });

  it("a move from a multi-line source onto a single-line target retires the source", () => {
    const result = applyEdit(FILE, spanRefEdit([5, 5], [1, 2], true), undefined, H);
    expect(result.content).toBe("X\nY\na\nb\n");
  });

  it("the degenerate adjacent move is the honest noop — no crash, no write, no double-apply", () => {
    // Insert `X\nY` after line 2 while retiring exactly lines 3..4: the assembled bytes are the
    // pre-item bytes, so this must ride the noop path rather than splice twice.
    const result = applyEdit(FILE, spanRefEdit([2, 2], [3, 4], true, "after"), undefined, H);
    expect(result.content).toBe(FILE);
    expect(result.noopEdit).toBeDefined();
  });

  it("refuses a retired source that overlaps the target with E_BAD_PAYLOAD", () => {
    expectErrorCode(
      () => applyEdit(FILE, spanRefEdit([3, 4], [4, 5], true), undefined, H),
      "E_BAD_PAYLOAD",
    );
    expectErrorCode(
      () => applyEdit(FILE, spanRefEdit([3, 3], [3, 4], true), undefined, H),
      "E_BAD_PAYLOAD",
    );
    // WHY: (ticket-02b P1-B) the pinned predicate is placement-aware: an insertion point strictly
    // WHY: inside the retired lines overlaps it — `before` when s1 < T <= s2, `after` when
    // WHY: s1 <= T < s2. Both spellings refuse; today they wrote corrupt bytes.
    expectErrorCode(
      () => applyEdit(FILE, spanRefEdit([3, 3], [3, 4], true, "after"), undefined, H),
      "E_BAD_PAYLOAD",
    );
    expectErrorCode(
      () => applyEdit(FILE, spanRefEdit([4, 4], [3, 4], true, "before"), undefined, H),
      "E_BAD_PAYLOAD",
    );
  });

  it("the four touching spellings stay legal — refusing one alias would refuse its twin", () => {
    // Positive control for the refusal above: the positions OUTSIDE the retired lines are legal and
    // WHY: must all compute the input bytes (invariant 10's honest noop, both alias pairs).
    for (const [at, line] of [
      ["before", 3],
      ["after", 2],
      ["after", 4],
      ["before", 5],
    ] as const) {
      const result = applyEdit(FILE, spanRefEdit([line, line], [3, 4], true, at), undefined, H);
      expect(result.content).toBe(FILE);
      expect(result.noopEdit).toBeDefined();
    }
  });

  it("the empty file keeps its honest noop on the touching spellings (ticket-02d P1)", () => {
    // WHY: `splitLines("") = [""]` — one empty line — so a touching degenerate move has
    // WHY: `retired.s2 = 1 = fileLines.length` and an empty last line in `out`: the terminator clause
    // WHY: must NOT fire on the empty body. The bytes are pinned to `""` absolutely (not just
    // WHY: call-vs-call equality — two calls can agree on the wrong value), matching the parent's
    // WHY: honest noop.
    const h = contentOnlyHashes("");
    for (const at of ["before", "after"] as const) {
      const move: HEdit = {
        content_lines: [],
        hash_bounds: [{ hash: h[0]! }, { hash: h[0]! }],
        placement: at,
        source: { bounds: [{ hash: h[0]! }, { hash: h[0]! }], retire: true },
      } as HEdit;
      const result = applyEdit("", move, undefined, h);
      expect(result.content).toBe("");
      expect(result.noopEdit).toBeDefined();
    }
  });

  it("an identity-target move whose retirement reaches EOF matches the pinned deletion bytes (F1)", () => {
    // WHY: (ticket-02c F1) the target already carries the copied text, so the item's net effect IS
    // WHY: the deletion of the retired line — and the EOF deletion in a file with no trailing
    // WHY: newline is a pinned, byte-asserted contract (`hashline.apply.test.ts`, "EOF deletion
    // WHY: preserves an empty preceding line"): `"b\n\nb"` → `"b\n\n"`. The line-coordinate
    // WHY: rejoin must conform to that convention, never shadow it with `join("\n")`.
    for (const [content, expected] of [
      ["b\n\nb", "b\n\n"],
      ["c\n\nc", "c\n\n"],
    ] as const) {
      const h = contentOnlyHashes(content);
      const move: HEdit = {
        content_lines: [],
        hash_bounds: [{ hash: h[0]! }, { hash: h[0]! }],
        source: { bounds: [{ hash: h[2]! }, { hash: h[2]! }], retire: true },
      } as HEdit;
      const deletion: HEdit = {
        content_lines: [],
        hash_bounds: [{ hash: h[2]! }, { hash: h[2]! }],
      } as HEdit;
      expect(applyEdit(content, deletion, undefined, h).content).toBe(expected);
      expect(applyEdit(content, move, undefined, h).content).toBe(expected);
    }
  });

  it("a copy (no retire) may overlap the target — overlap only matters when retiring", () => {
    const result = applyEdit(FILE, spanRefEdit([3, 4], [4, 5], false), undefined, H);
    expect(result.content).toBe("a\nb\nY\nc\nc\n");
  });
});

describe("applyEdit — span-ref resolution and evidence", () => {
  it("an unresolvable source anchor fails through the existing anchor rejection", () => {
    const edit = spanRefEdit([1, 1], [3, 4], true);
    const withBadSource: HEdit = {
      ...edit,
      source: { bounds: [{ hash: "QQQ" }, { hash: "QQQ" }], retire: true },
    } as HEdit;
    expectErrorCode(() => applyEdit(FILE, withBadSource, undefined, H), "E_UNKNOWN_ANCHOR");
  });

  it("a reversed SOURCE bound pair heals like any other span", () => {
    const edit = spanRefEdit([1, 1], [4, 3], true);
    const result = applyEdit(FILE, edit, undefined, H);
    expect(result.content).toBe("X\nY\nb\nc\n");
    expect(result.warnings?.some((w) => w.includes("W_REVERSED_ANCHORS"))).toBe(true);
  });

  it("a lease-crossed source pair narrates its own W_REVERSED_ANCHORS (source branch executes)", () => {
    // WHY: the pre-heal on `fileHashes` cannot see this reversal — the content occurrences run
    // WHY: from-to ascending — only the LEASE resolutions cross (spec §3.1.1). The source arm must
    // WHY: narrate its own heal: exactly one notice, and the move still applies on the healed span.
    const content = "alpha\nbeta\ngamma";
    const h = contentOnlyHashes(content);
    const lease = (lineId: number, servedLineNumber: number) => ({
      canonHash: "0",
      servedSnapshotHash: "S",
      servedLineNumber,
      retiredAt: null,
      lineId,
    });
    const crossed: LeaseSpanSource = {
      currentSnapshotHash: "S",
      leaseFor: (anchor) =>
        anchor === h[0]
          ? lease(1, 2)
          : anchor === h[1]
            ? lease(2, 1)
            : anchor === h[2]
              ? lease(3, 3)
              : undefined,
      rebasedLineOf: (lineId) =>
        lineId === 1 ? 2 : lineId === 2 ? 1 : lineId === 3 ? 3 : undefined,
    };
    const edit: HEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h[2]! }, { hash: h[2]! }],
      source: { bounds: [{ hash: h[0]! }, { hash: h[1]! }], retire: true },
    } as HEdit;
    const result = applyEdit(content, edit, undefined, h, {
      filePath: "f.txt",
      served: [h[1]!, h[0]!, h[2]!],
      identity: crossed,
    });
    expect(result.content).toBe("alpha\nbeta");
    expect(result.sourceRange).toEqual({
      startLine: 1,
      endLine: 2,
      startHash: h[0]!,
      endHash: h[1]!,
      delta: -2,
    });
    expect((result.warnings ?? []).filter((w) => w.includes("W_REVERSED_ANCHORS"))).toHaveLength(1);
  });

  it("a target already carrying the copied lines suppresses its splice (F5 branch)", () => {
    // WHY: `b` at line 2 and line 3 hash apart (per-line salt), so the move is legal adjacency with
    // WHY: an equal-text target: only the retirement mutates — one mutationSpan, added 0 / removed 1,
    // WHY: and the target range's zero delta is inherent (equal-width replacement), not patched.
    const file2 = "a\nb\nb\nc\n";
    const h2 = contentOnlyHashes(file2);
    const edit: HEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h2[2]! }, { hash: h2[2]! }],
      source: { bounds: [{ hash: h2[1]! }, { hash: h2[1]! }], retire: true },
    } as HEdit;
    const result = applyEdit(file2, edit, undefined, h2);
    expect(result.content).toBe("a\nb\nc\n");
    expect(result.noopEdit).toBeUndefined();
    expect(result.mutationSpans).toEqual([{ startLine: 2, endLine: 2, inserted: 0 }]);
    expect(result.mutationStats).toEqual({ addedLines: 0, removedLines: 1 });
    expect(result.range.delta).toBe(0);
  });

  it("the served hash echo gate runs on copied lines, with a clean control beside it", () => {
    // The mirror below is base's served state; the file's line 3 is itself a reproducing served
    // row (`H3│gamma`). Copying it WRITES that reproducing line, so the evidence gate must refuse;
    // copying line 4 (plain "delta") must apply — both asserted in one test so the refusal cannot
    // come from the copy path being broken in general.
    const base = "alpha\nbeta\ngamma\ndelta";
    const bh = contentOnlyHashes(base);
    const served = [...bh];
    const digests = ["alpha", "beta", "gamma", "delta"].map((line) => canonDigest(line));
    const file2 = `alpha\nbeta\n${bh[2]}${HASH_SEP}gamma\ndelta`;
    const h2 = contentOnlyHashes(file2);
    const verification = { filePath: "f.txt", served, canonDigests: digests };

    const badEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h2[0]! }, { hash: h2[0]! }],
      source: { bounds: [{ hash: h2[2]! }, { hash: h2[2]! }], retire: false },
    } as HEdit;
    expectErrorCode(
      () => applyEdit(file2, badEdit, undefined, h2, verification),
      "E_SUSPICIOUS_TEXT",
    );

    const controlEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h2[0]! }, { hash: h2[0]! }],
      source: { bounds: [{ hash: h2[3]! }, { hash: h2[3]! }], retire: false },
    } as HEdit;
    const control = applyEdit(file2, controlEdit, undefined, h2, verification);
    expect(control.content).toBe(`delta\nbeta\n${bh[2]}${HASH_SEP}gamma\ndelta`);
  });
});

// WHY: (ticket-02c F3) the permanent two-path fence. `applyEdit` ships TWO assembly paths for one
// WHY: logical edit — the hand-written byte splice (`resToSpan`) and the span-ref line-coordinate
// WHY: assembly (`assembleLines`). F1 was exactly one path's serialization shadowing the other's
// WHY: pinned convention. Coverage claim, narrowed per REVIEW-ticket-02c §9 (the blanket promise
// WHY: was overstated — ticket-02c moved bytes on the unlisted empty-file class and this fence
// WHY: stayed green): a future edit that moves either path's bytes ON ONE OF THE LISTED SHAPE
// WHY: CLASSES, in one of the three modes, fails here. The absolute-byte pins for the
// WHY: serialization itself are the F1 test and the direct tuple table, not this fence.
describe("applyEdit — two-path fence (span-ref ≡ hand-written, byte-for-byte)", () => {
  // WHY: shape classes mandated by the ticket: first line, last line, EOF without a trailing
  // WHY: newline, the pinned empty-preceding-line (F1) shapes, CRLF (both endings), multi-line
  // WHY: spans, single-line files both ways, the `"\n"`-only file, trailing blank lines,
  // WHY: duplicate text (position-salted hashes make every pair anchor-resolvable), the
  // WHY: equal-text-target noop shape, and — newly, by ticket-02d — the EMPTY FILE, the one
  // WHY: shape class the clause's proxy predicate misfired on.
  const FENCE_FILES = [
    "",
    "a\nb\nc\n",
    "a\nb\nc",
    "a\n\nb",
    "b\n\nb",
    "c\n\nc",
    "a\r\nb\r\nc\r\n",
    "a\r\nb\r\nc",
    "a\n",
    "a",
    "\n",
    "x\n\n\n",
    "a\na\na\n",
    "a\nb\nb\nc\n",
  ];

  function outcome(run: () => string): string {
    try {
      return `OK:${run()}`;
      // WHY: codes compared, never messages: the envelope is presentation, the refusal is the fact.
    } catch (error) {
      return `ERR:${(error as { code?: string }).code ?? "(no code)"}`;
    }
  }

  function spanRefPair(
    h: string[],
    t1: number,
    t2: number,
    s1: number,
    s2: number,
    retire: boolean,
    placement?: HEdit["placement"],
  ): HEdit {
    return {
      content_lines: [],
      hash_bounds: [{ hash: h[t1 - 1]! }, { hash: h[t2 - 1]! }],
      ...(placement === undefined ? {} : { placement }),
      source: { bounds: [{ hash: h[s1 - 1]! }, { hash: h[s2 - 1]! }], retire },
    } as HEdit;
  }

  function handPair(
    h: string[],
    t1: number,
    t2: number,
    text: string[],
    placement?: HEdit["placement"],
  ): HEdit {
    return {
      content_lines: text,
      hash_bounds: [{ hash: h[t1 - 1]! }, { hash: h[t2 - 1]! }],
      ...(placement === undefined ? {} : { placement }),
    } as HEdit;
  }

  function fenceVerification(
    h: string[],
    lines: string[],
    mode: "general" | "literal" | undefined,
  ) {
    return {
      filePath: "fence.txt",
      served: [...h],
      canonDigests: lines.map((line) => canonDigest(line)),
      ...(mode === undefined ? {} : { mode }),
    };
  }

  it("every span-ref copy equals the hand-written payload carrying the same lines", () => {
    for (const mode of [undefined, "general", "literal"] as const) {
      for (const content of FENCE_FILES) {
        const lines = splitLines(content);
        const h = contentOnlyHashes(content);
        const verification = fenceVerification(h, lines, mode);
        for (let s1 = 1; s1 <= lines.length; s1++) {
          for (let s2 = s1; s2 <= lines.length; s2++) {
            const copied = lines.slice(s1 - 1, s2);
            for (let t1 = 1; t1 <= lines.length; t1++) {
              for (let t2 = t1; t2 <= lines.length; t2++) {
                for (const placement of [undefined, "before", "after"] as const) {
                  const spanRef = outcome(
                    () =>
                      applyEdit(
                        content,
                        spanRefPair(h, t1, t2, s1, s2, false, placement),
                        undefined,
                        h,
                        verification,
                      ).content,
                  );
                  const hand = outcome(
                    () =>
                      applyEdit(
                        content,
                        handPair(h, t1, t2, copied, placement),
                        undefined,
                        h,
                        verification,
                      ).content,
                  );
                  const label = JSON.stringify({ content, mode, s1, s2, t1, t2, placement });
                  expect(hand, label).toBe(spanRef);
                }
              }
            }
          }
        }
      }
    }
  });

  it("every identity-target move equals the hand-written deletion of its retired lines", () => {
    // WHY: the F1 class generalized: when the target already carries the copied lines, the move's
    // WHY: net effect IS the retirement, so its bytes must equal the pinned deletion path's bytes
    // WHY: for the same retired span — at every shape, in every mode.
    for (const mode of [undefined, "general", "literal"] as const) {
      for (const content of FENCE_FILES) {
        const lines = splitLines(content);
        const h = contentOnlyHashes(content);
        const verification = fenceVerification(h, lines, mode);
        for (let s1 = 1; s1 <= lines.length; s1++) {
          for (let s2 = s1; s2 <= lines.length; s2++) {
            for (let t1 = 1; t1 <= lines.length; t1++) {
              const t2 = t1 + (s2 - s1);
              if (t2 > lines.length) continue;
              // WHY: an overlapping move refuses (`E_BAD_PAYLOAD`) and is not equivalent to a
              // WHY: bare deletion of the source; only the disjoint equal-text pairs are.
              if (Math.max(t1, s1) <= Math.min(t2, s2)) continue;
              const moved = lines.slice(t1 - 1, t2);
              const copied = lines.slice(s1 - 1, s2);
              if (!moved.every((line, i) => line === copied[i])) continue;
              const move = outcome(
                () =>
                  applyEdit(
                    content,
                    spanRefPair(h, t1, t2, s1, s2, true),
                    undefined,
                    h,
                    verification,
                  ).content,
              );
              const deletion = outcome(
                () =>
                  applyEdit(content, handPair(h, s1, s2, []), undefined, h, verification).content,
              );
              const label = JSON.stringify({ content, mode, s1, s2, t1, t2 });
              expect(deletion, label).toBe(move);
            }
          }
        }
      }
    }
  });
});

// WHY: (ticket-02d P3, REVIEW-ticket-02c P3) the direct tuple table on the serialization helper —
// WHY: assembly-independent, one tuple per clause, so every mutation of the terminator rule that
// WHY: the review enumerated (M1 pre-fix rejoin, M2 drop `out[last] === ""`, M3 drop
// WHY: `retired.s2 === fileLines.length`, M4 drop the retirement link) turns this table RED. The
// WHY: fence and the sweep each pin only part of the clause set; M3 was caught by nothing before
// WHY: this table existed.
describe("serializeLineList — direct tuple table", () => {
  it("pins every terminator clause with one tuple", () => {
    // clause-2 fires: the pinned empty-preceding-line EOF arm, asserted as absolute bytes.
    expect(serializeLineList("b\n\nb", ["b", "", "b"], { s1: 3, s2: 3 }, ["b", ""])).toBe("b\n\n");
    // clause-2 controls: no surviving empty final line, or no retirement reaching EOF.
    expect(serializeLineList("b\n\nb", ["b", "", "b"], { s1: 3, s2: 3 }, ["b"])).toBe("b");
    expect(serializeLineList("a\nb\nc", ["a", "b", "c"], { s1: 3, s2: 3 }, ["a", "b"])).toBe(
      "a\nb",
    );
    // kills M3: retirement present but NOT reaching EOF (s2=1 != n=3) — no terminator.
    expect(serializeLineList("\n\na", ["", "", "a"], { s1: 1, s2: 1 }, ["", ""])).toBe("\n");
    // kills M1/M4 and pins the ticket-02d P1 guard: the empty body never takes the terminator.
    // WHY: the review's table lists "\n" as the CURRENT (buggy) value of this tuple; this row
    // WHY: asserts the fixed expectation, so it is red before the guard and green after it.
    expect(serializeLineList("", [""], { s1: 1, s2: 1 }, [""])).toBe("");
  });
});
