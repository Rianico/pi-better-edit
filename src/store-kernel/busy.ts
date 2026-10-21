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

// WHY: (#87b) the retry policy below REFRAMES the defect, which was never a missing timeout.
// WHY: `node:sqlite`'s `timeout` constructor option IS SQLite's busy handler — `PRAGMA busy_timeout`
// WHY: reports it back verbatim ({ timeout: 250 } reads 250, probe-measured: no option at all reads 0) — so no pragma was
// WHY: absent here and adding one would install a second, competing budget. The real defect was an
// WHY: IMPLICIT, OVERSIZED, UNIFORM one: every attempt could sit blocked and silent for a full
// WHY: second, there were four of them, and the gap between them was one fixed 100ms, so writers
// WHY: that started together woke together and re-collided. The replacement is EXPLICIT (these
// WHY: constants), BOUNDED (the deadline busyBudgetMs computes from them) and DECORRELATED
// WHY: (jittered exponential backoff instead of one fixed delay).
// WHY: these numbers — the model as arithmetic, attempts x internal wait + sleeps:
// WHY:   internal wait  250ms x 8 attempts                     = 2000ms
// WHY:   backoff sleeps 50+100+200+400+400+400+400 (cap 400)   = 1950ms
// WHY:   jitter         7 sleeps x <= 50ms                     =  350ms
// WHY:   ---------------------------------------------------------------
// WHY:   modelled episode (busyBudgetMs)                       = 4300ms
// WHY: 250ms rather than the previous 1000ms: the contended critical section is one short WAL write
// WHY: transaction, so a second of blocked silence DWARFED the thing being waited for, and four such
// WHY: silences made a contended open indistinguishable from a hang.
// WHY: Eight attempts at 250ms buy back the patience the old 4 x 1000 + 3 x 100 shape had — the SAME
// WHY: 4300ms model — so the two shapes cannot be told apart by aggregate duration; the tests below
// WHY: separate them by attempt count and by per-attempt stall, which the shapes DO differ in.
// WHY: the model is what the constants were chosen against, not what an attempt costs. SQLite returns
// WHY: SQLITE_BUSY once the busy timeout elapses, so ONE attempt against a permanently held lock
// WHY: spends its full 250ms internal wait plus a small constant overhead of connection-open and
// WHY: statement work. That overhead varies with the harness rather than with these constants — a store
// WHY: opened per attempt or pre-built, the way the rival takes the lock, the host — so it carries no
// WHY: figure here, and neither does anything derived from it: a millisecond band read off one harness
// WHY: is a fact about that harness, not about this code. A retry pays the overhead ONCE, not once per
// WHY: lock-taking statement, because a contended attempt blocks at its FIRST lock-taking statement and
// WHY: does no body work. The overhead is the same whatever the per-attempt wait is, so a shape's real
// WHY: cost is its attempts x (its own timeout + that overhead) plus its sleeps: four overheads on the
// WHY: old 4 x 1000 + 300 shape, eight on the 8 x 250 + 2300 one, both sitting on the same 4300ms model
// WHY: above.
// WHY: the deadline is the backstop, not the usual terminator: it is checked AFTER each attempt, so it
// WHY: can only end an episode between attempts — one capped sleep plus one already-running attempt past
// WHY: it. At these constants the COUNT is what ends an episode — a lock no attempt can outwait fails
// WHY: every attempt, and the tests below assert the count explicitly against `maxAttempts` — while the
// WHY: deadline remains the backstop that can end an episode below it. What the count then adds on top
// WHY: of the model is the arithmetic the model is already made of: the per-attempt overhead times the
// WHY: attempt count, less what the model over-charges in its jitter term, because it charges every
// WHY: backoff its MAXIMUM draw while an episode pays some fraction of one. Injected and uninjected runs
// WHY: are ONE quantity, not two: a budget injected with exactly these values resolves to the same model,
// WHY: which is why the contention test below injects nothing — an injected budget replaces every
// WHY: constant it would be guarding.
// WHY: scoped to THESE constants: an injected budget carries its own, larger model — maxAttempts 100
// WHY: models 68.7s (code-derived: 100 x 250ms plus 43.7s of capped backoff and jitter) —
// WHY: so what is bounded is the episode's own model, never 'one episode is capped at 4300ms'.
// WHY: 4300ms is 21.5% of the harness `testTimeout` (20000ms) and 14% of `hookTimeout` (30000ms), so
// WHY: contention surfaces as the busy error rather than as a killed test. The corrupt-store rebuild
// WHY: path can spend three budgets (3 x 4300 = 12.9s), but only immediately after quarantine
// WHY: replaced the file — when no rival can still hold the old inode.
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
    // SAFETY: DEFENSIVE, not the mechanism: the loop's own `attempt >= maxAttempts - 1` guard throws
    // SAFETY: after the FIRST failed attempt for any maxAttempts <= 1, so the single attempt is
    // SAFETY: guaranteed by the loop itself. What the floor buys is a sane RESOLVED model —
    // SAFETY: `resolveBusyBudget` maps 0 -> 1 attempt and -1 -> 1, and `busyBudgetMs` maps
    // SAFETY: 0 -> 250ms and -250 -> 250ms — so no caller reads a non-positive deadline.
    maxAttempts: Math.max(1, Math.trunc(overrides?.maxAttempts ?? BUSY_MAX_ATTEMPTS)),
    backoffBaseMs: overrides?.backoffBaseMs ?? BUSY_BACKOFF_BASE_MS,
    backoffCapMs: overrides?.backoffCapMs ?? BUSY_BACKOFF_CAP_MS,
    backoffJitterMs: overrides?.backoffJitterMs ?? BUSY_BACKOFF_JITTER_MS,
    random: overrides?.random ?? (() => Math.random()),
    // SAFETY: `Date.now` by reference (not a wrapper), so the default IS the real clock: a caller that
    // SAFETY: injects nothing gets production wall-clock behaviour, and the optional seam cannot change
    // SAFETY: what any existing call site measures.
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
    // WHY: the model takes every backoff at the MAXIMUM jitter draw, whatever `random` would return.
    total += busyBackoffMs(attempt, { ...budget, random: () => 1 });
  }
  return total;
}

