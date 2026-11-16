/**
 * Exhaustive sweep over every (s1, s2, T, at) placement, classified by the pinned predicate, with an
 * independent line-list reference as the oracle: keep the untouched lines, drop the retired span,
 * re-insert the copied lines between the survivors. Expectations: DISJOINT equals the reference,
 * ADJACENT equals the input (alias noops), OVERLAP refuses.
 *
 * Serialization is shared with the implementation (`serializeLineList`), so the pinned EOF-deletion
 * bytes that decide it are asserted in `test/core/hashline.span-ref.test.ts` and
 * `test/core/hashline.apply.test.ts` rather than forked here. The vector is n²(n+1) per file — 150 at
 * n=5, 36 at n=3 — so eight files give 280/272/192 disjoint/adjacent/overlap over 744 configurations,
 * up from 150/154/104 when the list grew from 2×n5 + 3×n3 to 4×n5 + 4×n3.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { contentOnlyHashes } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit, serializeLineList } from "../../src/hashline/apply";
import { splitLines } from "../../src/utils";
import type { HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

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
      const H = contentOnlyHashes(content);
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
                out = applyEdit(content, edit, undefined, H).content;
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
