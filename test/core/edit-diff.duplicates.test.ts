/**
 * Regression corpus for duplicate-line anchor pairing in `genDiff` (issue #326).
 *
 * `Diff.diffLines` pairs byte-identical text lines by position; to it, two equal lines are
 * interchangeable. Production anchors are NOT interchangeable: `mapStableHashes` reuses each
 * surviving line's pre-edit anchor, so the same text at a different position carries a different
 * identity, and the removed line's anchor is retired. These fixtures derive both hash arrays the way
 * the mutation pipeline does (`pipeline.ts`: `hashesForSync` for the pre-edit side, `hashesFor` with
 * `prior` + `removedHashes` for the post-edit side) and assert every rendered row names the true line
 * identity at its position.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { genDiff } from "../../src/edit-diff.js";
import { readNormFile } from "../../src/file-reader.js";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store.js";
import {
  ANCHOR_LEN,
  HASH_SEP,
  defaultHashIdentity,
  initHasher,
} from "../../src/hashline/hash-identity.js";
import { apply } from "../../src/mutation-engine/pipeline.js";
import { assertReq, normReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { createSessionHandle } from "../../src/served-session/index.js";
import { snapshotHashFor } from "../../src/snapshot-store";
import { getWritableTempRoot } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

const PATH = "/abs/test/edit-diff.duplicates.ts";
const CONTEXT = 2;

const splitLines = (content: string): string[] => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

interface Case {
  readonly oldContent: string;
  readonly newContent: string;
  /** Pre-edit line indexes (0-based) whose anchors the edit retires. */
  readonly removedIndexes: readonly number[];
}

interface HashPair {
  readonly oldHashes: string[];
  readonly newHashes: string[];
}

/** Derive anchors exactly as the mutation pipeline does: survivor reuse against the retired set. */
async function pairHashes(fixture: Case): Promise<HashPair> {
  const oldHashes = defaultHashIdentity.hashesForSync(fixture.oldContent, PATH);
  const removedHashes = new Set(fixture.removedIndexes.map((index) => oldHashes[index]!));
  const newHashes = await defaultHashIdentity.hashesFor(fixture.newContent, {
    path: PATH,
    prior: { content: fixture.oldContent, hashes: oldHashes, removedHashes },
    persist: false,
  });
  return { oldHashes, newHashes };
}

interface Row {
  readonly prefix: " " | "-" | "+";
  readonly anchor: string;
  readonly text: string;
}

const UNTOUCHED_MARKER = /^ \.\.\. \[\d+ lines untouched\] \.\.\.$/;
const DELETED_MARKER = /^ - \.\.\. \[\d+ lines deleted\] \.\.\.$/;

/** Parse rendered rows as prefix + 4-char anchor + `│` + text. Markers carry no identity. */
function parseRows(diff: string): Row[] {
  return diff
    .split("\n")
    .filter((line) => line !== " ..." && !UNTOUCHED_MARKER.test(line) && !DELETED_MARKER.test(line))
    .map((line) => ({
      prefix: line[0] as Row["prefix"],
      anchor: line.slice(1, 1 + ANCHOR_LEN),
      text: line.slice(1 + ANCHOR_LEN + HASH_SEP.length),
    }));
}

const renderRows = (diff: string): string[] => diff.split("\n");

function removedAnchorsOf(diff: string): string[] {
  return parseRows(diff)
    .filter((row) => row.prefix === "-")
    .map((row) => row.anchor);
}

/** A line identity belongs to exactly one side of the projection: never both removed and kept. */
function expectNoAnchorSpansBothSides(diff: string, label: string): void {
  const rows = parseRows(diff);
  const kept = new Set(rows.filter((row) => row.prefix !== "-").map((row) => row.anchor));
  for (const row of rows) {
    if (row.prefix !== "-") continue;
    expect(
      kept.has(row.anchor),
      `${label}: anchor ${row.anchor} is rendered both as a kept row and as a removed row`,
    ).toBe(false);
  }
}

/** Every removed row names a line identity that no longer exists in the post-edit content. */
function expectRemovedAnchorsRetired(
  diff: string,
  newHashes: readonly string[],
  label: string,
): void {
  for (const anchor of removedAnchorsOf(diff)) {
    expect(
      newHashes,
      `${label}: removed anchor ${anchor} still names a post-edit line`,
    ).not.toContain(anchor);
  }
}
/**
 * Fixture (e) supplies synthetic, disjoint hashes: it models a caller whose two hash arrays carry no
 * identity relation, so the renderer must not guess which old line a new line continues. Its one
 * deleted trailing line exists only so the fold renders the leading context; the invariant under test
 * is that zero matched identities leave the Myers pairing — and its NEW anchors — untouched, never a
 * `-/-/+/+` rebuild.
 */

