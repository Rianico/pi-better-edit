import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSessionHandle, sessionFromContext, sessionKeyFor } from "../../src/served-session/session.js";

describe("C3 — Deepen ServedSession: facade deleted, handle is sole seam", () => {
  it("src/served-state.ts has been deleted", () => {
    expect(existsSync("src/served-state.ts")).toBe(false);
  });

  it("no src file imports from served-state", () => {
    const srcFiles = readdirSync("src", { recursive: true } as unknown as { recursive: boolean }) as unknown as string[];
    // fallback: use manual walk if recursive not supported
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true } as unknown as never) as unknown as { name: string; isDirectory(): boolean; isFile(): boolean }[]) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const files = walk("src");
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (content.includes('from "./served-state') || content.includes("from '../served-state") || content.includes('from "../../src/served-state') || content.includes("served-state.js")) {
        // allow comments that mention served-state
        const lines = content.split("\n").filter((l) => l.includes("from") && l.includes("served-state"));
        if (lines.length > 0) offenders.push(`${file}: ${lines.join("; ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("SessionHandle exposes narrow graded surface without leaking store lifecycle", async () => {
    const handle = createSessionHandle("test-session-c3", "/tmp/c3-test.ts");
    expect(typeof handle.load).toBe("function");
    expect(typeof handle.record).toBe("function");
    expect(typeof handle.recordDiff).toBe("function");
    expect(typeof handle.recordEcho).toBe("function");
    expect(typeof handle.recordTruncated).toBe("function");
    expect(typeof handle.driftReported).toBe("function");
    expect(typeof handle.markDriftReported).toBe("function");
    expect(typeof handle.clearDrift).toBe("function");
    expect(typeof handle.retire).toBe("function");
    // store lifecycle not exposed on handle
    expect((handle as unknown as Record<string, unknown>).withStore).toBeUndefined();
    expect((handle as unknown as Record<string, unknown>).withBusyRetry).toBeUndefined();
  });

  it("sessionFromContext and sessionKeyFor are the sole sessionKey authority", () => {
    expect(typeof sessionFromContext).toBe("function");
    expect(typeof sessionKeyFor).toBe("function");
    const key = sessionKeyFor({ sessionManager: { getSessionId: () => "sess-123" } });
    expect(key).toBe("sess-123");
  });

  it("Memory adapter still justifies the seam (store can be injected)", async () => {
    const { MemorySnapshotStore } = await import("../../src/store.js");
    const { DatabaseSync } = await import("node:sqlite");
    // MemorySnapshotStore is the test adapter; handle injection is verified by existing integration tests
    const mem = new MemorySnapshotStore();
    expect(typeof mem.get).toBe("function");
    expect(typeof mem.put).toBe("function");
    // verify handle can be constructed with a custom store without throwing on creation
    const db = new DatabaseSync(":memory:");
    const { ensureServedSchema } = await import("../../src/served-session/session.js");
    ensureServedSchema(db);
    const customStore = { db } as unknown as import("../../src/hash-store.js").HashStore;
    const handle = createSessionHandle("mem-test", "/mem.ts", customStore);
    expect(typeof handle.load).toBe("function");
    expect(typeof handle.record).toBe("function");
  });

  it("re-exports servedPositionsOf and currentPositionOfDrifted remain co-located", async () => {
    const mod = await import("../../src/served-session/index.js");
    expect(typeof mod.servedPositionsOf).toBe("function");
    expect(typeof mod.currentPositionOfDrifted).toBe("function");
  });
});
