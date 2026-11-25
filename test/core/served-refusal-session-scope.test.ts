/**
 * Issue #132: the refusal tally beside the served hash echo gate is session-scoped and
 * bounded.
 *
 * The tally only sharpens the `(submission N×)` clause of `E_SUSPICIOUS_TEXT`
 * (rendered once in `src/domain-errors.ts`); it gates nothing. Keying it by
 * absolute path alone let two sessions sharing a path inherit each other's count and
 * let a long-running process retain one entry per refused path forever.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  SERVED_REFUSAL_MAX_ENTRIES,
  _servedRefusalSize,
  clearAllServedRefusalsForTest,
  clearServedRefusals,
  trackServedEditRefusal,
  trackServedWriteRefusal,
} from "../../src/served-session/serve-render.js";
import { lineHashes } from "../../src/hashline/hash-identity.js";
import { setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures";

const REFUSED_LINE = "Ab3X│hello";
useTestHome();

beforeEach(() => {
  clearAllServedRefusalsForTest();
});

describe("served-refusal tally — session scope (#132)", () => {
  it("does not share a count between two sessions refusing the same path", () => {
    const path = "/tmp/132-share.txt";
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-a", path, REFUSED_LINE)).toBe(2);
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-share-b", path, REFUSED_LINE)).toBe(2);
    expect(_servedRefusalSize()).toBe(2);
  });

  it("sharpens within one session and restarts when the refused payload changes", () => {
    const path = "/tmp/132-sharpen.txt";
    const sessionKey = "sess-sharpen";
    expect(trackServedEditRefusal(sessionKey, path, "Ab3X", "Cd4X", REFUSED_LINE)).toBe(1);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3X", "Cd4X", REFUSED_LINE)).toBe(2);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3X", "Cd4X", REFUSED_LINE)).toBe(3);
    expect(trackServedEditRefusal(sessionKey, path, "Ab3X", "Cd4X", "Zz9X│hello")).toBe(1);
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
    expect(_servedRefusalSize()).toBe(2);
    expect(trackServedWriteRefusal("sess-clear", a, REFUSED_LINE)).toBe(1);
    expect(trackServedWriteRefusal("sess-clear", b, REFUSED_LINE)).toBe(2);
    expect(trackServedWriteRefusal("sess-clear-other", a, REFUSED_LINE)).toBe(2);
    expect(_servedRefusalSize()).toBe(3);
  });

  it("bounds the tracker globally without draining one session first", () => {
    const sessions = Array.from({ length: 10 }, (_, index) => `sess-multi-${index}`);
    const pathOf = (pathIndex: number) => `/tmp/132-multi-${pathIndex}.txt`;
    for (let pathIndex = 0; pathIndex < 30; pathIndex++) {
      for (const sessionKey of sessions) {
        trackServedWriteRefusal(sessionKey, pathOf(pathIndex), REFUSED_LINE);
      }
      expect(_servedRefusalSize()).toBeLessThanOrEqual(SERVED_REFUSAL_MAX_ENTRIES);
    }
    expect(_servedRefusalSize()).toBe(SERVED_REFUSAL_MAX_ENTRIES);
    for (const sessionKey of sessions) {
      expect(trackServedWriteRefusal(sessionKey, pathOf(0), REFUSED_LINE)).toBe(1);
    }
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
    expect(trackServedWriteRefusal(sessionKey, touched, REFUSED_LINE)).toBe(2);
    for (let index = 200; index < 300; index++) {
      trackServedWriteRefusal("sess-lru-other", `/tmp/132-lru-${index}.txt`, REFUSED_LINE);
    }
    expect(_servedRefusalSize()).toBe(SERVED_REFUSAL_MAX_ENTRIES);
    expect(trackServedWriteRefusal(sessionKey, touched, REFUSED_LINE)).toBe(3);
    expect(trackServedWriteRefusal(sessionKey, oldest, REFUSED_LINE)).toBe(1);
  });

  it("rejects a NUL delimiter in a session key or a path (composite-key safety)", () => {
    expect(() =>
      trackServedWriteRefusal("sess\0injected", "/tmp/132-nul.txt", REFUSED_LINE),
    ).toThrow(TypeError);
    expect(() =>
      trackServedWriteRefusal("sess-nul", "/tmp/132\0injected.txt", REFUSED_LINE),
    ).toThrow(/NUL/);
    expect(() =>
      trackServedEditRefusal("sess\0injected", "/tmp/132-nul.txt", "Ab3X", "Cd4X", REFUSED_LINE),
    ).toThrow(TypeError);
    expect(() => clearServedRefusals("sess-nul", "/tmp/132\0injected.txt")).toThrow(TypeError);
    expect(_servedRefusalSize()).toBe(0);
  });
});

describe("served-refusal tally — two sessions, one path, end to end (#132)", () => {
  it("gives each session its own submission tally through the edit tool", async () => {
    await withTempFile("shared.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", join(cwd, "shared.txt"));
      const sessionA = { ...ctx, sessionManager: { getSessionId: () => "sess-132-a" } };
      const sessionB = { ...ctx, sessionManager: { getSessionId: () => "sess-132-b" } };
      await readTool.execute("r1", { file: "shared.txt" }, undefined, undefined, sessionA);
      await readTool.execute("r2", { file: "shared.txt" }, undefined, undefined, sessionB);
      const payload = {
        file: "shared.txt",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]}│two` }],
      } as any;

      const aFirst = await editTool
        .execute("e1", payload, undefined, undefined, sessionA)
        .catch((error: unknown) => error as Error);
      expect(aFirst.message).toContain("submission 1");
      const aSecond = await editTool
        .execute("e1", payload, undefined, undefined, sessionA)
        .catch((error: unknown) => error as Error);
      expect(aSecond.message).toContain("submission 2");
      expect(aSecond.message).not.toContain("Identical refusal");

      const bFirst = await editTool
        .execute("e1", payload, undefined, undefined, sessionB)
        .catch((error: unknown) => error as Error);
      expect(bFirst.message).toContain("submission 1");
      expect(bFirst.message).not.toContain("Identical refusal");
    });
  });
});