describe("duplicate-line anchor pairing (#326)", () => {
  it("(a) replacing the first of two identical lines retires its anchor and keeps the survivor's", async () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\nchanged\ndup\nfooter\n",
      removedIndexes: [1],
    };
    const { oldHashes, newHashes } = await pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, fresh, n2, n3] = newHashes as [string, string, string, string];

    expect(a, "(a): duplicate anchors must differ for the pairing to be observable").not.toBe(b);
    expect([n0, n2, n3], "(a): survivors keep their pre-edit anchors").toEqual([h0, b, h3]);
    expect([a, b, h0, h3], "(a): the replaced line's anchor is retired").not.toContain(fresh);

    const { diff } = genDiff(
      fixture.oldContent,
      fixture.newContent,
      CONTEXT,
      newHashes,
      oldHashes,
      PATH,
    );

    expect(renderRows(diff), `(a) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      `-${a}│dup`,
      `+${fresh}│changed`,
      ` ${b}│dup`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(a)");
    expectRemovedAnchorsRetired(diff, newHashes, "(a)");
    expect(removedAnchorsOf(diff), "(a): the removed row names the replaced line").toEqual([a]);
  });

  it("(b) replacing the second of two identical lines retires its anchor and keeps the survivor's", async () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\ndup\nchanged\nfooter\n",
      removedIndexes: [2],
    };
    const { oldHashes, newHashes } = await pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, n1, fresh, n3] = newHashes as [string, string, string, string];

    expect(n1, "(b): the surviving first duplicate keeps its anchor").toBe(a);
    expect([n0, n3], "(b): untouched lines keep their anchors").toEqual([h0, h3]);

    const { diff } = genDiff(
      fixture.oldContent,
      fixture.newContent,
      CONTEXT,
      newHashes,
      oldHashes,
      PATH,
    );

    expect(renderRows(diff), `(b) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      ` ${a}│dup`,
      `-${b}│dup`,
      `+${fresh}│changed`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(b)");
    expectRemovedAnchorsRetired(diff, newHashes, "(b)");
    expect(removedAnchorsOf(diff), "(b): the removed row names the replaced line").toEqual([b]);
  });

  it("(b2) mirror of (a): the edit retires the FIRST duplicate while the survivor stays earlier in the file", async () => {
    const fixture: Case = {
      oldContent: "header\ndup\ndup\nfooter\n",
      newContent: "header\ndup\nchanged\nfooter\n",
      removedIndexes: [1],
    };
    const { oldHashes, newHashes } = await pairHashes(fixture);
    const [h0, a, b, h3] = oldHashes as [string, string, string, string];
    const [n0, n1, fresh, n3] = newHashes as [string, string, string, string];

    expect(n1, "(b2): the surviving second duplicate keeps its anchor").toBe(b);
    expect([n0, n3], "(b2): untouched lines keep their anchors").toEqual([h0, h3]);

    const { diff } = genDiff(
      fixture.oldContent,
      fixture.newContent,
      CONTEXT,
      newHashes,
      oldHashes,
      PATH,
    );

    expect(renderRows(diff), `(b2) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│header`,
      `-${a}│dup`,
      ` ${b}│dup`,
      `+${fresh}│changed`,
      ` ${h3}│footer`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(b2)");
    expectRemovedAnchorsRetired(diff, newHashes, "(b2)");
    expect(removedAnchorsOf(diff), "(b2): the removed row names the retired duplicate").toEqual([
      a,
    ]);
  });

  it("(c) deleting a range that holds one of two identical blank lines keeps the survivor's anchor", async () => {
    const fixture: Case = {
      oldContent: "alpha\nbeta\n\ncharlie\ndelta\n\necho\n",
      newContent: "alpha\n\necho\n",
      removedIndexes: [1, 2, 3, 4],
    };
    const { oldHashes, newHashes } = await pairHashes(fixture);
    const [h0, h1, h2, h3, h4, h5, h6] = oldHashes as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const [n0, n1, n2] = newHashes as [string, string, string];

    expect(h2, "(c): the two blank lines must carry distinct anchors").not.toBe(h5);
    expect([n0, n1, n2], "(c): the surviving blank keeps its own anchor").toEqual([h0, h5, h6]);

    const { diff } = genDiff(
      fixture.oldContent,
      fixture.newContent,
      CONTEXT,
      newHashes,
      oldHashes,
      PATH,
    );

    expect(renderRows(diff), `(c) rendered rows:\n${diff}`).toEqual([
      ` ${h0}│alpha`,
      `-${h1}│beta`,
      `-${h2}│`,
      `-${h3}│charlie`,
      `-${h4}│delta`,
      ` ${h5}│`,
      ` ${h6}│echo`,
    ]);
    expectNoAnchorSpansBothSides(diff, "(c)");
    expectRemovedAnchorsRetired(diff, newHashes, "(c)");
    expect(removedAnchorsOf(diff), "(c): removed rows stay in pre-edit order").toEqual([
      h1,
      h2,
      h3,
      h4,
    ]);
  });

  it("(e) keeps the Myers pairing when the two sides share no line identity", () => {
    const oldHashes = ["aa11", "bb22", "ee55"];
    const newHashes = ["cc33", "dd44"];

    const { diff, servedRows } = genDiff(
      "a\nb\nx\n",
      "a\nb\n",
      CONTEXT,
      newHashes,
      oldHashes,
      PATH,
    );

    expect(renderRows(diff), `(e) rendered rows:\n${diff}`).toEqual([
      ` ${newHashes[0]}│a`,
      ` ${newHashes[1]}│b`,
      `-${oldHashes[2]}│x`,
    ]);
    expect(servedRows).toEqual([
      { position: 0, hash: newHashes[0] },
      { position: 1, hash: newHashes[1] },
    ]);
  });

  describe("(d) chained edit through the mutation pipeline", () => {
    const SESSION = "s-edit-diff-duplicates";

    async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
      const home = await mkdtemp(join(await getWritableTempRoot(), "edit-diff-duplicates-test-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", "");
      try {
        await run(home);
      } finally {
        shutdownHashStore();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
      }
    }

    function req(input: unknown): NormalizedEditRequest {
      const normalized = normReq(input);
      assertReq(normalized);
      return normalized;
    }

    it("serves true post-edit anchors that resolve a real follow-up edit", async () => {
      await withTempHome(async (home) => {
        const store = await loadHashStore();
        const fileName = "duplicates.txt";
        const oldContent = "header\ndup\ndup\nfooter\n";
        await writeFile(join(home, fileName), oldContent, "utf-8");
        const seed = await readNormFile(fileName, home, { store });
        const oldHashes = seed.fileHashes;
        expect(oldHashes, "(d): the fixture has four lines").toHaveLength(4);
        expect(oldHashes[1], "(d): the two duplicate anchors must differ").not.toBe(oldHashes[2]);

        const handle = createSessionHandle(SESSION, seed.absolutePath, store);
        await handle.recordEpoch({
          rows: oldHashes.map((hash, position) => ({ position, hash })),
          lineCount: oldHashes.length,
          fullReadHashes: oldHashes,
          isFullRead: true,
          contentHash: snapshotHashFor(oldContent),
        });

        const first = await apply(
          req({
            file: fileName,
            edits: [{ anchor_from: oldHashes[1]!, anchor_to: oldHashes[1]!, text: "changed" }],
          }),
          home,
          { store, sessionKey: SESSION },
        );
        expect(first.raw.appliedCount).toBe(1);
        const newContent = first.raw.result;
        const newHashes = first.raw.resultHashes;
        expect(splitLines(newContent)).toEqual(["header", "changed", "dup", "footer"]);

        const projection = genDiff(
          first.raw.originalNormalized,
          newContent,
          CONTEXT,
          newHashes,
          oldHashes,
          seed.absolutePath,
        );

        expect(projection.servedRows, `(d) rendered rows:\n${projection.diff}`).toEqual(
          newHashes.map((hash, position) => ({ position, hash })),
        );

        expect(removedAnchorsOf(projection.diff)).toEqual([oldHashes[1]]);
        for (const anchor of removedAnchorsOf(projection.diff)) {
          expect(newHashes).not.toContain(anchor);
        }

        const reread = await readNormFile(fileName, home, { store });
        expect(
          reread.fileHashes,
          "(d): the persisted snapshot agrees with the diff's anchors",
        ).toEqual(newHashes);
        const servedDup = projection.servedRows.find((row) => row.position === 2);
        expect(servedDup?.hash).toBe(newHashes[2]);

        const second = await apply(
          req({
            file: fileName,
            edits: [{ anchor_from: servedDup!.hash, anchor_to: servedDup!.hash, text: "DUP" }],
          }),
          home,
          { store, sessionKey: SESSION },
        );
        expect(second.raw.appliedCount).toBe(1);
        expect(await readFile(seed.absolutePath, "utf-8")).toBe("header\nchanged\nDUP\nfooter\n");
      });
    });
  });
});
