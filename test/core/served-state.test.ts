import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";

import {
  createSessionHandle,
  wipeSession,
  servedPositionsOf,
  currentPositionOfDrifted,
} from "../../src/served-session/index.js";
import type { ServedEntry } from "../../src/served-session/types.js";
import { shutdownHashStore } from "../../src/hash-store";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

// WHY: test-local shims over the SessionHandle seam (the compat wrappers were deleted from the module).
const loadServed = (sessionKey: string, path: string) =>
  createSessionHandle(sessionKey, path).load();
const recordServed = (sessionKey: string, path: string, rows: ServedEntry[]) =>
  createSessionHandle(sessionKey, path).record(rows);
const driftReported = (sessionKey: string, path: string) =>
  createSessionHandle(sessionKey, path).driftReported();
const markDriftReported = (sessionKey: string, path: string, hashes: string[]) =>
  createSessionHandle(sessionKey, path).markDriftReported(hashes);
const clearDriftReported = (sessionKey: string, path: string) =>
  createSessionHandle(sessionKey, path).clearDrift();
const wipeServedState = (sessionKey: string) => wipeSession(sessionKey);

let tmpHome: string;
beforeAll(async () => {
  await initHasher();
});

describe("served-state — record semantics", () => {
  it("records served rows that load back by path and position", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [
        { position: 0, hash: "abcc" },
        { position: 1, hash: "deff" },
        { position: 2, hash: "ghii" },
      ]);
      expect(await loadServed("sessionA", "/a.ts")).toEqual(["abcc", "deff", "ghii"]);
    });
  });

  it("returns an empty record for a path with no served entries", async () => {
    await withTempHome(async () => {
      expect(await loadServed("sessionA", "/missing.ts")).toEqual([]);
    });
  });

  it("exposes interior gaps as never-served markers", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abcc" },
        { position: 2, hash: "deff" },
      ]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abcc", null, "deff"]);
    });
  });

  it("overwrites a previously served position", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abcc" }]);
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "deff" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["deff"]);
    });
  });

  it("marks a served position as never-served with a null hash", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [
        { position: 0, hash: "abcc" },
        { position: 1, hash: "deff" },
        { position: 2, hash: "ghii" },
      ]);
      await recordServed("sessionA", "/p.ts", [{ position: 1, hash: null }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abcc", null, "ghii"]);
    });
  });

  it("keeps unrelated served records intact when recording another path", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abcc" }]);
      await recordServed("sessionA", "/b.ts", [
        { position: 0, hash: "deff" },
        { position: 1, hash: "ghii" },
      ]);
      expect(await loadServed("sessionA", "/a.ts")).toEqual(["abcc"]);
      expect(await loadServed("sessionA", "/b.ts")).toEqual(["deff", "ghii"]);
    });
  });
});

describe("served-state — session isolation", () => {
  it("keeps one session's rows invisible to another session", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abcc" }]);
      expect(await loadServed("sessionA", "/p.ts")).toEqual(["abcc"]);
      expect(await loadServed("sessionB", "/p.ts")).toEqual([]);
    });
  });

  it("wipes only the targeted session's served state", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/p.ts", [{ position: 0, hash: "abcc" }]);
      await recordServed("sessionB", "/p.ts", [{ position: 0, hash: "deff" }]);
      await wipeServedState("sessionA");
      expect(await loadServed("sessionA", "/p.ts")).toEqual([]);
      expect(await loadServed("sessionB", "/p.ts")).toEqual(["deff"]);
    });
  });

  it("keeps reported drift sets per session", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/p.ts", ["abcc"]);
      await markDriftReported("sessionB", "/p.ts", ["deff"]);
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abcc"]));
      expect(await driftReported("sessionB", "/p.ts")).toEqual(new Set(["deff"]));
    });
  });
});

describe("served-state — reported drift set policy", () => {
  it("marks hashes as reported and clears them on demand", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/p.ts", ["abcc", "deff"]);
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abcc", "deff"]));
      await clearDriftReported("sessionA", "/p.ts");
      expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
    });
  });

  it("keeps reported sets per path", async () => {
    await withTempHome(async () => {
      await markDriftReported("sessionA", "/a.ts", ["abcc"]);
      await markDriftReported("sessionA", "/b.ts", ["deff"]);
      expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set(["abcc"]));
      expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["deff"]));
      await clearDriftReported("sessionA", "/a.ts");
      expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
      expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["deff"]));
    });
  });

  it("returns an empty reported set for a path with no marks", async () => {
    await withTempHome(async () => {
      expect(await driftReported("sessionA", "/missing.ts")).toEqual(new Set());
    });
  });
});

describe("served-state — session wipe", () => {
  it("removes the session's served records and reported sets", async () => {
    await withTempHome(async () => {
      await recordServed("sessionA", "/a.ts", [{ position: 0, hash: "abcc" }]);
      await recordServed("sessionA", "/b.ts", [{ position: 1, hash: "deff" }]);
      await markDriftReported("sessionA", "/a.ts", ["abcc"]);
      await wipeServedState("sessionA");
      expect(await loadServed("sessionA", "/a.ts")).toEqual([]);
      expect(await loadServed("sessionA", "/b.ts")).toEqual([]);
      expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
    });
  });
});

describe("served-state — servedPositionsOf reconstruction", () => {
  it("returns every served position of a hash", () => {
    const served = ["h000", null, "h022", "h000"];
    expect(servedPositionsOf(served, "h000")).toEqual([0, 3]);
    expect(servedPositionsOf(served, "h022")).toEqual([2]);
  });

  it("returns an empty list for a hash never served", () => {
    expect(servedPositionsOf(["h000", "h011"], "h999")).toEqual([]);
  });
});

describe("served-state — currentPositionOfDrifted reconstruction", () => {
  const served = ["h000", "h011", "h022", "h033", "h044"];

  it("maps through the nearest surviving neighbor below", () => {
    const currentPositions = new Map<string, number>([
      ["h000", 0],
      ["h044", 3],
    ]);
    const surviving = new Set(["h000", "h044"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 2, 0)).toBe(1);
  });

  it("maps through the nearest surviving neighbor above when none survive below", () => {
    const currentPositions = new Map<string, number>([["h044", 1]]);
    const surviving = new Set(["h044"]);
    expect(currentPositionOfDrifted(served, currentPositions, surviving, 3, 0)).toBe(0);
  });

  it("falls back to served index plus delta when no neighbor survives", () => {
    expect(currentPositionOfDrifted(served, new Map(), new Set(), 2, 5)).toBe(7);
  });
});

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-served-state-test-"));
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
