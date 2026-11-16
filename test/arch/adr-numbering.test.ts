import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `adr new` allocates the next number by scanning the worktree it runs in, so two branches opened from
 * the same trunk see the same sequence and each mints the same number — invisible across a diff. That
 * is what happened in #48: two records at 0027, one of them cited by ADR-0028, and a later citation
 * pointed at the wrong one. Uniqueness is mechanical, so it is pinned here rather than trusted.
 */
const ADR_DIR = join("docs", "adr");
const FILE_RE = /^(\d{4})-(.+)\.md$/;
const H1_RE = /^#\s*ADR-(\d{4})\b/;

/**
 * 0013 is the first record that declares its number in the H1; 0001-0010 predate the convention and
 * carry a bare title, so the declaration is required from here on.
 */
const FIRST_DECLARING_NUMBER = 13;

type Adr = { file: string; number: number; declared: number | null };

function readAdrs(): Adr[] {
  return readdirSync(ADR_DIR)
    .filter((file) => FILE_RE.test(file))
    .map((file) => {
      const match = FILE_RE.exec(file);
      const heading = readFileSync(join(ADR_DIR, file), "utf-8")
        .split("\n")
        .find((line) => line.startsWith("# "));
      const declared = heading === undefined ? null : H1_RE.exec(heading);
      return {
        file,
        number: Number(match?.[1]),
        declared: declared === null ? null : Number(declared[1]),
      };
    })
    .sort((a, b) => a.number - b.number);
}

function duplicates(pairs: ReadonlyArray<readonly [number, readonly string[]]>): string[] {
  return pairs
    .filter(([, holders]) => holders.length > 1)
    .map(([number, holders]) => `ADR-${String(number).padStart(4, "0")}: ${holders.join(", ")}`);
}

function groupBy(
  numbers: ReadonlyArray<{ key: number; file: string }>,
): Array<readonly [number, string[]]> {
  const grouped = new Map<number, string[]>();
  for (const { key, file } of numbers) grouped.set(key, [...(grouped.get(key) ?? []), file]);
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
}

describe("ADR numbering", () => {
  it("gives every record a distinct number", () => {
    const numbers = readAdrs().map(({ file, number }) => ({ key: number, file }));
    expect(duplicates(groupBy(numbers))).toEqual([]);
  });

  it("keeps every declared heading number agreeing with its file and unique", () => {
    const declaring = readAdrs().flatMap((adr) =>
      adr.declared === null ? [] : [{ file: adr.file, number: adr.number, declared: adr.declared }],
    );

    const mismatched = declaring
      .filter((adr) => adr.declared !== adr.number)
      .map((adr) => `${adr.file} declares ADR-${adr.declared}`);

    expect(mismatched).toEqual([]);
    expect(
      duplicates(groupBy(declaring.map(({ file, declared }) => ({ key: declared, file })))),
    ).toEqual([]);
  });

  it("requires records from 0013 on to declare their number in the heading", () => {
    const silent = readAdrs()
      .filter((adr) => adr.number >= FIRST_DECLARING_NUMBER && adr.declared === null)
      .map((adr) => adr.file);

    expect(silent).toEqual([]);
  });
});
