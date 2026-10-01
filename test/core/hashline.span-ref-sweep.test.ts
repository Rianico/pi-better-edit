import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit } from "../../src/hashline/apply";
import { splitLines } from "../../src/utils";
import type { HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

// WHY: (ticket-02b test 5) reproduction of the independent review's 408-configuration sweep
// WHY: (REVIEW-ticket-02.md §1a, `probe3`): five file shapes × every (s1, s2, T, at) with
// WHY: insertion placements only, classified by the pinned predicate. The reference is an
// WHY: independent line-list model — keep the untouched lines (dropping the retired span),
// WHY: then re-insert the copied lines at the position between surviving lines — structurally
// WHY: different from the emit-as-iterate assembly under test. Expectations: DISJ OINT equals
// WHY: the reference, ADJACENT equals the input (alias noops), OVERLAP refuses.
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
  if (out.length === 0) return "";
  return out.join("\n") + (content.endsWith("\n") ? "\n" : "");
}

describe("applyEdit — span-ref move sweep (408 configurations, 0 mismatches)", () => {
  it("every configuration lands in its classified expectation", () => {
    const files = ["a\nb\nX\nY\nc", "a\nb\nX\nY\nc\n", "a\nb\nc", "a\nb\nc\n", "x\nY\nZ"];
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
      counts: { disjoint: 150, adjacent: 154, overlap: 104 },
      mismatches: [],
    });
  });
});
