/**
 * #90 / #198 — the janitor's lifecycle hooks: what a handler DOES with the pass it runs.
 * A background timer is impossible (the extension API exposes no idle timer and no
 * `deactivate` event), so the janitor hangs on a lifecycle event and a maintenance item must
 * not break the session it runs in — hence the failure path here. #198 adds the second half:
 * a run that DID something must be visible to the operator. `session_start` still has a live
 * console and `session_shutdown` does not, so each surface is asserted separately, and the
 * formatter's `null` writes nothing on BOTH: a warning every session is noise, and a shutdown
 * printing into a torn-down console loses text. The TRIGGER (which outcomes warrant a
 * warning, and its prose) is #197's, asserted in `store-janitor-warning.test.ts`; the
 * tool-call exclusion that makes it safe stays in `store-janitor.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  janitorPass,
  registerJanitorHooks,
  type JanitorEvent,
  type JanitorOutcome,
} from "../../src/store-janitor";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { CANON_VERSION } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";
import { diagnosticsLogPath } from "../../src/diagnostics";
import { JANITOR_WARNING_PREFIX } from "../../src/store-janitor-warning";
import {
  clearDiagnostics,
  getWritableTempRoot,
  readDiagnostics,
  type DiagnosticRecord,
} from "../support/fixtures";

/** The instant every injected clock reads, so no assertion here depends on wall time. */
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  await initHasher();
});

const WHY = "keeps the local undo/history store small and fast";

/**
 * A compaction that did not run, for the two failure-path reasons #199 escalates: `busy` is a
 * routine deferral (info) and `failed` is a degraded store path (warn).
 */
function compactionDeferred(
  reason: "busy" | "failed",
  error?: string,
): JanitorOutcome["compacted"] {
  return {
    ran: false,
    reason,
    freeBytesBefore: 8192,
    reclaimedBytes: 0,
    ...(error === undefined ? {} : { error }),
  };
}

/** The extension root this test owns, published under the env var `stateRoot()` reads. */
async function withStoreDir(prefix: string, body: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await body();
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Foreign-generation snapshots on long paths, so deleting them frees more than the compaction's
 * 1 MiB floor and quarter-file share: the real pass below must take the VACUUM branch, not the
 * `below-threshold` one.
 */
function seedForeignSnapshots(db: DatabaseSync, count: number): void {
  const insert = db.prepare(
    "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
      "VALUES (?, ?, 3, ?, 1, ?)",
  );
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index++) {
      insert.run(`/${"f".repeat(400)}-${index}.ts`, `${CANON_VERSION}:999:${index}`, NOW, 999);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A stand-in for `pi` that records what was subscribed and hands the handlers back. */
function fakePi(): {
  readonly subscriptions: Array<{ event: string; handler: () => Promise<void> }>;
  readonly pi: unknown;
  readonly handlerFor: (event: string) => () => Promise<void>;
} {
  const subscriptions: Array<{ event: string; handler: () => Promise<void> }> = [];
  return {
    subscriptions,
    pi: {
      on(event: string, handler: () => Promise<void>) {
        subscriptions.push({ event, handler });
      },
    },
    handlerFor(event: string) {
      const found = subscriptions.find((entry) => entry.event === event);
      if (found === undefined) throw new Error(`the janitor was not wired to ${event}`);
      return found.handler;
    },
  };
}

/** An ordinary run the caller varies: every family zero, no compaction, a healthy store. */
function run(
  parts: {
    ran?: boolean;
    reason?: "off" | "throttled";
    deleted?: Partial<JanitorOutcome["deleted"]>;
    compacted?: JanitorOutcome["compacted"];
    deepCheckFailed?: boolean;
    rebuilt?: boolean;
  } = {},
): JanitorOutcome {
  return {
    ran: parts.ran ?? true,
    ...(parts.reason === undefined ? {} : { reason: parts.reason }),
    deleted: { snapshots: 0, lineage: 0, leases: 0, expiredLeases: 0, ...parts.deleted },
    compacted: parts.compacted ?? {
      ran: false,
      reason: "skipped",
      freeBytesBefore: 0,
      reclaimedBytes: 0,
    },
    deepCheckFailed: parts.deepCheckFailed ?? false,
    rebuilt: parts.rebuilt ?? false,
  };
}

/** Only the janitor's own records: the sink's `scope` is what separates them from anything else. */
function janitorRecords(): DiagnosticRecord[] {
  return readDiagnostics().filter((record) => record.scope === "store-janitor");
}

/** Silence the console while recording it; `restoreAllMocks` puts the real one back. */
function spyConsole(): {
  readonly info: ReturnType<typeof vi.spyOn>;
  readonly error: ReturnType<typeof vi.spyOn>;
} {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearDiagnostics();
});

describe("the janitor's failure containment", () => {
  it("swallows a failing pass so maintenance never breaks the session", async () => {
    const { pi, subscriptions } = fakePi();
    const run = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    clearDiagnostics();
    registerJanitorHooks(pi as never, { runJanitor: run });
    await expect(subscriptions[0]?.handler()).resolves.toBeUndefined();
    expect(readDiagnostics()).not.toHaveLength(0);
  });
});

describe("the janitor's session_start surface", () => {
  it("prints a routine cleanup on the console and records it in the log", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ deleted: { snapshots: 2 } }),
    });

    await handlerFor("session_start")();

    expect(consoleSpy.info).toHaveBeenCalledWith(
      `${JANITOR_WARNING_PREFIX} Removed 2 snapshots — ${WHY}.`,
    );
    expect(consoleSpy.error).not.toHaveBeenCalled();
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.message).toContain("Removed 2 snapshots");
  });

  it("prints every line of a damaged-store warning and records it at warn level", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ deepCheckFailed: true, rebuilt: true }),
    });

    await handlerFor("session_start")();

    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.error).toHaveBeenCalledTimes(3);
    expect(consoleSpy.error.mock.calls.at(-1)?.[0]).toBe(
      `${JANITOR_WARNING_PREFIX} Details: ${diagnosticsLogPath()}`,
    );
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toContain(`Details: ${diagnosticsLogPath()}`);
  });

  it("escalates a failed compaction to console.error and one warn record", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ compacted: compactionDeferred("failed", "disk I/O error") }),
    });

    await handlerFor("session_start")();

    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.error).toHaveBeenCalledTimes(2);
    expect(consoleSpy.error.mock.calls.at(-1)?.[0]).toBe(
      `${JANITOR_WARNING_PREFIX} Details: ${diagnosticsLogPath()}`,
    );
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toContain("could not be compacted");
    expect(records[0]?.message).toContain("disk I/O error");
  });

  it("prints a busy-store deferral at info level and records it at info", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ compacted: compactionDeferred("busy") }),
    });

    await handlerFor("session_start")();

    expect(consoleSpy.info).toHaveBeenCalledWith(
      `${JANITOR_WARNING_PREFIX} Compaction deferred: the store was busy — ` +
        `it retries at the next maintenance pass.`,
    );
    expect(consoleSpy.error).not.toHaveBeenCalled();
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("info");
  });
});

