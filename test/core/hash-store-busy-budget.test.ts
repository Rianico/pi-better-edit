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
 * #87b — the hash store's contention budget.
 *
 * The ticket's original premise (a missing `PRAGMA busy_timeout`) is REFUTED and the first test
 * below is the reason: `node:sqlite`'s `timeout` constructor option *is* SQLite's busy handler, so
 * the wiring guard measures the `PRAGMA busy_timeout` readback rather than grepping for a pragma
 * spelling. What is held here is the reframed defect — an implicit, oversized, UNIFORM budget (a 1s
 * blocked silence per attempt, four attempts, one fixed delay, so every writer woke at the same
 * instants) — now explicit, bounded and decorrelated.
 *
 * The production contention test below spends the PRODUCTION budget with NOTHING injected — the shape
 * every production call site has — and derives its bound from `resolveBusyBudget()`. That bound moves
 * with the constants it would have to indict, so the test does NOT redden for every constants
 * regression: measured GREEN at +20%..+80% on the timeout and at the same-model 1000 x 4 reshape, red
 * at 250 -> 500 (+100%) and at BUSY_MAX_ATTEMPTS 8 -> 100 (a test-level timeout, not an assertion) —
 * while a modest increase surfaces only in the wiring literal and the arithmetic pin below.
 *
 * The contention tests below assert STRUCTURE — at most `maxAttempts` attempts, at least one, the
 * ORIGINAL busy error rethrown, the rival's lock still held — and carry every wall-clock reading as a
 * diagnostic in the assertion MESSAGE. Where an exact count IS asserted, the clock is injected through
 * the optional `BusyBudget.now`: FROZEN, so the deadline cannot fire and the count terminates alone
 * (the nominal branch), or jumped PAST the INJECTED deadline but BELOW the production model, so the
 * documented backstop ends the episode between attempts (the early-exit branch). Neither branch depends
 * on host load, and each is refutable by a one-token mutation of the loop: attempt once and the exact
 * count reddens; drop the deadline check and the reduced count reddens; build the deadline from the
 * production model (`busyBudgetMs()` where the loop passes `busyBudgetMs(budget)`) and the jump stops
 * firing, so the episode spends the count and the early-exit count reddens. The third scripted clock
 * settles INSIDE the injected model's reach but past the per-attempt term alone, so a deadline built
 * as `timeoutMs * maxAttempts` reddens its count — the discrimination the two above leave out.
 *
 * These tests need a REAL second connection holding a real RESERVED lock, so they open the store
 * under a temp HOME (the shape `test/core/hash-store.test.ts` uses) and opt out of the worker-wide
 * seam with an empty `PI_BETTER_EDIT_CONFIG_DIR` (#89) so each call resolves its own fresh store.
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
  return join(home, ".config", "pi-better-edit", "hash-store.sqlite");
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

      // MEASURED readback (node v26.8.1, #87b): the constructor option IS the busy handler, so the
      // pragma reports it back — `{ timeout: 250 }` reads 250, and NO option at all reads 0. This
      // is the observed number, not a recomputation, and it pins the constant to the measurement.
      expect(row.timeout).toBe(250);
      // The wiring guard proper: drop the `timeout` option from openDb and this reads 0, which is
      // both != the constant and not > 0, so losing the handler cannot pass silently.
      expect(row.timeout).toBe(HASH_STORE_BUSY_TIMEOUT);
      expect(row.timeout).toBeGreaterThan(0);
    });
  });

  it("spends a bounded, explicitly stated budget on a lock no attempt can outwait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        // The draw is counted, not declared: with a budgeted draw the loop sleeps once per retry, so
        // the draw count IS the retry count (attempts = draws + 1 — the last failure throws, no draw).
        let draws = 0;
        // WHY the clock is frozen — the NOMINAL branch: an EXACT attempt count is an invariant only
        // when the COUNT is the terminator, and with a real clock it is not. The deadline is a
        // wall-clock backstop with no structural headroom (the model charges each attempt its 25ms
        // internal wait; each attempt really costs ~40-50ms here), so a loaded host ends the episode a
        // retry early. A clock that never advances puts the deadline out of reach by construction, so
        // every attempt the budget grants is spent and the exact count becomes true again.
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
        expect(cap).toBe(150); // 4 x 25 + (10 + 20 + 20)

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
        // DIAGNOSTICS, never assertions: elapsed / cap / model / bound / per-attempt cost / total ride
        // the assertion MESSAGE, so a failure under load reports the numbers without any of them
        // becoming a guarantee the loop does not make.
        const diagnostics = JSON.stringify({
          attempts,
          elapsed,
          cap,
          model,
          bound: model,
          perAttempt: Math.round(elapsed / attempts),
          rivalStillHolds: rival.isOpen,
        });

        // The ORIGINAL busy error object, still the shape every classifier matches (errcode 5/6 or
        // /busy|locked/) — exhaustion changes the wait, not the error.
        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // STRUCTURE: at least one attempt, and never more than the budget granted. With the deadline
        // unreachable the COUNT terminates, so the exact count is a true invariant — and a load-bearing
        // one: collapse the loop to a single attempt and this reads 1 against 4.
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBe(budget.maxAttempts);
        // The DISCRIMINATOR that the INJECTED budget was the one spent: the bound is the PRODUCTION
        // model (4300ms), not this budget's own 150ms `cap`, because an episode that ignored the
        // injection spends the production 4595-4811ms and fails here. The former `elapsed < cap + 600`
        // was deleted rather than re-tightened: at 750ms it discriminated neither shape — the old
        // 4 x 1000 shape passes it too (4850 < 4900). Headroom measured under load: worst 308ms at load
        // average 72-91 (6 runs, 24 CPU hogs on 10 cores; 194-205ms idle) against this 4300ms bound — 14x.
        expect(elapsed, diagnostics).toBeLessThan(model);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  /**
   * The documented BACKSTOP, exercised deterministically — the EARLY-EXIT branch. The deadline is
   * checked after each failed attempt, so a clock that jumps past it must end the episode between
   * attempts: fewer attempts than `maxAttempts`, the ORIGINAL busy error still thrown, the rival's lock
   * still held. This is the branch a loaded host reached by accident (a 150ms model against attempts
   * that really cost ~40-50ms each) and the former exact-count assertion called a failure; with a
   * scripted clock the reduced count is an invariant, not a race.
   *
   * WHY the jump is 1000ms, and why the injected budget keeps the PRODUCTION backoff schedule: this
   * test's discrimination is a property of two MODELS, not of the wall clock. The injected budget differs
   * from the production one in exactly the two fields that bound the episode — the 25ms timeout and the
   * 4 attempts — so it models 4 x 25 + (100 + 150 + 250) = 600ms, while every NON-EQUIVALENT override of
   * the `busyBudgetMs` argument lands at or above the production timeout term: dropping the injected
   * timeout models 250 x 4 + the same 500ms of sleeps = 1500ms, dropping the attempt count 2500ms and
   * dropping the argument 4300ms, with nothing resolvable between this budget's 600ms and 1500ms. 1000ms
   * sits inside that gap — 1.67x above the model the loop must have spent and 1.5x under the smallest
   * model it must not have — so an episode that spent the production constants never fires at the jump
   * and runs on to the count the assertion below pins.
   */
  it("ends the episode at the deadline when the clock says the budget is spent", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        let draws = 0;
        const maxAttempts = 4;
        const production = resolveBusyBudget();
        // The JUMP is this test's discriminator, and the only value that can be one lies between the two
        // models this budget can resolve to (doc comment above): past the INJECTED 600ms model, so the
        // injected deadline fires on reading 3, and short of the 1500ms the smallest non-equivalent
        // override of the `busyBudgetMs` argument carries, so a deadline that ignored the injection
        // cannot reach it. The PRODUCTION backoff fields below are what make that window wide: injected
        // backoff constants would put the injected model at 150ms and leave 160-600ms overrides inside
        // the same window, below any jump that still reads as "past the deadline". Under `busyBudgetMs()`
        // the deadline is 4300ms, this jump does not fire, and the episode spends the COUNT instead —
        // which is what reddens the exact count below. The former `Number.MAX_SAFE_INTEGER` was
        // distinguishable by NO deadline (it ended the episode under the mutant too, which is exactly how
        // that mutant survived a six-mutation sweep).
        const jump = 1_000;
        // Reading 1 sets the deadline (0 + cap), reading 2 still reports the same instant so the loop
        // retries once, reading 3 is past the INJECTED deadline and ends the episode. The fallback
        // repeats the jump, so a deadline that fails to fire terminates on the count, never on a hang.
        const readings = [0, 0, jump];
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts,
          // The PRODUCTION schedule deliberately — the injected budget must differ from the production
          // one in the two fields that bound the episode (and not in the backoff constants, or an
          // override of the `busyBudgetMs` argument could resolve between the two models).
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
        expect(cap).toBe(600); // 4 x 25 + (100 + 150 + 250): the production backoff at max jitter

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

        // The ORIGINAL busy error survives the backstop: the deadline changes when the loop stops, not
        // which error it reports.
        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // STRUCTURE: one attempt at minimum, the reduced count exactly, and the count is the clock's
        // doing — the third reading threw between the first and second retry, so one draw happened and
        // the remaining attempts were never spent.
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBeLessThanOrEqual(maxAttempts);
        expect(attempts, diagnostics).toBe(2);
        expect(draws, diagnostics).toBe(1);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  /**
   * The deadline's MAGNITUDE, not just its positivity: the model's backoff sum is part of it. The
   * early-exit test above jumps past BOTH that model and the bare per-attempt term, and the frozen
   * clock never reaches any deadline, so neither separates `busyBudgetMs` from `timeoutMs *
   * maxAttempts` — a deadline built as the latter passed this whole file. This clock settles inside
   * the window those two expressions open, where only the full model is out of reach, so the count
   * stays the only terminator and the deadline's size is what the assertion reads.
   *
   * The injected budget makes the two expressions differ by construction — 4 x 25ms = 100ms of
   * internal waiting against a 450ms model (the three backoffs `maxAttempts - 1` grants: 50 + 100 +
   * 200) — so the jump, 300ms, is 3x above the per-attempt term and 0.67x of the model. A deadline of
   * `timeoutMs * maxAttempts` throws on the third reading (a count of 2, because 300 >= 100); the full
   * model leaves the loop to its own count, which is what is asserted below.
   */
  it("builds the deadline from the full model, backoff sum included", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        let draws = 0;
        const timeoutMs = 25;
        const maxAttempts = 4;
        // Reading 1 sets the deadline and readings 2-4 answer the check after each failed attempt:
        // 0 keeps the first retry inside either deadline, 300 is past the per-attempt term (so a
        // backoff-blind deadline ends the episode there) and short of the model (so the correct
        // deadline does not). The fallback repeats the jump, so a deadline that fails to fire
        // terminates on the count, never on a hang.
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
        expect(model).toBe(450); // 4 x 25 + (50 + 100 + 200): the injected schedule at max jitter
        expect(timeoutMs * maxAttempts).toBe(100); // the deadline a backoff-blind model would build
        // REQUIRED for the discrimination: the jump is only a discriminator if the two deadline
        // expressions DIFFER and it lies between them.
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

        // The ORIGINAL busy error survives the deadline: it changes when the loop stops, not what it
        // reports.
        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // The COUNT terminates the episode here — the clock never reaches the model — so the exact
        // count is an invariant, and it is the one reading that separates the deadline's two terms:
        // dropping the backoff sum throws on the third reading and reads 2 against this 4.
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBe(maxAttempts);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  /**
   * The production budget, NOTHING injected — the shape every production call site uses — which is what
   * makes this test refutable by the constants: a budget injected here would override every constant it
   * is meant to guard, so no injected contention test can redden for a constants regression.
   *
   * WHAT IS ASSERTED IS STRUCTURE, not an exact count: at most `maxAttempts` attempts, at least one, the
   * ORIGINAL busy error rethrown, the rival's lock still held. The former `attempts === maxAttempts` was
   * a FALSE invariant — the deadline is a wall-clock backstop checked AFTER each failed attempt, so a
   * host loaded far enough ends the episode a retry early. That is the branch the frozen-clock and
   * scripted-clock tests above cover deterministically.
   *
   * The harness CEILING is the one wall-clock assertion kept, and its headroom was measured under load:
   * worst episode 4748ms at load average 54-91 (6 runs, 24 CPU hogs on 10 cores) against the 6666ms
   * ceiling — 1.40x, with `attempts` reaching its bound of 8 on every one of those runs. `bound` stays a
   * diagnostic: on the same runs it read 5174-5358ms against a 4687-4748ms episode (~1.1x), and it is
   * derived per run from a single-attempt measurement taken moments earlier. What reddens this test on a
   * constants increase is the ceiling, not `bound` — GREEN at +20%..+80% on the timeout, red at
   * 250 -> 500. Cost: one exhausted production budget, ~5s, because a permanently held lock must
   * exhaust it.
   */
  it("spends the production budget on a held lock, in at most maxAttempts attempts", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        const production = resolveBusyBudget();

        // One attempt's cost on THIS host, at the production timeout and with no retry: the model counts
        // only the internal wait per attempt, so a bound for a measured episode needs this measurement.
        const singleStarted = Date.now();
        let singleError: unknown;
        try {
          await loadHashStore({ maxAttempts: 1, backoffJitterMs: 0 });
        } catch (caught) {
          singleError = caught;
        }
        const singleAttempt = Date.now() - singleStarted;
        expect((singleError as { errcode?: number }).errcode).toBe(5);

        // MEASURED attempt count: every retry draws its jitter from `Math.random` (nothing else in the
        // store open calls it), and the last failure throws without drawing, so attempts = draws + 1.
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

        // DIAGNOSTICS, never assertions: elapsed / cap / model / bound / per-attempt cost / total ride
        // the assertion MESSAGE. `bound` charges every attempt its MEASURED cost and allows the one
        // capped sleep a deadline-ended episode can overshoot by, but it is derived per run from a
        // single-attempt measurement taken moments earlier, so asserting `elapsed < bound` would be a
        // wall-clock guarantee whose headroom was never measured under load.
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

        // The ORIGINAL busy error object: the deadline changes when the loop stops, not what it reports.
        expect(error, diagnostics).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // STRUCTURE, not an exact count: the loop makes at least one attempt and never more than it was
        // given. The exact count is NOT asserted here — with a real clock the deadline can end the
        // episode a retry early, which is the false invariant this test used to carry.
        expect(attempts, diagnostics).toBeGreaterThanOrEqual(1);
        expect(attempts, diagnostics).toBeLessThanOrEqual(production.maxAttempts);
        // The one wall-clock assertion kept: the harness ceiling, whose headroom IS measured under load
        // (in the doc comment above). It is what reddens a constants increase — `bound` moves with the
        // constants it would have to indict, so it cannot catch that regression.
        expect(elapsed, diagnostics).toBeLessThan(harnessCeilingMs);
        expect(rival.isOpen).toBe(true);
      });
    });
  }, 30_000);

  it("recovers through the retry loop when a rival releases past the internal wait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        // The loop retries at most once here (the release lands on the first backoff draw), so the
        // attempt count is the evidence that the outer loop — not SQLite's own wait — did the work.
        const attempts: number[] = [];
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 40,
          backoffBaseMs: 10,
          backoffCapMs: 40,
          backoffJitterMs: 0,
          // The injected draw doubles as the release point: the store open blocks the event loop
          // synchronously, so between two attempts is the only moment test code can run at all —
          // and an attempt blocked on a foreign RESERVED lock can never outwait 25ms of its own.
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
        // EXACT and structural, not a measurement: the rival's lock can only be released from the draw,
        // and a draw only happens after a failed attempt, so the loop cannot reach a second attempt.
        expect(attempts.length, diagnostics).toBe(1);
        // Kept because its headroom was measured under load: worst 58ms at load average 54-91 (6 runs,
        // 24 CPU hogs on 10 cores; 45-52ms idle) against this 1000ms bound — 17x. The bound is this
        // test's own, not the injected budget's: the episode is one failed attempt plus the
        // release-triggered retry, so a stalled attempt still reddens here.
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
  /** The schedule with one fixed jitter draw — the single channel `busyBackoffMs` reads it from. */
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
    // Below the cap no two attempts wake at the same instant — the uniform-budget defect.
    expect(new Set(waits.slice(0, 4)).size).toBe(4);
  });

  it("keeps the production budget inside the harness ceilings", () => {
    // Stated arithmetic: 8 x 250 + (50+100+200+400+400+400+400) + 7 x 50 = 4300ms.
    expect(busyBudgetMs()).toBe(4_300);
    // vitest.config.ts: testTimeout 20000ms, hookTimeout 30000ms — read from the config, not restated.
    // Even the three budgets the corrupt-store rebuild path can spend stay inside the test ceiling, so
    // contention surfaces as a content error (busy) rather than as a killed test.
    expect(busyBudgetMs() * 3).toBeLessThan(harnessTestTimeoutMs);
  });

  it("fills the unspecified budget fields from the production constants", () => {
    const overridden = busyBudgetMs({ timeoutMs: 25, maxAttempts: 4 });
    // 4 x 25 + (100 + 150 + 250): the production backoff schedule at its maximum jitter draw.
    expect(overridden).toBe(600);
    // The deadline's clock: with nothing injected the resolved budget carries the REAL clock (the same
    // function, not a wrapper), so every production call site keeps measuring wall time exactly as
    // before while a test can freeze or jump it through the same optional budget argument.
    expect(resolveBusyBudget().now).toBe(Date.now);
  });

  it("reads the jitter from ONE channel: the budget's `random`, else Math.random", () => {
    const injected = vi.fn(() => 1);
    const mathRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    // An injected draw wins, and is taken exactly once per backoff...
    expect(busyBackoffMs(0, { ...schedule, random: injected })).toBe(100);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(mathRandom).not.toHaveBeenCalled();
    // ...and with nothing injected the SAME channel falls through to Math.random. There is no second,
    // positional draw argument for `withBusyRetry` to disagree with, which is the defect this pins: an
    // injected draw can no longer be silently ignored in favour of the other channel (or the reverse).
    expect(busyBackoffMs(0, schedule)).toBe(75);
    expect(mathRandom).toHaveBeenCalledTimes(1);
    mathRandom.mockRestore();
  });
});
