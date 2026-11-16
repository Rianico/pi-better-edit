import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import {
  busyBackoffMs,
  busyBudgetMs,
  resolveBusyBudget,
  type BusyBudget,
} from "../../src/store-kernel/index.js";
import { HASH_STORE_BUSY_TIMEOUT } from "../../src/store-kernel/index.js";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";
import vitestConfig from "../../vitest.config";

/**
 * The harness ceilings, READ from vitest.config.ts rather than restated, so this file follows the
 * configuration instead of drifting from it. The contention measurements below assert against them:
 * the budget is a fraction of the ceiling, so what reddens a test that measures a real held lock is
 * only a LARGE inflation: 250 -> 500 does it (6797ms measured against a 6666.67ms ceiling), while
 * 250 -> 300, 350, 400 and 450 all pass, and so does the old-shape 1000 x 4 reshape.
 */
const harnessTestTimeoutMs = vitestConfig.test?.testTimeout ?? 0;
const harnessHookTimeoutMs = vitestConfig.test?.hookTimeout ?? 0;
const harnessCeilingMs = Math.min(harnessTestTimeoutMs, harnessHookTimeoutMs) / 3;

/**
 * #87b — the hash store's contention budget. The ticket's premise (a missing `PRAGMA
 * busy_timeout`) is REFUTED: `node:sqlite`'s `timeout` option IS SQLite's busy handler, so the
 * wiring guard measures the `PRAGMA busy_timeout` readback. The live defect is the reframed one —
 * an implicit, oversized, UNIFORM budget, now explicit, bounded and decorrelated.
 *
 * Contention is asserted STRUCTURALLY (at most `maxAttempts`, at least one, the ORIGINAL busy
 * error rethrown, the rival's lock held), with wall-clock readings as diagnostics only. Exact
 * counts come from an injected `BusyBudget.now` — frozen, or jumped past the injected deadline
 * but below the production model, so the documented backstop ends the episode between attempts.
 * Each test opens the store under a temp HOME and opts out of the worker-wide seam (#89).
 */

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-busy-budget-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function sqlitePath(home: string): string {
  return join(home, ".local", "state", "pi-better-edit", "hash-store.sqlite");
}

/**
 * Build the store, drop the cached handle, then take the write lock on a second connection. The
 * rival is opened with `timeout: 0` so it never waits on anything itself: it owns the lock until
 * this process COMMITs it, which is what makes the contention deterministic.
 *
 * (#87c) THE STAMP IS DROPPED, and that is what makes the harness still test what it claims: only a
 * SLOW-path open takes a write lock any more, so an open of a store whose stamp matches would sail
 * past this rival's lock without spending a microsecond of the budget under test (asserted as the
 * discriminator in `test/core/hash-store-open-stamp.test.ts`). Dropping the stamp puts the open back
 * on the path this budget governs — the shape a released pre-stamp store takes on every open.
 */
async function withLockedStore(
  home: string,
  run: (rival: DatabaseSync) => Promise<void>,
): Promise<void> {
  shutdownHashStore();
  const store = await loadHashStore();
  store.db.exec("PRAGMA user_version = 0");
  shutdownHashStore();
  const rival = new DatabaseSync(sqlitePath(home), { timeout: 0 });
  rival.exec("BEGIN IMMEDIATE");
  try {
    await run(rival);
  } finally {
    shutdownHashStore();
    rival.close();
  }
}