describe("the janitor's session_shutdown surface", () => {
  it("records a warning in the log only, because the console is torn down at shutdown", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ deepCheckFailed: true, rebuilt: true }),
    });

    await handlerFor("session_shutdown")();

    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toContain("your files were not touched");
  });

  it("records a failed compaction at warn level, with the error its Details line points at", async () => {
    const { pi, handlerFor } = fakePi();
    const consoleSpy = spyConsole();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run({ compacted: compactionDeferred("failed", "disk I/O error") }),
    });

    await handlerFor("session_shutdown")();

    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.message).toContain("your files were not touched");
    expect(records[0]?.message).toContain("disk I/O error");
  });

  it("keeps the console silent across a REAL pass whose VACUUM really runs", async () => {
    await withStoreDir("pi-janitor-real-shutdown-", async () => {
      const db = (await loadHashStore()).db;
      seedForeignSnapshots(db, 6_000);
      const { pi, handlerFor } = fakePi();
      const consoleSpy = spyConsole();
      clearDiagnostics();
      const outcomes: JanitorOutcome[] = [];
      registerJanitorHooks(pi as never, {
        runJanitor: async () => {
          const outcome = await janitorPass({
            db,
            now: NOW,
            settings: { mode: "on", intervalMs: 1, batchSize: 512 },
            cwd: ".",
          });
          outcomes.push(outcome);
          return outcome;
        },
      });

      await handlerFor("session_shutdown")();

      expect(outcomes[0]?.compacted.ran).toBe(true);
      expect(outcomes[0]?.compacted.reclaimedBytes).toBeGreaterThan(0);
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
      const records = janitorRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe("info");
      expect(records[0]?.message).toContain("reclaimed");
    });
  });
});

describe("the janitor's silent case", () => {
  it("writes nothing to either surface when the formatter has nothing to say", async () => {
    const consoleSpy = spyConsole();
    for (const event of ["session_start", "session_shutdown"] as const) {
      const { pi, handlerFor } = fakePi();
      clearDiagnostics();
      registerJanitorHooks(pi as never, {
        runJanitor: async () => run({ ran: false, reason: "throttled" }),
      });

      await handlerFor(event)();

      expect(janitorRecords()).toHaveLength(0);
    }
    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });
});

/**
 * The shutdown hand-off: the pass must run FIRST, because it maintains the handle the detach is
 * about to close, and it must not be able to strand the detach — a failed maintenance run leaves
 * the throttle row unwritten, never an owner attached to a dead session.
 */
describe("the janitor's shutdown hand-off", () => {
  it("runs the pass before detaching, and only on session_shutdown", async () => {
    const order: string[] = [];
    const { pi, handlerFor } = fakePi();
    registerJanitorHooks(pi as never, {
      runJanitor: async (event: JanitorEvent) => {
        order.push(`pass:${event}`);
        return run();
      },
      afterShutdownPass: async () => {
        order.push("detach");
      },
    });

    await handlerFor("session_start")();
    expect(order).toEqual(["pass:session_start"]);

    await handlerFor("session_shutdown")();
    expect(order).toEqual(["pass:session_start", "pass:session_shutdown", "detach"]);
  });

  it("still detaches when the pass rejects", async () => {
    const order: string[] = [];
    const { pi, handlerFor } = fakePi();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async (event: JanitorEvent) => {
        order.push(`pass:${event}`);
        throw new Error("store unavailable");
      },
      afterShutdownPass: async () => {
        order.push("detach");
      },
    });

    await expect(handlerFor("session_shutdown")()).resolves.toBeUndefined();

    expect(order).toEqual(["pass:session_shutdown", "detach"]);
    expect(janitorRecords()).not.toHaveLength(0);
  });

  it("contains a rejecting detach and reports it instead of failing the hook", async () => {
    const { pi, handlerFor } = fakePi();
    clearDiagnostics();
    registerJanitorHooks(pi as never, {
      runJanitor: async () => run(),
      afterShutdownPass: async () => {
        throw new Error("handle still owned");
      },
    });

    await expect(handlerFor("session_shutdown")()).resolves.toBeUndefined();

    const records = janitorRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("error");
    expect(records[0]?.message).toContain("session detach failed");
  });
});
