# ADR-0020. Session-Scoped Store Attachment and Detachment

Date: 2026-11-26

## Status

Accepted

Amends [0005. Store Janitor Lifecycle, 7-Day Hard TTL, Compaction, and Two-Root Storage Architecture](0005-store-janitor-two-root-lifecycle.md).

Relates to [0018. Mutation Pipeline Phase Ordering Is the Atomicity Contract](0018-mutation-pipeline-phase-ordering-is-the-atomicity-contract.md) and [0001. Content-Addressed Line Identity (CAS/MVCC)](0001-content-addressed-line-identity-cas-mvcc.md)

## Context

[ADR-0005](0005-store-janitor-two-root-lifecycle.md) gives the SQLite state one root at `stateRoot()/hash-store.sqlite` and one maintenance owner, the `store janitor`. It leaves the handle's lifetime to the process: `shutdownDb` was reached only from the exit and signal handlers or a corruption rebuild, so a long-lived host kept the file and its `-wal` journal open for the whole process (the offline record is [0037](../.archive_adrs/0037-store-janitor-lifecycle-maintenance-model.md)). Two consequences follow. On Windows an open handle blocks deleting the state directory, and, before this change, a teardown ran the janitor pass on a cold session, which created `hash-store.sqlite` for a session that never used the store. A host that opens many sessions inside one process needs a release point per session, not one per process.

## Decision

We will own the handle per session: a session attaches a token on `session_start` without opening the database, and the last token to detach on `session_shutdown` closes the handle once every in-flight scope has drained.

1. **Tenancy stays single.** The process keeps one handle on `stateRoot()/hash-store.sqlite` ([ADR-0005](0005-store-janitor-two-root-lifecycle.md)). Attachment decides who may close that handle; it never changes which file is open, and it never opens one.
2. **Ownership is an idempotent `Set<symbol>`.** `StoreLifecycleSlot` holds one token per session: `attach(token)` adds it once and returns early for a known token, `detach(token)` deletes it and returns for an unknown one. `createStoreSession()` mints one `Symbol` per activation and delegates idempotence to the slot, so a forced release that clears the owners cannot strand a session's stale claim. Attach is lazy: attaching never opens the database, and a teardown never creates the file.
3. **An in-flight barrier gates the close.** Every operation that uses the handle runs inside `withScope`, which counts `#inFlight`. A close becomes due only on a real `1 → 0` transition of the owner count. With `inFlight === 0` the close runs synchronously inside the detach; otherwise the detach waits for the drain, and the close runs before `detach()` settles. A scope never closes anything on its own, so an unowned caller stays warm across calls.
4. **A drain loses to a new session, never to a forced release.** An `attach` that moves the count `0 → 1` cancels a non-forced drain; a forced drain is not cancellable. `loadHashStore` awaits `awaitDrainingClose()` before it opens or reopens, so a bare open cannot publish onto a handle that is about to close, and `reopenIfDrained` reopens when a drain closed the handle its own open scope published. `awaitDrainingClose()` returns immediately when called inside the slot's own scope: the drain cannot finish before that scope does, so awaiting there would wait on itself.
5. **The janitor pass runs before the detach.** One `session_shutdown` handler serves every reason (`quit | reload | new | resume | fork`): the maintenance pass runs first inside the drain barrier, then `afterShutdownPass` detaches in a contained `finally`, so a failing pass cannot strand the claim. The shutdown pass calls `janitorPass({ openIfCold: false })`, which reports `reason: "cold"` without opening, so a teardown never creates a cold store.
6. **Persistence survives every detach reason.** `shutdownDb` stays the only site that truncates the WAL and closes a published handle. Detachment deletes nothing: leases, snapshots, lineage rows and undo records persist across `reload`, `resume` and `fork`. A continuation under the same session key (`reload`, `resume`) resolves its leased anchors without a re-read; a `fork` opens a new session key, so its rows persist but that key resolves none of them.
7. **A raw host has an escape hatch.** `releaseHashStore(options?)` is exported from the package root. Without `force` it reports `false` while a session holds the handle, and otherwise joins or starts a cancellable drain; with `force: true` it drops every claim, drains, and reports `true`. A host that calls `AgentSession.dispose()` directly emits no `session_shutdown`, so this is its close.
8. **The same contract lifts to several stores.** A host that owns more than one store path moves to `Map<storePath, StoreLifecycleSlot>`: one slot per store, each with its own counters and close, and the same attach/detach/scope contract. This slot does not grow a multi-store mode.

### Considered Options

- **Process-exit-only close (the status quo).** Rejected: a long-lived host never releases the handle, Windows keeps the state directory locked, and a cold teardown still creates the file.
- **An idle timer.** Rejected: the host extension API exposes no idle timer and no deactivate event ([ADR-0005](0005-store-janitor-two-root-lifecycle.md)), so an idle policy has no trigger to run on.
- **Per-operation open and close.** Rejected: every tool call would pay a WAL truncate plus a contention budget against a writer that another session may hold, for a handle whose state is worth keeping warm between calls.
- **Reference counting without an in-flight barrier.** Rejected: the count can reach zero while a read or an edit still holds the handle, so the close lands mid-operation and every later statement fails with `database is not open`.
- **Closing from the tool layer.** Rejected: the owner would be the tool's caller, not the session, so two tools in one session would have to agree on a count they cannot see, and a session that runs no tool would never be released.

## Consequences

Easier: release is deterministic per session; the state directory is deletable as soon as the last session detaches, which is the Windows requirement; and one close owner (`shutdownDb`) sits behind one boundary (the slot's `1 → 0`). Harder: a shutdown now waits for in-flight scopes, so a hung scope delays `session_shutdown`; an armed edit preview must be cancelled on shutdown (`cancelArmed()`), and an in-flight compute is generation-guarded so it cannot publish after the cancel; tests must attach and detach around a store use, or run inside a scope, instead of assuming a process-wide open. Residual risk: a compute armed after the shutdown pass has run is a follow-up; today's guard covers only the cancel that arrives before the publish. Load-bearing assumption: the host emits `session_start` and `session_shutdown` for every activation. A host that disposes a raw `AgentSession` emits no shutdown, so it must call `await releaseHashStore({ force: true })`; without that call the handle stays open until process exit. Resolving a lease after a restart needs the same session key, which `resume` keeps and `fork` does not.