describe("hash store busy wiring (#87b)", () => {
  it("configures the SQLite busy handler that PRAGMA busy_timeout reads back", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const row = store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number };

      expect(row.timeout).toBe(250);
      expect(row.timeout).toBe(HASH_STORE_BUSY_TIMEOUT);
      expect(row.timeout).toBeGreaterThan(0);
    });
  });

  it("spends a bounded, explicitly stated budget on a lock no attempt can outwait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        let draws = 0;
        const frozen = 0;
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 4,
          backoffBaseMs: 10,
          backoffCapMs: 20,
          backoffJitterMs: 0,
          now: () => frozen,
          random: () => {
            draws++;
            return 0;
          },
        };
        const cap = busyBudgetMs(budget);
        expect(cap).toBe(150);

        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore(budget);
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        const attempts = draws + 1;
        const model = busyBudgetMs();
        const diagnostics = JSON.stringify({
          attempts,
          elapsed,
          cap,
          model,
          bound: model,
          perAttempt: Math.round(elapsed / attempts),
          rivalStillHolds: rival.isOpen,
        });

        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBe(budget.maxAttempts);
        expect(elapsed, diagnostics).toBeLessThan(model);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  it("ends the episode at the deadline when the clock says the budget is spent", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        let draws = 0;
        const maxAttempts = 4;
        const production = resolveBusyBudget();
        const jump = 1_000;
        const readings = [0, 0, jump];
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts,
          backoffBaseMs: production.backoffBaseMs,
          backoffCapMs: production.backoffCapMs,
          backoffJitterMs: production.backoffJitterMs,
          now: () => readings.shift() ?? jump,
          random: () => {
            draws++;
            return 0;
          },
        };
        const cap = busyBudgetMs(budget);
        expect(cap).toBe(600);

        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore(budget);
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        const attempts = draws + 1;
        const model = busyBudgetMs();
        const diagnostics = JSON.stringify({
          attempts,
          elapsed,
          cap,
          model,
          bound: model,
          perAttempt: Math.round(elapsed / attempts),
          rivalStillHolds: rival.isOpen,
        });

        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBeLessThanOrEqual(maxAttempts);
        expect(attempts, diagnostics).toBe(2);
        expect(draws, diagnostics).toBe(1);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  it("builds the deadline from the full model, backoff sum included", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        let draws = 0;
        const timeoutMs = 25;
        const maxAttempts = 4;
        const jump = 300;
        const readings = [0, 0, jump];
        const budget: BusyBudget = {
          timeoutMs,
          maxAttempts,
          backoffBaseMs: 50,
          backoffCapMs: 200,
          backoffJitterMs: 0,
          now: () => readings.shift() ?? jump,
          random: () => {
            draws++;
            return 0;
          },
        };
        const model = busyBudgetMs(budget);
        expect(model).toBe(450);
        expect(timeoutMs * maxAttempts).toBe(100);
        expect(jump).toBeGreaterThan(timeoutMs * maxAttempts);
        expect(jump).toBeLessThan(model);

        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore(budget);
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        const attempts = draws + 1;
        const diagnostics = JSON.stringify({
          attempts,
          elapsed,
          model,
          perAttemptTerm: timeoutMs * maxAttempts,
          jump,
          production: busyBudgetMs(),
          perAttempt: Math.round(elapsed / attempts),
          rivalStillHolds: rival.isOpen,
        });

        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBe(maxAttempts);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  it("spends the production budget on a held lock, in at most maxAttempts attempts", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        const production = resolveBusyBudget();

        const singleStarted = Date.now();
        let singleError: unknown;
        try {
          await loadHashStore({ maxAttempts: 1, backoffJitterMs: 0 });
        } catch (caught) {
          singleError = caught;
        }
        const singleAttempt = Date.now() - singleStarted;
        expect((singleError as { errcode?: number }).errcode).toBe(5);

        let draws = 0;
        const random = vi.spyOn(Math, "random").mockImplementation(() => {
          draws++;
          return 0.5;
        });
        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore();
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        random.mockRestore();
        const attempts = draws + 1;

        const model = busyBudgetMs();
        const sleepsMax = model - production.timeoutMs * production.maxAttempts;
        const bound =
          production.maxAttempts * singleAttempt +
          sleepsMax +
          production.backoffCapMs +
          production.backoffJitterMs;
        const diagnostics = JSON.stringify({
          attempts,
          elapsed,
          cap: model,
          model,
          bound,
          perAttempt: Math.round(elapsed / attempts),
          singleAttempt,
          harnessCeilingMs,
        });

        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBeLessThanOrEqual(production.maxAttempts);
        expect(elapsed, diagnostics).toBeLessThan(harnessCeilingMs);
        expect(rival.isOpen).toBe(true);
      });
    });
  }, 30_000);

  it("recovers through the retry loop when a rival releases past the internal wait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        const attempts: number[] = [];
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 40,
          backoffBaseMs: 10,
          backoffCapMs: 40,
          backoffJitterMs: 0,
          random: () => {
            attempts.push(attempts.length);
            rival.exec("COMMIT");
            return 0;
          },
        };

        const started = Date.now();
        const store = await loadHashStore(budget);
        const elapsed = Date.now() - started;

        expect(store.db.isOpen).toBe(true);
        const diagnostics = JSON.stringify({
          attempts: attempts.length,
          elapsed,
          cap: busyBudgetMs(budget),
          perAttempt: Math.round(elapsed / attempts.length),
          bound: 1000,
        });
        expect(attempts.length, diagnostics).toBe(1);
        expect(elapsed, diagnostics).toBeLessThan(1000);
      });
    });
  });
});

describe("busyBackoffMs (#87b)", () => {
  const schedule: BusyBudget = {
    backoffBaseMs: 50,
    backoffCapMs: 400,
    backoffJitterMs: 50,
  };
  const draw = (value: number): BusyBudget => ({ ...schedule, random: () => value });

  it("grows exponentially from the base up to the hard cap", () => {
    const waits = [0, 1, 2, 3, 4, 5].map((attempt) => busyBackoffMs(attempt, draw(0)));
    expect(waits).toEqual([50, 100, 200, 400, 400, 400]);
  });

  it("keeps every draw inside [BASE, CAP + JITTER)", () => {
    expect(busyBackoffMs(3, draw(0))).toBe(400);
    expect(busyBackoffMs(3, draw(1))).toBe(450);
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = busyBackoffMs(attempt, draw(0.999));
      expect(wait).toBeGreaterThanOrEqual(50);
      expect(wait).toBeLessThanOrEqual(450);
    }
  });

  it("differs between consecutive attempts for one fixed draw, so lockstep writers spread", () => {
    const waits = [0, 1, 2, 3, 4].map((attempt) => busyBackoffMs(attempt, draw(0.5)));
    expect(waits).toEqual([75, 125, 225, 425, 425]);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    expect(new Set(waits.slice(0, 4)).size).toBe(4);
  });

  it("keeps the production budget inside the harness ceilings", () => {
    expect(busyBudgetMs()).toBe(4_300);
    expect(busyBudgetMs() * 3).toBeLessThan(harnessTestTimeoutMs);
  });

  it("fills the unspecified budget fields from the production constants", () => {
    const overridden = busyBudgetMs({ timeoutMs: 25, maxAttempts: 4 });
    expect(overridden).toBe(600);
    expect(resolveBusyBudget().now).toBe(Date.now);
  });

  it("reads the jitter from ONE channel: the budget's `random`, else Math.random", () => {
    const injected = vi.fn(() => 1);
    const mathRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(busyBackoffMs(0, { ...schedule, random: injected })).toBe(100);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(busyBackoffMs(0, schedule)).toBe(75);
    expect(mathRandom).toHaveBeenCalledTimes(1);
    mathRandom.mockRestore();
  });
});
