/**
 * Integration seam: the lifecycle slot wired to the real store. Each test drives the public
 * `loadHashStore` / `shutdownHashStore` pair plus `storeLifecycleSlot`, and asserts on the cache's
 * own truth (`__isStoreOpen`) rather than on any internal counter of the slot.
 *
 * Every attached token is detached in `finally`, and the store is shut down there too, so a failed
 * test cannot leak an owner — or an open handle — into the next one.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  loadHashStore,
  shutdownHashStore,
  storeLifecycleSlot,
  __isStoreOpen,
  onStoreOpen,
} from "../../src/hash-store";
import { getSnapshot, snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { getUndoEntry, upsertUndo } from "../../src/undo-store";
import { initHasher } from "../../src/hashline/hasher";
import { splitLines } from "../../src/utils";
import { getWritableTempRoot } from "../support/fixtures";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const attached = new Set<symbol>();

function attach(): symbol {
  const token = Symbol("owner");
  storeLifecycleSlot.attach(token);
  attached.add(token);
  return token;
}

async function detach(token: symbol): Promise<void> {
  attached.delete(token);
  await storeLifecycleSlot.detach(token);
}

async function withTempStore(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-slot-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run();
  } finally {
    for (const token of attached) await detach(token);
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await initHasher();
});

describe("hash-store lifecycle slot", () => {
  it("closes the handle when the last owner detaches", async () => {
    await withTempStore(async () => {
      const token = attach();

      const store = await loadHashStore();

      expect(store.db.isOpen).toBe(true);
      expect(__isStoreOpen()).toBe(true);

      await detach(token);

      expect(__isStoreOpen()).toBe(false);
      expect(store.db.isOpen).toBe(false);
    });
  });

  it("keeps a bare load warm until shutdownHashStore", async () => {
    await withTempStore(async () => {
      await loadHashStore();

      expect(__isStoreOpen()).toBe(true);
      expect(storeLifecycleSlot.ownerCount).toBe(0);
      expect(storeLifecycleSlot.isDraining).toBe(false);

      await loadHashStore();

      expect(__isStoreOpen()).toBe(true);

      shutdownHashStore();

      expect(__isStoreOpen()).toBe(false);
    });
  });

  it("reopens a bare load only after a pending detach drain closes", async () => {
    await withTempStore(async () => {
      const token = attach();
      await loadHashStore();
      const gate = deferred();
      const running = deferred();
      const scope = storeLifecycleSlot.withScope(async () => {
        running.resolve();
        await gate.promise;
      });
      await running.promise;

      try {
        const detaching = detach(token);
        expect(storeLifecycleSlot.isDraining).toBe(true);

        let settled = false;
        const reopening = loadHashStore().then((store) => {
          settled = true;
          return store;
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(__isStoreOpen()).toBe(true);

        gate.resolve();
        await scope;
        const reopened = await reopening;

        expect(reopened.db.isOpen).toBe(true);
        expect(__isStoreOpen()).toBe(true);
        await detaching;
      } finally {
        gate.resolve();
        await scope;
      }
    });
  });

  it("loads from inside a scope while a forced release drains", async () => {
    await withTempStore(async () => {
      const token = attach();
      await loadHashStore();
      const forced: Array<Promise<boolean>> = [];
      let insideLoad = "never-ran";
      let stillOpenInside = false;
      const scope = storeLifecycleSlot.withScope(async () => {
        forced.push(storeLifecycleSlot.release({ force: true }));
        insideLoad = await Promise.race([
          loadHashStore().then((store) => (store.db.isOpen ? "open" : "closed")),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("timeout"), 100);
          }),
        ]);
        stillOpenInside = __isStoreOpen();
      });

      await scope;

      expect(insideLoad).toBe("open");
      expect(stillOpenInside).toBe(true);
      expect(await forced[0]).toBe(true);
      expect(__isStoreOpen()).toBe(false);
      expect(storeLifecycleSlot.isDraining).toBe(false);
      detach(token);
    });
  });

  it("still resolves an open handle when the drain closes it as the load's own scope ends", async () => {
    await withTempStore(async () => {
      const token = attach();
      let fired = false;
      onStoreOpen(() => {
        if (fired) return;
        fired = true;
        void detach(token);
      });

      const store = await loadHashStore();

      expect(store.db.isOpen).toBe(true);
      expect(__isStoreOpen()).toBe(true);
    });
  });

  it("keeps persisted snapshots across a detach and reopen", async () => {
    await withTempStore(async () => {
      const token = attach();
      const first = await loadHashStore();
      const content = "persisted\n";
      upsertSnapshot(first, {
        path: "/persist.ts",
        snapshotHash: snapshotHashFor(content),
        lineCount: splitLines(content).length,
        hashes: ["AABB"],
        content,
      });

      upsertUndo(first, "/persist-undo.ts", {
        content: "before\n",
        bom: "",
        ending: "\n",
        hashes: ["CCDD"],
        resultContent: "after\n",
      });

      expect(getSnapshot(first, "/persist.ts", content)).toEqual(["AABB"]);
      expect(getUndoEntry(first, "/persist-undo.ts")).toMatchObject({
        content: "before\n",
        resultContent: "after\n",
        hashes: ["CCDD"],
      });

      await detach(token);
      expect(__isStoreOpen()).toBe(false);

      const second = await loadHashStore();

      expect(second.db.isOpen).toBe(true);
      expect(getSnapshot(second, "/persist.ts", content)).toEqual(["AABB"]);
      expect(getUndoEntry(second, "/persist-undo.ts")).toMatchObject({
        content: "before\n",
        resultContent: "after\n",
        hashes: ["CCDD"],
      });
    });
  });
});
