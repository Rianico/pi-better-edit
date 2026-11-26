/**
 * Unit seam for `StoreLifecycleSlot`: injected `close`/`isOpen`, so every close decision is
 * observable without a database. Each test names the transition it pins — attach/detach owner
 * counting, the drain record, the forced release, and the scope barrier that keeps a close from
 * landing on a handle an in-flight open is about to use.
 */
import { describe, expect, it, vi, type Mock } from "vitest";

import {
  StoreLifecycleSlot,
  type StoreLifecycleSlotOptions,
} from "../../src/store-kernel/index.js";

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

interface FakeHandle {
  readonly close: Mock<() => void>;
  readonly isOpen: () => boolean;
}

function fakeHandle(): FakeHandle {
  let open = true;
  const close = vi.fn<() => void>(() => {
    open = false;
  });
  return { close, isOpen: () => open };
}

function optionsFor(handle: FakeHandle): StoreLifecycleSlotOptions {
  return { close: handle.close, isOpen: handle.isOpen };
}

function slotWith(handle: FakeHandle): StoreLifecycleSlot {
  return new StoreLifecycleSlot(optionsFor(handle));
}

function raced<T>(promise: Promise<T>, label: string): Promise<T | typeof label> {
  return Promise.race([
    promise,
    new Promise<typeof label>((resolve) => {
      setTimeout(() => resolve(label), 100);
    }),
  ]);
}

const tokenA = Symbol("a");
const tokenB = Symbol("b");

describe("StoreLifecycleSlot — owner counting", () => {
  it("attach is idempotent for the same token", () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    slot.attach(tokenA);
    slot.attach(tokenA);

    expect(slot.ownerCount).toBe(1);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("detach of an unattached token is a no-op", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    await slot.detach(tokenA);

    expect(handle.close).not.toHaveBeenCalled();
    expect(slot.ownerCount).toBe(0);
  });

  it("duplicate detach closes once", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    slot.attach(tokenA);
    await slot.detach(tokenA);
    await slot.detach(tokenA);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("closes exactly once on the real last-owner detach", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    slot.attach(tokenA);
    slot.attach(tokenB);
    await slot.detach(tokenA);

    expect(handle.close).not.toHaveBeenCalled();

    await slot.detach(tokenB);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
    expect(slot.ownerCount).toBe(0);
  });
});

describe("StoreLifecycleSlot — detach close timing", () => {
  it("closes synchronously when no scope is in flight", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);

    const detaching = slot.detach(tokenA);

    expect(handle.close).toHaveBeenCalledTimes(1);
    await detaching;
  });

  it("defers the close to the end of an in-flight scope", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const observed: number[] = [];
    const scope = slot.withScope(async () => {
      observed.push(handle.close.mock.calls.length);
      await gate.promise;
      observed.push(handle.close.mock.calls.length);
    });
    const closesWhenDetachResolves: number[] = [];
    const detaching = slot.detach(tokenA).then(() => {
      closesWhenDetachResolves.push(handle.close.mock.calls.length);
    });

    expect(slot.isDraining).toBe(true);
    expect(slot.inFlightCount).toBe(1);
    expect(handle.close).not.toHaveBeenCalled();

    gate.resolve();
    await scope;
    await detaching;

    expect(observed).toEqual([0, 0]);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(closesWhenDetachResolves).toEqual([1]);
    expect(slot.isDraining).toBe(false);
  });
});

describe("StoreLifecycleSlot — cancellable drain", () => {
  it("a 0→1 attach cancels a pending non-forced drain", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const detaching = slot.detach(tokenA);

    expect(slot.isDraining).toBe(true);

    slot.attach(tokenB);

    expect(slot.isDraining).toBe(false);
    expect(slot.ownerCount).toBe(1);
    await detaching;
    expect(handle.close).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);

    gate.resolve();
    await scope;
    expect(handle.close).not.toHaveBeenCalled();

    const closing = slot.detach(tokenB);
    expect(handle.close).toHaveBeenCalledTimes(1);
    await closing;
  });

  it("a forced release is never cancelled by an attach", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const forced = slot.release({ force: true });

    slot.attach(tokenB);

    expect(slot.isDraining).toBe(true);
    expect(slot.ownerCount).toBe(1);

    gate.resolve();
    await scope;

    expect(await forced).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
    expect(slot.ownerCount).toBe(1);
  });
});

describe("StoreLifecycleSlot — release", () => {
  it("refuses to close while an owner holds the handle", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);

    expect(await slot.release()).toBe(false);

    expect(handle.close).not.toHaveBeenCalled();
    expect(slot.isDraining).toBe(false);
  });

  it("closes a bare handle and reports it", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    expect(await slot.release()).toBe(true);

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("joins the drain a detach started and reports its close", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const detaching = slot.detach(tokenA);

    const releasing = slot.release();
    gate.resolve();
    await scope;

    expect(await releasing).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
    await detaching;
  });

  it("stays cancellable, so a new owner keeps the handle open", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const releasing = slot.release();

    slot.attach(tokenA);
    gate.resolve();
    await scope;

    expect(await releasing).toBe(false);
    expect(handle.close).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    expect(slot.ownerCount).toBe(1);
  });

  it("force-closes with owners attached once the scope drains", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    slot.attach(tokenB);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });

    const forced = slot.release({ force: true });
    expect(handle.close).not.toHaveBeenCalled();

    gate.resolve();
    await scope;

    expect(await forced).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);
  });

  it("force close with nothing in flight is synchronous", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);

    const forced = slot.release({ force: true });

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await forced).toBe(true);
  });
});

