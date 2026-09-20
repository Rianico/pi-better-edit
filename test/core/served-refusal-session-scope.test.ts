/**
 * Issue #132: the refusal tally beside the served hash echo gate is session-scoped and
 * bounded.
 * The tally only sharpens the `(submission N×)` clause of `E_SUSPICIOUS_TEXT`
 * (`suspiciousTail` in `src/domain-errors.ts`); it gates nothing. Keying it by
 * absolute path alone let two sessions sharing a path inherit each other's count
 * and let a long-running process retain one entry per refused path forever.
 */
import { describe, expect, it } from "vitest";
import {
  SERVED_REFUSAL_MAX_ENTRIES,
  _servedRefusalEntryCount,
  _servedRefusalHasSession,
  clearServedRefusals,
  trackServedEditRefusal,
  trackServedWriteRefusal,
} from "../../src/hashline/served-guard.js";
import { lineHashes } from "../../src/hashline";
import { setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures";

const REFUSED_LINE = "Ab3│hello";
const home = useTestHome();

describe("served-refusal tally — session scope (#132)", () => {
  it("does not share a count between two sessions refusing the same path", () => {
    const path = "/tmp/132-share.txt";
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(2);
    // The second session starts at 1: no inherited tally from the first.
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(2);
  });

  it("sharpens within one session and restarts when the refused payload changes", () => {
    const path = "/tmp/132-sharpen.txt";
    const sessionKey = "sess-sharpen";
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(1);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(2);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", REFUSED_LINE)).toBe(3);
    // A different refused payload is a new refusal, not a continuum.
    expect(trackServedEditRefusal(sessionKey, path, "Ab3", "Cd4", "Zz9│hello")).toBe(1);
  });

  it("clears one path without touching the session's other paths or another session", () => {
    const a = "/tmp/132-clear-a.txt";
    const b = "/tmp/132-clear-b.txt";
    expect(trackServedWriteRefusal("sess-clear", a, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear", b, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear-other", a, REFUSED_LINE)).toBe(1);
    clearServedRefusals("sess-clear", a);
    expect(trackServedWriteRefusal("sess-clear", a, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear", b, REFUSED_LINE)).toBe(2);
    expect(trackServedWriteRefusal("sess-clear-other", a, REFUSED_LINE)).toBe(2);
  });

  it("releases the session entry when its last path is cleared", () => {
    const path = "/tmp/132-release.txt";
    const sessionKey = "sess-release";
    trackServedWriteRefusal(sessionKey, path, REFUSED_LINE);
    expect(_servedRefusalHasSession(sessionKey)).toBe(true);
    clearServedRefusals(sessionKey, path);
    expect(_servedRefusalHasSession(sessionKey)).toBe(false);
  });

  it("bounds the tracker: past the cap the oldest entry is released, the newest sharpens", () => {
    const sessionKey = "sess-bound";
    const first = "/tmp/132-bound-first.txt";
    expect(trackServedWriteRefusal(sessionKey, first, REFUSED_LINE)).toBe(1);
    for (let index = 0; index < SERVED_REFUSAL_MAX_ENTRIES + 64; index++) {
      trackServedWriteRefusal(sessionKey, `/tmp/132-bound-${index}.txt`, REFUSED_LINE);
    }
    expect(_servedRefusalEntryCount()).toBeLessThanOrEqual(SERVED_REFUSAL_MAX_ENTRIES);
    // The first entry was evicted: its tally restarts at 1.
    expect(trackServedWriteRefusal(sessionKey, first, REFUSED_LINE)).toBe(1);
    // The newest entry survived eviction: it still sharpens.
    const newest = `/tmp/132-bound-${SERVED_REFUSAL_MAX_ENTRIES + 63}.txt`;
    expect(trackServedWriteRefusal(sessionKey, newest, REFUSED_LINE)).toBe(2);
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
