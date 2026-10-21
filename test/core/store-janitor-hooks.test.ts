/**
 * #90 — the janitor's lifecycle hooks: what a handler does when the pass it runs FAILS.
 *
 * WHY this file exists: a background timer is impossible (the extension API exposes no idle timer and
 * no `deactivate` event), so the janitor hangs on a lifecycle event, and a maintenance item must not
 * break the session it runs in — so the failure path is asserted here. The TRIGGER itself, and the
 * tool-call exclusion that makes it safe, is asserted as ONE invariant in `store-janitor.test.ts`
 * (the wiring and the measured zero-janitor-statement open in a single test), so that is where a
 * reader looks for which events are subscribed and which are forbidden; keeping a second copy here
 * would let the two drift apart.
 */
import { describe, expect, it, vi } from "vitest";

import { registerJanitorHooks } from "../../src/store-janitor";
import { clearDiagnostics, readDiagnostics } from "../support/fixtures";

/** A stand-in for `pi` that records what was subscribed and hands the handlers back. */
function fakePi(): {
  readonly subscriptions: Array<{ event: string; handler: () => Promise<void> }>;
  readonly pi: unknown;
} {
  const subscriptions: Array<{ event: string; handler: () => Promise<void> }> = [];
  return {
    subscriptions,
    pi: {
      on(event: string, handler: () => Promise<void>) {
        subscriptions.push({ event, handler });
      },
    },
  };
}

describe("the janitor's failure containment", () => {
  it("swallows a failing pass so maintenance never breaks the session", async () => {
    const { pi, subscriptions } = fakePi();
    const run = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    // WHY the log file and not the console: a maintenance failure must stay out of the terminal
    // WHY Pi's renderer owns; the containment contract is "reported, never thrown".
    clearDiagnostics();
    registerJanitorHooks(pi as never, { runJanitor: run });
    await expect(subscriptions[0]?.handler()).resolves.toBeUndefined();
    expect(readDiagnostics()).not.toHaveLength(0);
  });
});