describe("StoreLifecycleSlot — awaitDrainingClose barrier", () => {
  it("awaits a pending close from outside the scope", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const detaching = slot.detach(tokenA);

    let settled = false;
    const waiting = slot.awaitDrainingClose().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(slot.isDraining).toBe(true);

    gate.resolve();

    expect(await raced(waiting, "timeout")).not.toBe("timeout");
    expect(handle.close).toHaveBeenCalledTimes(1);
    await detaching;
    await scope;
  });

  it("resolves immediately from inside its own scope", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    let outcome = "never-ran";
    const detaching: Promise<void>[] = [];
    const scope = slot.withScope(async () => {
      detaching.push(slot.detach(tokenA));
      expect(slot.isDraining).toBe(true);
      outcome = await raced(
        slot.awaitDrainingClose().then(() => "resolved"),
        "timeout",
      );
      expect(handle.close).not.toHaveBeenCalled();
    });

    await raced(scope, "scope-timeout");
    await Promise.all(detaching);

    expect(outcome).toBe("resolved");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("resolves with no drain pending", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    expect(await raced(slot.awaitDrainingClose(), "timeout")).not.toBe("timeout");
    expect(handle.close).not.toHaveBeenCalled();
  });
});

describe("StoreLifecycleSlot — scope accounting", () => {
  it("never closes on scope exit without an owner detach", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    await slot.withScope(async () => undefined);
    await slot.withScope(async () => undefined);

    expect(handle.close).not.toHaveBeenCalled();
    expect(slot.isDraining).toBe(false);
    expect(slot.inFlightCount).toBe(0);
  });

  it("counts overlapping scopes and resumes idle only at zero", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);
    slot.attach(tokenA);
    const gate = deferred();
    const innerGate = deferred();
    const outer = slot.withScope(async () => {
      await gate.promise;
    });
    const inner = slot.withScope(async () => {
      await innerGate.promise;
    });

    expect(slot.inFlightCount).toBe(2);

    const detaching = slot.detach(tokenA);
    gate.resolve();
    await outer;
    expect(handle.close).not.toHaveBeenCalled();

    innerGate.resolve();
    await inner;
    await detaching;

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(slot.inFlightCount).toBe(0);
    expect(slot.ownerCount).toBe(0);
  });

  it("decrements the count when the scope throws", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    await expect(
      slot.withScope(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(slot.inFlightCount).toBe(0);
  });

  it("reports the handle from inside the scope", async () => {
    const handle = fakeHandle();
    const slot = slotWith(handle);

    const seen = await slot.withScope(async () => slot.inFlightCount);

    expect(seen).toBe(1);
    expect(slot.ownerCount).toBe(0);
    expect(slot.isDraining).toBe(false);
  });
});

/**
 * A handle whose first `close` throws and whose second one lands: the first drain runs the throw,
 * every later drain runs the close. The call counter stays separate from the `mock` call list so
 * the throw lands once, not once per assertion.
 */
function throwingHandle(): { readonly close: Mock<() => void>; readonly open: () => boolean } {
  let open = true;
  let calls = 0;
  const close = vi.fn<() => void>(() => {
    calls += 1;
    if (calls === 1) throw new Error("close failed");
    open = false;
  });
  return { close, open: () => open };
}

describe("StoreLifecycleSlot — a close that throws", () => {
  it("rejects the first detach and stays usable for the next owner", async () => {
    const handle = throwingHandle();
    const slot = new StoreLifecycleSlot({ close: handle.close, isOpen: handle.open });
    slot.attach(tokenA);

    await expect(slot.detach(tokenA)).rejects.toThrow("close failed");

    expect(slot.isDraining).toBe(false);
    expect(slot.ownerCount).toBe(0);
    expect(handle.open()).toBe(true);

    slot.attach(tokenB);
    await expect(raced(slot.detach(tokenB), "timeout")).resolves.toBeUndefined();

    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(handle.open()).toBe(false);
  });

  it("settles the waiting detach and release when the throw lands mid-drain", async () => {
    const handle = throwingHandle();
    const slot = new StoreLifecycleSlot({ close: handle.close, isOpen: handle.open });
    slot.attach(tokenA);
    const gate = deferred();
    const scope = slot.withScope(async () => {
      await gate.promise;
    });
    const detaching = slot.detach(tokenA);
    const releasing = slot.release();

    gate.resolve();

    await expect(scope).rejects.toThrow("close failed");

    expect(await raced(detaching, "timeout")).not.toBe("timeout");
    expect(await raced(releasing, "timeout")).not.toBe("timeout");
    expect(slot.isDraining).toBe(false);
    expect(slot.ownerCount).toBe(0);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.open()).toBe(true);
  });
});
