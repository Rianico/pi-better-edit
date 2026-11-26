/**
 * #357 — the SESSION token and the public release seam over the store's lifecycle slot.
 *
 * Two claims are load-bearing here and neither is a counter of the slot: a session CLAIMS the
 * handle without touching SQLite (`attach` never opens), and the last claim leaving is what makes
 * a close due. `releaseHashStore` is the host-facing close for a path that emits no
 * `session_shutdown` (a direct `AgentSession.dispose()`), so its answer is probed from the cache's
 * own truth (`__isStoreOpen`) rather than from the slot's bookkeeping.
 *
 * Each test detaches every session it created and shuts the store down in `finally`, so a failed
 * assertion cannot leak an owner into the next test.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  loadHashStore,
  shutdownHashStore,
  storeLifecycleSlot,
  __isStoreOpen,
} from "../../src/hash-store";
import { createStoreSession, releaseHashStore, type StoreSession } from "../../src/store-lifecycle";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTempStore(run: (opened: StoreSession[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-lifecycle-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  const opened: StoreSession[] = [];
  try {
    await run(opened);
  } finally {
    for (const session of opened) await session.detach();
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A session the harness owns, so cleanup detaches whatever a failing assertion left attached. */
function openSession(opened: StoreSession[]): StoreSession {
  const session = createStoreSession();
  opened.push(session);
  return session;
}

beforeAll(async () => {
  await initHasher();
});

describe("createStoreSession", () => {
  it("claims one owner no matter how often the same session attaches", async () => {
    await withTempStore(async (opened) => {
      const session = openSession(opened);
      expect(storeLifecycleSlot.ownerCount).toBe(0);

      session.attach();
      session.attach();

      expect(storeLifecycleSlot.ownerCount).toBe(1);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("ignores a detach before any attach", async () => {
    await withTempStore(async (opened) => {
      const session = openSession(opened);

      await session.detach();

      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(storeLifecycleSlot.isDraining).toBe(false);
    });
  });

  it("keeps the handle open until the second of two sessions detaches", async () => {
    await withTempStore(async (opened) => {
      const first = openSession(opened);
      const second = openSession(opened);
      first.attach();
      second.attach();
      expect(storeLifecycleSlot.ownerCount).toBe(2);

      await loadHashStore();
      expect(__isStoreOpen()).toBe(true);

      await first.detach();
      await first.detach();
      expect(storeLifecycleSlot.ownerCount).toBe(1);
      expect(__isStoreOpen()).toBe(true);

      await second.detach();
      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("re-claims the handle after a forced release dropped every owner", async () => {
    await withTempStore(async (opened) => {
      const session = openSession(opened);
      session.attach();

      expect(await releaseHashStore({ force: true })).toBe(true);
      expect(storeLifecycleSlot.ownerCount).toBe(0);

      session.attach();
      expect(storeLifecycleSlot.ownerCount).toBe(1);

      await loadHashStore();
      expect(__isStoreOpen()).toBe(true);

      await session.detach();
      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(__isStoreOpen()).toBe(false);
    });
  });
});

describe("releaseHashStore", () => {
  it("refuses while an attached session keeps the handle, then reports the close", async () => {
    await withTempStore(async (opened) => {
      const session = openSession(opened);
      session.attach();
      await loadHashStore();

      expect(await releaseHashStore()).toBe(false);
      expect(__isStoreOpen()).toBe(true);

      await session.detach();

      expect(await releaseHashStore()).toBe(true);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("reports true for a store that is already closed", async () => {
    await withTempStore(async () => {
      expect(__isStoreOpen()).toBe(false);

      expect(await releaseHashStore()).toBe(true);
      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("closes a handle that two attached sessions still claim when forced", async () => {
    await withTempStore(async (opened) => {
      const first = openSession(opened);
      const second = openSession(opened);
      first.attach();
      second.attach();
      await loadHashStore();
      expect(__isStoreOpen()).toBe(true);

      expect(await releaseHashStore({ force: true })).toBe(true);

      expect(__isStoreOpen()).toBe(false);
      expect(storeLifecycleSlot.ownerCount).toBe(0);
    });
  });

  it("reports false when a racing attach cancels the drain it started", async () => {
    await withTempStore(async (opened) => {
      await loadHashStore();
      const session = openSession(opened);
      const gate = deferred();
      const running = deferred();
      const scope = storeLifecycleSlot.withScope(async () => {
        running.resolve();
        await gate.promise;
      });
      await running.promise;

      const releasing = releaseHashStore();
      expect(storeLifecycleSlot.isDraining).toBe(true);
      session.attach();

      gate.resolve();
      await scope;

      expect(await releasing).toBe(false);
      expect(__isStoreOpen()).toBe(true);
    });
  });
});
