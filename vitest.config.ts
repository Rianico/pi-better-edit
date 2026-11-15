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
    // WHY: (#89) pin the hash store into a per-worker temp dir BEFORE any test module is imported, so
    // WHY: no test can open the developer's real ~/.local/state/pi-better-edit/hash-store.sqlite,
    // WHY: and none can rename a real ~/.pi/agents settings file during adoption (#190).
    // WHY: test/support/isolate-store.ts records why this is a worker-level seam.
    setupFiles: ["./test/support/isolate-store.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // WHY: (#87) a scratch *.test.ts under a tmp/ or temp/ anywhere — root or nested — joined the suite
    // WHY: and failed the gate on a clean tree. Spread the defaults, never hand-roll: an upgrade cannot
    // WHY: silently drop one. This exclude is PROTECTIVE (`**/`), deliberately broader than the
    // WHY: CONSERVATIVE root-anchored `/tmp/` in .gitignore: its narrow form must not hide a
    // WHY: legitimately-named nested tmp/ inside a source tree.
    exclude: [...configDefaults.exclude, "**/tmp/**", "**/temp/**"],
  },
});