/**
 * Run `fn` under the store's contention budget. EVERY store write funnels through here — the open
 * (via `openDbWithBusyRetry`), `withStore`, and the statement-level retries in snapshot-store,
 * undo-store and the served session — so this budget and its deadline apply to all of them, not just
 * to the open. On exhaustion the ORIGINAL error is rethrown unchanged, so every caller keeps
 * classifying busy against corrupt exactly as it did before.
 * A retried open re-enters the WHOLE `buildStore` sequence from the top, because the open is not one
 * transaction: `buildStore` is many independent statement sites — the PRAGMAs, the `CREATE
 * TABLE/INDEX IF NOT EXISTS` set, the conditional DROP of the pre-session-keyed served shell, the meta
 * version INSERT, the `addColumnIfMissing` and rename helpers and the two `ensure*` helpers (one of
 * which owns the generation sweep) — every one autocommit, so partial progress survives a failed
 * attempt and the only transaction on the OPEN path is the sweep's own `BEGIN IMMEDIATE`. A retried
 * write re-enters the WHOLE caller body for the same reason, because this budget wraps `withStore`'s
 * `BEGIN IMMEDIATE ... COMMIT` too, and that transaction cannot serve the open instead: the open hooks
 * run before the store handle is published and `withStore` refuses without it, so the open path has
 * one transaction while the write path retries its whole body.
 * The ceiling on re-entry is therefore `maxAttempts` and not one attempt — 4 -> 8 (2x) on an
 * idempotent, lock-serialized path, at the SAME 4300ms TOTAL model either way: the internal waiting
 * moved with the shape, 8 x 250ms = 2000ms here against 4 x 1000ms = 4000ms there, while the model
 * that replaced it holds the TOTAL at 4300ms. That is a WASH under sustained contention, because a
 * contended attempt blocks at its FIRST lock-taking statement — one full busy timeout plus the same
 * connection and statement overhead in either shape, an overhead these constants do not model and a
 * comment cannot derive, so it carries no figure here — and does no body work; the attempts each
 * shape spends are its own `maxAttempts`, 4 there against 8 here. The INTERLEAVED case, a rival
 * taking the lock BETWEEN statements, can reach that ceiling and is BOUNDED BUT UNMEASURED.
 */
export function withBusyRetry<T>(fn: () => T, overrides?: BusyBudget): T {
  const budget = resolveBusyBudget(overrides);
  // SAFETY: a deadline, not only an attempt count — an attempt already inside SQLite cannot be
  // SAFETY: interrupted, so the count alone would let one slow attempt extend the episode without bound.
  // SAFETY: The check runs AFTER the attempt that failed, so a deadline-ended episode stops between
  // SAFETY: attempts: at most one capped sleep plus one already-running attempt past the deadline.
  // SAFETY: The clock is `budget.now` — the real clock unless a caller injects one — so production keeps
  // SAFETY: measuring wall time while a test can freeze or jump the deadline source through the same
  // SAFETY: optional budget argument. This backstop is what lets an episode end BELOW `maxAttempts`
  // SAFETY: attempts, so no caller may treat an exact count as guaranteed.
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
