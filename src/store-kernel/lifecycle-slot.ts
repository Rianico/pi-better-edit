import { AsyncLocalStorage } from "node:async_hooks";

/**
 * SAFETY: store-kernel/lifecycle-slot — the one place that decides WHEN the store handle closes.
 *
 * Exactly two things keep the handle open: attached owners and in-flight scopes. A close runs
 * through the injected `close` at most once per drain, and only while `isOpen()` still reports a
 * live handle, so the slot cannot double-close a connection it does not own.
 *
 * WHEN versus THE close: this slot owns the `1 → 0` boundary that makes a close due. The injected
 * `close` (`shutdownHashStore`) owns the checkpoint and the close itself, stays callable by
 * recovery (`openStore`'s opening shutdown, both heal paths) and process teardown, and `isOpen()`
 * is the overlap guard between the two.
 */
export interface StoreLifecycleSlotOptions {
  /** Closes the open handle. Called only while `isOpen` still reports it open. */
  readonly close: () => void;
  /** Whether a handle is open. Asked once per drain, immediately before `close`. */
  readonly isOpen: () => boolean;
}

/**
 * One pending close. `finish` resolves the promise every waiter holds; `cancelled` says a new
 * owner arrived first and the handle must stay open; `closed` records that THIS drain ran the
 * close, which is the flag `release` reports; `forced` marks a drain no attach may cancel.
 */
interface Drain {
  forced: boolean;
  cancelled: boolean;
  closed: boolean;
  readonly promise: Promise<void>;
  readonly finish: () => void;
}

/**
 * The lifecycle ledger for one store handle. Reads bottom-up: `ownerCount` and `inFlightCount` are
 * the two counters, `#drain` is the single pending close, and every public method either moves a
 * counter or advances that one record.
 */
export class StoreLifecycleSlot {
  readonly #close: () => void;
  readonly #isOpen: () => boolean;
  readonly #owners = new Set<symbol>();
  readonly #scopeContext = new AsyncLocalStorage<true>();
  #inFlight = 0;
  #drain: Drain | null = null;

  constructor(options: StoreLifecycleSlotOptions) {
    this.#close = options.close;
    this.#isOpen = options.isOpen;
  }

  get ownerCount(): number {
    return this.#owners.size;
  }

  get inFlightCount(): number {
    return this.#inFlight;
  }

  get isDraining(): boolean {
    return this.#drain !== null;
  }

  /**
   * Registers an owner. Idempotent and never opens anything: the slot cannot conjure a handle, so
   * an attach at zero owners only cancels a cancellable drain — the one case where a close that
   * was already decided has to be revoked. A forced drain is never revoked.
   */
  attach(token: symbol): void {
    if (this.#owners.has(token)) return;
    this.#owners.add(token);
    if (this.#owners.size !== 1) return;
    const drain = this.#drain;
    if (drain === null || drain.forced) return;
    this.#cancelDrain(drain);
  }

  /**
   * Releases an owner. An unmatched token is a no-op. The last owner leaving starts the close: it
   * runs before this promise settles, and synchronously inside the call when no scope is in flight.
   */
  async detach(token: symbol): Promise<void> {
    if (!this.#owners.delete(token)) return;
    if (this.#owners.size > 0) return;
    await this.#beginDrain(false).promise;
  }

  /**
   * Marks work that uses the handle, so a detach's close waits for it. The scope never closes
   * anything by itself — an unowned caller stays warm across calls.
   */
  async withScope<T>(fn: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    try {
      return await this.#scopeContext.run(true, fn);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) this.#settleIdle();
    }
  }

  /**
   * Closes on behalf of a process-level teardown. Without `force` it refuses while an owner is
   * attached and otherwise joins or starts a cancellable drain; with `force` it drops every owner
   * and drains regardless. The result is `true` when this release settled its drain and closed —
   * a forced release always reports `true` once its drain settles — and `false` when an attached
   * owner refused it or a new owner cancelled the drain.
   */
  async release(options?: { force?: boolean }): Promise<boolean> {
    const force = options?.force === true;
    if (force) {
      this.#owners.clear();
    } else if (this.#owners.size > 0) {
      return false;
    }
    const drain = this.#beginDrain(force);
    await drain.promise;
    return force ? true : drain.closed;
  }

  /**
   * Waits for a pending close, except from inside this slot's own scope: the drain cannot finish
   * before that scope does, so awaiting there would wait on itself. A bare load calls this to
   * refuse reopening onto a handle that is about to close.
   */
  async awaitDrainingClose(): Promise<void> {
    if (this.#scopeContext.getStore() === true) return;
    const drain = this.#drain;
    if (drain === null) return;
    await drain.promise;
  }

  /** Advances the one pending close: reuse it, upgrade it to forced, or open it and drive it. */
  #beginDrain(forced: boolean): Drain {
    const existing = this.#drain;
    if (existing !== null) {
      if (forced) existing.forced = true;
      return existing;
    }
    let finish: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const drain: Drain = { forced, cancelled: false, closed: false, promise, finish };
    this.#drain = drain;
    if (this.#inFlight === 0) this.#finishDrain(drain);
    return drain;
  }

  #finishDrain(drain: Drain): void {
    try {
      if (!drain.cancelled && this.#isOpen()) {
        this.#close();
        drain.closed = true;
      }
    } finally {
      if (this.#drain === drain) this.#drain = null;
      drain.finish();
    }
  }

  #cancelDrain(drain: Drain): void {
    drain.cancelled = true;
    if (this.#drain === drain) this.#drain = null;
    drain.finish();
  }

  #settleIdle(): void {
    const drain = this.#drain;
    if (drain !== null) this.#finishDrain(drain);
  }
}
