import { describe, expect, it } from "vitest";
import { walkLines } from "../../src/file-content/line-walker.js";
import { loadHashStore } from "../../src/hash-store.js";
import { splitLines } from "../../src/utils.js";
import { _lineHashesPure, defaultHashIdentity } from "../../src/hashline/index.js";
import { snapshotIOFor } from "../../src/snapshot-store";
import {
  getText,
  setupReadTest,
  useTestHome,
  withTempDir,
  withTempFile,
} from "../support/fixtures";

useTestHome();

// WHY: the anchors are the served contract — an edit resolves the file through them — so the walk that
// WHY: now assigns them has to produce the array the whole-content call produces, element for element.
// WHY: This file repeats every ninth line: identical lines canon to one hash, so the assignment has to
// WHY: probe for a free anchor, which is the collision path a rewritten algorithm (or a different line
// WHY: space, which is how this was found — one extra sentinel anchor) silently changes.
const COLLIDING = `${Array.from({ length: 4000 }, (_, index) => `line ${index % 9}`).join("\n")}\n`;
const PATH = "/anchor-identity.ts";

function walkAssigned(content: string, assign: (line: string) => string): string[] {
  const assigned: string[] = [];
  walkLines(content, [], (line) => void assigned.push(assign(line)));
  return assigned;
}

describe("the walk assigns the anchors the whole-content assignment produces", () => {
  it("agrees line for line, in order and in length, on a file that collides", async () => {
    const oracle = _lineHashesPure(COLLIDING);
    // 4000 lines of nine distinct canons: identical canons land on one slot, so an anchor array this
    // long and this distinct can only come out of probing for the next free slot 3991 times.
    expect(new Set(splitLines(COLLIDING)).size).toBe(9);
    expect(new Set(oracle).size).toBe(oracle.length);
    const plan = await defaultHashIdentity.anchorsForWalk(COLLIDING, {
      path: PATH,
      persist: false,
    });
    expect(plan.assign).toBeDefined();
    const assigned = walkAssigned(COLLIDING, plan.assign!);
    expect(assigned).toEqual(oracle);
    expect(assigned).toHaveLength(oracle.length);
  });

  it("agrees when the caller blocks hashes as already used", async () => {
    const blocked = new Set(_lineHashesPure("line 3\nline 4\n"));
    const plan = await defaultHashIdentity.anchorsForWalk(COLLIDING, {
      path: PATH,
      persist: false,
      blockedHashes: blocked,
    });
    expect(walkAssigned(COLLIDING, plan.assign!)).toEqual(_lineHashesPure(COLLIDING, blocked));
  });

  it("hands over the store's anchors and no assignment when the snapshot is already held", async () => {
    await withTempDir("anchor-identity-", async () => {
      const store = await loadHashStore();
      const snapshotIO = snapshotIOFor(store);
      const eager = await defaultHashIdentity.hashesFor(COLLIDING, { path: PATH, snapshotIO });
      const plan = await defaultHashIdentity.anchorsForWalk(COLLIDING, {
        path: PATH,
        persist: false,
        snapshotIO,
      });
      expect(plan.cached).toEqual(eager);
      expect(plan.assign).toBeUndefined();
    });
  });

  it("serves a page whose anchors are the whole-content assignment's, row for row", async () => {
    await withTempFile("collide.ts", COLLIDING, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "collide.ts", offset: 2, limit: 12 },
        undefined,
        undefined,
        ctx,
      );
      const rows = getText(result)
        .split("\n")
        .filter((row) => /^[A-Za-z0-9]{3}│/.test(row));
      expect(rows).toHaveLength(12);
      expect(rows.map((row) => row.slice(0, 3))).toEqual(_lineHashesPure(COLLIDING).slice(1, 13));
    });
  });
});
