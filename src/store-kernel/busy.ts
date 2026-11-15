/**
 * SAFETY: store-kernel/busy — the store's contention budget: one retry loop, one deadline, one classifier.
 *
 *
 * Every store write funnels through `withBusyRetry`, so the budget, the arithmetic that models it
 * and the busy classification live and change together. The numbers are in `./constants.ts`; the
 * modelled episode they encode is 4300ms — 8 x 250ms of internal wait, 1950ms of capped backoff,
 * 350ms of jitter — 21.5% of the harness `testTimeout`.
 *
 * The `timeout` constructor option IS SQLite's busy handler, and `PRAGMA busy_timeout` reports it
 * back, so no pragma is set here: one would install a second, competing budget.
 */
import {
  BUSY_BACKOFF_BASE_MS,
  BUSY_BACKOFF_CAP_MS,
  BUSY_BACKOFF_JITTER_MS,
  BUSY_MAX_ATTEMPTS,
  HASH_STORE_BUSY_TIMEOUT,
} from "./constants.js";

export function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * The store's contention budget: how long one attempt may wait inside SQLite (`timeoutMs`, the
 * constructor option that `PRAGMA busy_timeout` reports) and how the retry loop spaces its attempts.
 * Every field is optional — production call sites pass nothing and get the constants above, plus the
 * real clock for the deadline — so a caller that must not spend the production budget, or must pin the
 * schedule or the deadline source (a test making a branch deterministic), can say so explicitly without
 * any production call site changing.
 */
export interface BusyBudget {
  /** SQLite's own busy-handler wait per statement; 0 disables that wait. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** First backoff; doubles per attempt. */
  backoffBaseMs?: number;
  /** Hard ceiling on the exponential term. */
  backoffCapMs?: number;
  /** Upper bound of the jitter draw added to every backoff. */
  backoffJitterMs?: number;
  /** The jitter draw, in [0, 1). Injectable so a test can pin the schedule. */
  random?: () => number;
  /**
   * The clock the deadline is measured against, in the same sense as `Date.now`. Injectable so a test
   * can FREEZE it — the attempt count is then the only terminator, which is the branch that asserts an
   * exact count — or jump it past the deadline, which exercises the documented backstop deterministically
   * instead of waiting for a loaded host to reach it. Nothing injected means the real clock, so every
   * production call site keeps measuring wall time exactly as it did before.
   */
  now?: () => number;
}

/**
 * `overrides` filled in field by field from the production constants above — the one place those
 * constants acquire meaning. Exported because it is the only honest source for an assertion: a test
 * derives the production timeout, attempt count and model here instead of restating 250/8/4300 as
 * literals, which would keep passing if the constants moved.
 */
export function resolveBusyBudget(overrides?: BusyBudget): Required<BusyBudget> {
  return {
    timeoutMs: overrides?.timeoutMs ?? HASH_STORE_BUSY_TIMEOUT,
    maxAttempts: Math.max(1, Math.trunc(overrides?.maxAttempts ?? BUSY_MAX_ATTEMPTS)),
    backoffBaseMs: overrides?.backoffBaseMs ?? BUSY_BACKOFF_BASE_MS,
    backoffCapMs: overrides?.backoffCapMs ?? BUSY_BACKOFF_CAP_MS,
    backoffJitterMs: overrides?.backoffJitterMs ?? BUSY_BACKOFF_JITTER_MS,
    random: overrides?.random ?? (() => Math.random()),
    now: overrides?.now ?? Date.now,
  };
}

/**
 * The wait before retry `attempt` (0-based): exponential from `backoffBaseMs`, doubled per attempt
 * and capped at `backoffCapMs`, plus a draw in [0, backoffJitterMs). The jitter is the point — it is
 * what stops writers that started together from waking together again on every attempt. The draw comes
 * from `budget.random` and from NOWHERE else: one injection channel, so a caller that sets `random`
 * cannot have it silently ignored in favour of `Math.random`, and a caller that does not gets
 * `Math.random` — never a positional argument that `withBusyRetry` would have had to agree about.
 */
export function busyBackoffMs(attempt: number, overrides?: BusyBudget): number {
  const budget = resolveBusyBudget(overrides);
  const exponential = budget.backoffBaseMs * 2 ** Math.max(0, attempt);
  return Math.min(budget.backoffCapMs, exponential) + budget.random() * budget.backoffJitterMs;
}

/**
 * The modelled worst case of one contention episode: every attempt spending its full internal wait,
 * plus every backoff at its maximum jitter draw. `withBusyRetry` uses it as a wall-clock deadline, so
 * the number the constants above were chosen against is also the number the loop enforces.
 */
export function busyBudgetMs(overrides?: BusyBudget): number {
  const budget = resolveBusyBudget(overrides);
  let total = budget.timeoutMs * budget.maxAttempts;
  for (let attempt = 0; attempt < budget.maxAttempts - 1; attempt++) {
    total += busyBackoffMs(attempt, { ...budget, random: () => 1 });
  }
  return total;
}

/**
 * Run `fn` under the store's contention budget. EVERY store write funnels through here — the open
 * (via `openDbWithBusyRetry`), `withStore`, and the statement-level retries in snapshot-store,
 * undo-store and the served session. On exhaustion the ORIGINAL error is rethrown unchanged, so
 * every caller keeps classifying busy against corrupt exactly as it did before.
 * A retried open re-enters the WHOLE `buildStore` from the top — many independent autocommit
 * statement sites, not one transaction — and a retried write re-enters the WHOLE caller body,
 * because this budget wraps `withStore`'s `BEGIN IMMEDIATE ... COMMIT` too.
 * The ceiling on re-entry is therefore `maxAttempts`: 4 -> 8 (2x) at the SAME 4300ms TOTAL model
 * either way, 8 x 250ms = 2000ms here against 4 x 1000ms = 4000ms there — a WASH under sustained
 * contention; the INTERLEAVED case is BOUNDED BUT UNMEASURED.
 */
export function withBusyRetry<T>(fn: () => T, overrides?: BusyBudget): T {
  const budget = resolveBusyBudget(overrides);
  const deadline = budget.now() + busyBudgetMs(budget);
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt >= budget.maxAttempts - 1 || budget.now() >= deadline) {
        throw error;
      }
      sleepSync(busyBackoffMs(attempt, budget));
    }
  }
}
