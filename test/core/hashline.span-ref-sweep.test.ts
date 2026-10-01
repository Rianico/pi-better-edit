import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit, serializeLineList } from "../../src/hashline/apply";
import { splitLines } from "../../src/utils";
import type { HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

// WHY: (ticket-02b test 5, reworked by ticket-02c F4) the sweep over every (s1, s2, T, at) with
// WHY: insertion placements, classified by the pinned predicate. The reference is an independent
// WHY: line-list model — keep the untouched lines (dropping the retired span), then re-insert the
// WHY: copied lines at the position between surviving lines — structurally different from the
// WHY: emit-as-iterate assembly under test. The SERIALIZATION is shared with the implementation
// WHY: (`serializeLineList`, ticket-02c F4): the sweep refutes selection/order bugs, and the
// WHY: pinned EOF-deletion bytes that decide the serialization are asserted in
// WHY: `test/core/hashline.span-ref.test.ts` ("...matches the pinned deletion bytes (F1)") and in
// WHY: `test/core/hashline.apply.test.ts` — forking the rule here instead of sharing it was the
// WHY: blind spot that let F1 through. Expectations: DISJOINT equals the reference, ADJACENT
// WHY: equals the input (alias noops), OVERLAP refuses.
function reference(
  content: string,
  s1: number,
  s2: number,
  t: number,
  at: "before" | "after",
): string {
  const lines = splitLines(content);
  const copy = lines.slice(s1 - 1, s2);
  const kept = lines.map((line, i) => ({ n: i + 1, line })).filter((e) => e.n < s1 || e.n > s2);
  const found = kept.findIndex((e) => (at === "before" ? e.n >= t : e.n > t));
  const pos = found === -1 ? kept.length : found;
  const out = [
    ...kept.slice(0, pos).map((e) => e.line),
    ...copy,
    ...kept.slice(pos).map((e) => e.line),
  ];
  return serializeLineList(content, lines, { s1, s2 }, out);
}

describe("applyEdit — span-ref move sweep (744 configurations, 0 mismatches)", () => {
  it("every configuration lands in its classified expectation", () => {
    // WHY: (ticket-02c F4) the shape classes the original five files could not reach: an empty
    // WHY: line at EOF-1 with no trailing newline (`"b\n\nb"` — the F1 shape), an interior empty
    // WHY: line without a trailing newline, and CRLF. The classification is purely positional
    // WHY: (index arithmetic), so per file the vector is n^2(n+1) = 150 (n=5) or 36 (n=3) split
    // WHY: {disjoint, adjacent, overlap} = {60, 50, 40} / {10, 18, 8}: four n=5 files and four
    // WHY: n=3 files give 280/272/192 over 744 configurations. This re-pinning is deliberate —
    // WHY: the vector grew from 150/154/104 exactly when the file list grew (2×n5 + 3×n3 →
    // WHY: 4×n5 + 4×n3). It is load-bearing: a mis-specified predicate moves the counts while
    // WHY: `mismatches` stays empty (mutation-tested in REVIEW-ticket-02b §3).
    const files = [
      "a\nb\nX\nY\nc",
      "a\nb\nX\nY\nc\n",
      "a\nb\nc",
      "a\nb\nc\n",
      "x\nY\nZ",
      "b\n\nb",
      "a\n\nX\nY\nc",
      "a\r\nb\r\nX\r\nY\r\nc",
    ];
    const counts = { disjoint: 0, adjacent: 0, overlap: 0 };
    const mismatches: string[] = [];
    for (const content of files) {
      const n = splitLines(content).length;
      const H = _lineHashesPure(content);
      for (let s1 = 1; s1 <= n; s1++)
        for (let s2 = s1; s2 <= n; s2++)
          for (let t = 1; t <= n; t++)
            for (const at of ["before", "after"] as const) {
              const overlap = at === "before" ? s1 < t && t <= s2 : s1 <= t && t < s2;
              const adjacent =
                !overlap &&
                ((at === "before" && (t === s1 || t === s2 + 1)) ||
                  (at === "after" && (t === s1 - 1 || t === s2)));
              const edit = {
                content_lines: [],
                hash_bounds: [{ hash: H[t - 1]! }, { hash: H[t - 1]! }],
                placement: at,
                source: {
                  bounds: [{ hash: H[s1 - 1]! }, { hash: H[s2 - 1]! }],
                  retire: true,
                },
              } as HEdit;
              let out: string | undefined;
              let code: string | undefined;
              try {
                out = applyEdit(content, edit).content;
              } catch (error) {
                code = (error as { code?: string }).code;
              }
              const config = `${JSON.stringify(content)} span ${s1}..${s2} ${at} T=${t}`;
              if (overlap) {
                counts.overlap++;
                if (code !== "E_BAD_PAYLOAD" || out !== undefined) {
                  mismatches.push(`OVERLAP ${config}: code=${code} out=${JSON.stringify(out)}`);
                }
              } else if (adjacent) {
                counts.adjacent++;
                if (code !== undefined || out !== content) {
                  mismatches.push(`ADJACENT ${config}: code=${code} out=${JSON.stringify(out)}`);
                }
              } else {
                counts.disjoint++;
                const expected = reference(content, s1, s2, t, at);
                if (code !== undefined || out !== expected) {
                  mismatches.push(
                    `DISJOINT ${config}: code=${code} out=${JSON.stringify(out)} want=${JSON.stringify(expected)}`,
                  );
                }
              }
            }
    }
    expect({ counts, mismatches }).toEqual({
      counts: { disjoint: 280, adjacent: 272, overlap: 192 },
      mismatches: [],
    });
  });
});
