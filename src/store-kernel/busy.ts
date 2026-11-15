/**
 * SAFETY: store-kernel/busy — the store's contention budget: one retry loop, one deadline, one classifier.
 *
 * WHY: every store write funnels through `withBusyRetry` (the open, `withStore`, and the statement-level
 * WHY: retries in snapshot-store, undo-store and the served session), so the budget, the arithmetic that
 * WHY: models it and the busy classification live together and are changed together. The numbers are in
 * WHY: `./constants.ts`; this module is the policy that gives them meaning.
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

// WHY: (#87b) the retry policy REFRAMES the defect, which was never a missing timeout: `node:sqlite`'s
// WHY: `timeout` constructor option IS SQLite's busy handler — `PRAGMA busy_timeout` reports it back
// WHY: verbatim ({ timeout: 250 } reads 250, probe-measured: no option at all reads 0) — so no pragma was
// WHY: absent here and adding one would install a second, competing budget. The real defect was an
// WHY: IMPLICIT, OVERSIZED, UNIFORM one: four attempts each allowed a silent blocked second, 100ms apart,
// WHY: so writers that started together woke together, re-collided, and made a contended open read as a
// WHY: hang. The replacement is EXPLICIT (these constants), BOUNDED (the deadline below) and DECORRELATED
// WHY: (jittered exponential backoff instead of one fixed delay).
// WHY: the model as arithmetic — attempts x internal wait + sleeps:
// WHY:   internal wait  250ms x 8 attempts                     = 2000ms
// WHY:   backoff sleeps 50+100+200+400+400+400+400 (cap 400)   = 1950ms
// WHY:   jitter         7 sleeps x <= 50ms                     =  350ms
// WHY:   ---------------------------------------------------------------
// WHY:   modelled episode (busyBudgetMs)                       = 4300ms
// WHY: the model is what the constants were chosen against, not what an attempt costs. SQLite returns
// WHY: SQLITE_BUSY once the busy timeout elapses, so ONE attempt against a permanently held lock spends
// WHY: its full 250ms internal wait plus a small constant overhead of connection-open and statement work.
// WHY: That overhead varies with the harness — store opened per attempt or pre-built, how the rival takes
// WHY: the lock, the host — so it carries no figure here, and neither does anything derived from it: a
// WHY: millisecond band read off one harness is a fact about that harness, not about this code. A retry
// WHY: pays it ONCE, because a contended attempt blocks at its FIRST lock-taking statement and does no
// WHY: body work: a shape's real cost is attempts x (its own timeout + that overhead) plus its sleeps —
// WHY: four overheads on the old 4 x 1000 + 300 shape, eight on the 8 x 250 + 2300 one, both totalling the
// WHY: same 4300ms model. The tests separate the shapes by attempt count and per-attempt stall, the terms
// WHY: they DO differ in. What the count adds over the model is that overhead times the count, less the
// WHY: model's jitter over-charge (it charges every backoff its MAXIMUM draw while an episode pays some
// WHY: fraction of one). Injected and uninjected runs are ONE quantity: a budget injected with exactly
// WHY: these values resolves to the same model, which is why the contention test injects nothing — an
// WHY: injected budget replaces every constant it would be guarding.
// WHY: the bound is scoped to THESE constants: a budget carrying its own, larger model — maxAttempts 100
// WHY: models 68.7s (code-derived: 100 x 250ms plus 43.7s of capped backoff and jitter) — bounds its own
// WHY: episode, never 'one episode is capped at 4300ms'.
// WHY: 4300ms is 21.5% of the harness `testTimeout` (20000ms) and 14% of `hookTimeout` (30000ms), so
// WHY: contention surfaces as the busy error rather than as a killed test. The corrupt-store rebuild path
// WHY: can spend three budgets (3 x 4300 = 12.9s), but only immediately after quarantine replaced the
// WHY: file, when no rival can still hold the old inode.
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
    // WHY: DEFENSIVE, not the mechanism: the loop's own `attempt >= maxAttempts - 1` guard already
    // WHY: throws after the first failed attempt for any maxAttempts <= 1, so the floor buys only a sane
    // WHY: RESOLVED model — 0 and -1 both read as one attempt, hence a 250ms rather than a non-positive
    // WHY: deadline.
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
  // WHY: a deadline, not only an attempt count: an attempt already inside SQLite cannot be interrupted,
  // WHY: so the count alone would let one slow attempt extend the episode without bound. The check runs
  // WHY: AFTER the failed attempt, so an episode ends between attempts — at most one capped sleep plus one
  // WHY: already-running attempt past the deadline, which is why it can end BELOW `maxAttempts`: no caller
  // WHY: may treat an exact count as guaranteed.
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
