import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { createSessionHandle } from "../../src/served-session/session";
import { getWritableTempRoot } from "../support/fixtures";
import { shutdownHashStore } from "../../src/hash-store";
import { initHasher } from "../../src/hashline/hasher";

beforeAll(async () => {
  await initHasher();
});

describe("ServedSession — handle deep interface", () => {
  it("hides sessionKey threading: record + load via handle", async () => {
    await withTempHome(async () => {
      const handleA = createSessionHandle("sessA", "/a.ts");
      await handleA.record([{ position: 0, hash: "abc" }, { position: 1, hash: "def" }]);
      expect(await handleA.load()).toEqual(["abc", "def"]);
      const handleB = createSessionHandle("sessB", "/a.ts");
      expect(await handleB.load()).toEqual([]);
    });
  });

  it("recordTruncated heals orphan and respects lineCount", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      await h.record([{ position: 0, hash: "abc" }, { position: 1, hash: "def" }, { position: 2, hash: "ghi" }]);
      await h.recordTruncated([{ position: 0, hash: "xyz" }], 2);
      expect(await h.load()).toEqual(["xyz", "def"]);
    });
  });

  it("recordDiff plans truncation internally (plain vs truncated)", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      await h.recordDiff([{ position: 0, hash: "abc" }], { resultLineCount: 1, firstChangedLine: 1 });
      expect(await h.load()).toEqual(["abc"]);
      await h.recordDiff([{ position: 5, hash: "zzz" }]);
      expect((await h.load())[5]).toBe("zzz");
    });
  });

  it("recordEcho respects preview policy (no-op)", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      await h.recordEcho([{ position: 0, hash: "abc" }], "preview");
      expect(await h.load()).toEqual([]);
      await h.recordEcho([{ position: 0, hash: "abc" }], "live", 1);
      expect(await h.load()).toEqual(["abc"]);
    });
  });

  it("drift reported set is per (session,path) and clearable via handle", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/a.ts");
      await h.markDriftReported(["abc", "def"]);
      expect(await h.driftReported()).toEqual(new Set(["abc", "def"]));
      await h.clearDrift();
      expect(await h.driftReported()).toEqual(new Set());
    });
  });

  it("sessionFromContext binds sessionKey without caller threading", async () => {
    await withTempHome(async () => {
      const { sessionFromContext } = await import("../../src/served-session/session");
      const ctx = { sessionManager: { getSessionId: () => "ctxSess" } };
      const h = sessionFromContext(ctx, "/x.ts");
      expect(h.sessionKey).toBe("ctxSess");
      expect(h.path).toBe("/x.ts");
      await h.record([{ position: 0, hash: "abc" }]);
      expect(await h.load()).toEqual(["abc"]);
    });
  });

  it("orphan healing via duplicate hash nulls old position", async () => {
    await withTempHome(async () => {
      const h = createSessionHandle("sessA", "/p.ts");
      await h.record([{ position: 0, hash: "abc" }, { position: 1, hash: "def" }]);
      await h.record([{ position: 2, hash: "abc" }]);
      expect(await h.load()).toEqual([null, "def", "abc"]);
    });
  });
});

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-session-test-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run();
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}
