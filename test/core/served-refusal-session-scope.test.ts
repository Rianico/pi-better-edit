/**
 * Issue #132: the refusal tally beside the served hash echo gate is session-scoped and
 * bounded.
 *
 * The tally only sharpens the `(submission N×)` clause of `E_SUSPICIOUS_TEXT`
 * (`suspiciousTail` in `src/domain-errors.ts`); it gates nothing. Keying it by
 * absolute path alone let two sessions sharing a path inherit each other's count and
 * let a long-running process retain one entry per refused path forever.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  SERVED_REFUSAL_MAX_ENTRIES,
  _servedRefusalSize,
  clearAllServedRefusalsForTest,
  clearServedRefusals,
  trackServedEditRefusal,
  trackServedWriteRefusal,
} from "../../src/hashline/served-guard.js";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures";

const REFUSED_LINE = "Ab3│hello";
const home = useTestHome();

beforeEach(() => {
  clearAllServedRefusalsForTest();
});

describe("served-refusal tally — session scope (#132)", () => {
  it("does not share a count between two sessions refusing the same path", () => {
    const path = "/tmp/132-share.txt";
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(2);
    // The second session starts at 1: no inherited tally from the first.
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(2);
    // One composite key per (session, path), never one per refusal.
    expect(_servedRefusalSize()).toBe(2);
  });

  it("sharpens within one session and restarts when the refused payload changes", () => {
    const path = "/tmp/132-sharpen.txt";
    const sessionKey = "sess-sharpen";
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(1);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(2);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(3);
    // A different refused payload is a new refusal, not a continuum.
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", "Zz9│hello")).toBe(1);
    expect(_servedRefusalSize()).toBe(1);
  });

  it("clears one path without touching the session's other paths or another session", () => {
    const a = "/tmp/132-clear-a.txt";
    const b = "/tmp/132-clear-b.txt";
    expect(trackServedWriteRefusal("sess-clear", a, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear", b, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear-other", a, REFUSED_LINE)).toBe(1);
    expect(_servedRefusalSize()).toBe(3);
    clearServedRefusals("sess-clear", a);
    // The composite key for exactly that (session, path) is gone.
    expect(_servedRefusalSize()).toBe(2);
    expect(trackServedWriteRefusal("sess-clear", a, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear", b, REFUSED_LINE)).toBe(2);
    expect(trackServedWriteRefusal("sess-clear-other", a, REFUSED_LINE)).toBe(2);
    expect(_servedRefusalSize()).toBe(3);
  });

  it("bounds the tracker globally without draining one session first", () => {
    const sessions = Array.from({ length: 10 }, (_, index) => `sess-multi-${index}`);
    const pathOf = (pathIndex: number) => `/tmp/132-multi-${pathIndex}.txt`;
    // Round-robin insertion: 10 sessions x 30 paths = 300 distinct composite keys, so
    // every session's keys are spread across the whole insertion order.
    for (let pathIndex = 0; pathIndex < 30; pathIndex++) {
      for (const sessionKey of sessions) {
        trackServedWriteRefusal(sessionKey, pathOf(pathIndex), REFUSED_LINE);
      }
      expect(_servedRefusalSize()).toBeLessThanOrEqual(SERVED_REFUSAL_MAX_ENTRIES);
    }
    expect(_servedRefusalSize()).toBe(SERVED_REFUSAL_MAX_ENTRIES);
    // The 44 globally oldest keys are gone: each session's earliest paths restart at 1.
    for (const sessionKey of sessions) {
      expect(trackServedWriteRefusal(sessionKey, pathOf(0), REFUSED_LINE)).toBe(1);
    }
    // No session was drained: every session still holds its newest path and it sharpens.
    for (const sessionKey of sessions) {
      expect(trackServedWriteRefusal(sessionKey, pathOf(29), REFUSED_LINE)).toBe(2);
    }
  });

  it("keeps a resubmitted refusal (LRU on touch) and evicts the head", () => {
    const sessionKey = "sess-lru";
    const touched = "/tmp/132-lru-touched.txt";
    const oldest = "/tmp/132-lru-oldest.txt";
    expect(trackServedWriteRefusal(sessionKey, oldest, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal(sessionKey, touched, REFUSED_LINE)).toBe(1);
    for (let index = 0; index < 200; index++) {
      trackServedWriteRefusal("sess-lru-other", `/tmp/132-lru-${index}.txt`, REFUSED_LINE);
    }
    // A resubmission moves its key to the tail of the LRU order.
    expect(trackServedWriteRefusal(sessionKey, touched, REFUSED_LINE)).toBe(2);
    for (let index = 200; index < 300; index++) {
      trackServedWriteRefusal("sess-lru-other", `/tmp/132-lru-${index}.txt`, REFUSED_LINE);
    }
    expect(_servedRefusalSize()).toBe(SERVED_REFUSAL_MAX_ENTRIES);
    // 46 keys over the cap were evicted, and the resubmitted one is not among them —
    // insertion-order FIFO would have evicted it as the 2nd-oldest key.
    expect(trackServedWriteRefusal(sessionKey, touched, REFUSED_LINE)).toBe(3);
    // The least recently refused key is the head, and the head is what goes.
    expect(trackServedWriteRefusal(sessionKey, oldest, REFUSED_LINE)).toBe(1);
  });
});

describe("served-refusal tally — two sessions, one path, end to end (#132)", () => {
  it("gives each session its own submission tally through the edit tool", async () => {
    await withTempFile("shared.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", home.testPath);
      const sessionA = { ...ctx, sessionManager: { getSessionId: () => "sess-132-a" } };
      const sessionB = { ...ctx, sessionManager: { getSessionId: () => "sess-132-b" } };
      // Each session serves itself the file, so each holds its own served mirror.
      await readTool.execute("r1", { path: "shared.txt" }, undefined, undefined, sessionA);
      await readTool.execute("r2", { path: "shared.txt" }, undefined, undefined, sessionB);
      const payload = {
        file: "shared.txt",
        edits: [
          { anchor_from: hashes[1]!, anchor_to: hashes[1]!, replace_with: `${hashes[1]}│two` },
        ],
      } as any;

      const aFirst = await editTool
        .execute("e1", payload, undefined, undefined, sessionA)
        .catch((error: unknown) => error as Error);
      expect(aFirst.message).toContain("submission 1");
      const aSecond = await editTool
        .execute("e1", payload, undefined, undefined, sessionA)
        .catch((error: unknown) => error as Error);
      expect(aSecond.message).toContain("submission 2");
      expect(aSecond.message).toContain("Identical refusal");

      // A path-keyed counter would report 3× here — the other session's tally.
      const bFirst = await editTool
        .execute("e1", payload, undefined, undefined, sessionB)
        .catch((error: unknown) => error as Error);
      expect(bFirst.message).toContain("submission 1");
      expect(bFirst.message).not.toContain("Identical refusal");
    });
  });
});
