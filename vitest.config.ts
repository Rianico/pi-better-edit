import { defineConfig } from "vitest/config";

/**
 * Test-harness hardening (#84). This suite is I/O- and subprocess-heavy: 204 files, each opening the
 * hash store, spawning git/hash subprocesses and materialising temp fixtures, run nine-at-a-time.
 * Under host load the TIMER LATENESS of a slow call — never a hang — exceeds vitest's defaults
 * (`testTimeout` 5000ms, `hookTimeout` 10000ms) and fails a test that passes in isolation.
 *
 * Measured on this machine, same commit, host load in parentheses:
 * - `test/tools/replace-validation.test.ts` 10174ms (load ~6) and
 *   `test/core/whitespace-insensitive-canon.test.ts` 11041ms (load ~8) — both green in isolation
 *   (1285ms / 4.09s).
 * - Deliberate reproduction: the full suite overlapping an I/O-heavy load (load ~172) failed
 *   `test/tools/lifecycle-hooks.test.ts` > `onWrite returns undefined for non-text file (no record)`
 *   at 5526ms — a 5000ms ceiling missed by 10%. The SAME load with these ceilings is green
 *   (2207 passed | 1 skipped) and 9s FASTER in wall time (108s vs 117s): a timeout failure costs
 *   more than the slack it guards.
 *
 * WHY these numbers: 20000ms is 4× the default and above the worst observed test lateness
 * (11041ms); 30000ms is 3× the default and above the worst observed hook lateness (~14000ms). They
 * are ceilings, not budgets — no test is expected to reach them, and a real hang still fails rather
 * than blocking the run.
 *
 * THE COST OF THAT SLACK, stated next to the numbers: a genuine hang now takes the higher ceiling to
 * surface, so the pessimistic case — every worker stuck at once, e.g. a deadlocked hash-store call —
 * costs about (204 files ÷ ~9 workers) × 15-20s ≈ 6-8 min before the run fails, against ≈2-3 min at
 * the old 5s/10s defaults. A single hung test still costs only its own 20s. That tax is paid only
 * when something is truly stuck; the alternative, measured above, is paying it in false failures
 * under load.
 *
 * WHY `hookTimeout` as well as `testTimeout`: the failures come in BOTH shapes — a plain test body
 * (`replace-validation`, `lifecycle-hooks`) and a module-level `beforeAll(async () => await
 * initHasher())` (`whitespace-insensitive-canon`, `task147-rejection-diagnostics`). Raising only
 * `testTimeout` leaves the 10s hook limit in place to flake again.
 *
 * WHY no structural lever — all three were measured and rejected on this branch:
 * - `isolate: false`, the only way a module-level singleton is reused across files, breaks the
 *   suite: 19 tests in 8 files fail, so the per-file module registry is load-bearing.
 * - `maxWorkers: 4` survives the same reproduction but costs +33s wall (150s vs 117s) and does not
 *   remove the failure mode: the ceilings stay at 5000ms/10000ms, so lateness above them still
 *   fails — the same suite was separately observed at 11041ms — and it cannot bound the host's
 *   external load, which is where the contention came from.
 * - Hoisting `initHasher()`: nothing to hoist. It is ALREADY a module-level singleton promise, and
 *   a file awaiting it runs in 3.3-4.4s under load in isolation, so the ~14s figures were
 *   contention, not init cost. `globalSetup` runs in the main process and cannot populate a
 *   worker's module variable.
 *
 * WHY the coverage thresholds are NOT here: they stay on the `test:coverage` CLI line so `test` and
 * `test:coverage` keep one definition of the gate.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
