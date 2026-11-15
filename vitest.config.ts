import { configDefaults, defineConfig } from "vitest/config";

/**
 * Test-harness hardening (#84). This suite is I/O- and subprocess-heavy — 204 files, each opening
 * the hash store and spawning git/hash subprocesses, run nine-at-a-time — so under host load the
 * TIMER LATENESS of a slow call, never a hang, exceeds vitest's defaults (`testTimeout` 5000ms,
 * `hookTimeout` 10000ms) and fails a test that passes in isolation.
 * WHY these numbers: 20000ms is 4× the default and above the worst observed test lateness (11041ms
 * in `test/core/whitespace-insensitive-canon.test.ts`); 30000ms is 3× the default and above the
 * worst observed hook lateness (~14000ms). Ceilings, not budgets: a real hang still fails.
 * WHY `hookTimeout` as well as `testTimeout`: the failures come in BOTH shapes — a plain test body
 * and a module-level `beforeAll(async () => await initHasher())` — so raising one alone flakes.
 * WHY the coverage thresholds are NOT here: they stay on the `test:coverage` CLI line — one gate.
 */
export default defineConfig({
  test: {
    setupFiles: ["./test/support/isolate-store.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude, "**/tmp/**", "**/temp/**"],
  },
});
