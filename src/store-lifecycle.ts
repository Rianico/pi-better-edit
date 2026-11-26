import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { storeLifecycleSlot } from "./hash-store.js";
import { cachedOpenStore } from "./store-kernel/index.js";

/** Runs `fn` inside the slot's drain barrier, so a concurrent close waits for it. */
export function inStoreScope<T>(fn: () => Promise<T>): Promise<T> {
  return storeLifecycleSlot.withScope(fn);
}

/** A tool definition whose `execute` is already in the barrier; every other member is untouched. */
export function scopedTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  const execute = tool.execute;
  return {
    ...tool,
    execute: (...args: Parameters<typeof execute>) =>
      storeLifecycleSlot.withScope(async () => await execute(...args)),
  };
}

/**
 * One activation's claim on the store handle: `attach` at `session_start`, `detach` at
 * `session_shutdown`. A claim never opens SQLite, and the last claim leaving makes a close due only
 * after every in-flight scope has drained, so work that outlives the event still sees a live handle.
 */
export interface StoreSession {
  /** Claims the handle for this activation. The slot makes the repeat call a no-op; it opens nothing. */
  attach(): void;
  /** Releases the claim; the last one out drains in-flight scopes, then closes. */
  detach(): Promise<void>;
}

/**
 * One claim, owned by the caller: each call holds its OWN symbol, so two activations in one process
 * are two owners and the handle survives the first one leaving. Idempotence is the SLOT's — a known
 * token attaches once and an unknown one detaches as a no-op — so a forced release that clears the
 * owners cannot leave this session holding a claim the slot no longer knows about.
 */
export function createStoreSession(): StoreSession {
  const token = Symbol("store-session");
  return {
    attach(): void {
      storeLifecycleSlot.attach(token);
    },
    async detach(): Promise<void> {
      await storeLifecycleSlot.detach(token);
    },
  };
}

/**
 * The public close, for hosts that tear the session down WITHOUT emitting `session_shutdown` — a
 * direct `AgentSession.dispose()` is that path, so this is its close and no hook will come.
 *
 * Without `force` an attached session wins: the handle is that session's to release, so the call
 * reports `false` and changes nothing. The answer is probed from the handle itself rather than from
 * the slot, because a racing attach cancels the drain and leaves a live store behind — that is
 * also a `false`. `force` drops every claim, drains, and reports `true`.
 */
export async function releaseHashStore(options: { force?: boolean } = {}): Promise<boolean> {
  if (options.force === true) return storeLifecycleSlot.release({ force: true });
  if (storeLifecycleSlot.ownerCount > 0) return false;
  await storeLifecycleSlot.release();
  const cached = cachedOpenStore();
  return cached === null || !cached.db.isOpen;
}
