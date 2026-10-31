# ADR-0037 — The store janitor: lifecycle-triggered, throttled, batched GC with one deep check and one checkpoint

Date: 2026-10-11

## Status

accepted — the design record for issue [#90](https://github.com/Rianico/pi-better-edit/issues/90), written against what landed, in `src/store-janitor.ts`, `src/store-config.ts`, `src/json-config.ts` and the predicates exported from `src/hash-store.ts`. It says what those modules DO, not what the ticket proposed; where the ticket's brief and the code disagree, the code is the record and the disagreement is stated. It leaves [ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md) intact and adds the periodic item above its vacuum; it relies on [ADR-0031](0031-file-scoped-anchors-residual-and-generation-discipline.md)'s generation discipline for what "foreign" means. No earlier ADR is superseded.

Amended 2026-10-14 (Issue #94): the write path's enum guards throw `E_INTERNAL_INVARIANT`,
not `E_BAD_PAYLOAD` — they are defensive checks that no caller can reach, since the command and
the settings overlay narrow every value to the enum.

Amended 2026-10-28 (Issue #190): the paths in this record are superseded by
[ADR-0050](0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md), which moves settings to
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-better-edit/settings.json` and state to
`${XDG_STATE_HOME:-~/.local/state}/pi-better-edit`. §8's global default
`~/.config/pi-better-edit/pi-better-edit.json` and its store-directory paragraph are superseded; the
rest of this record — the triggers, the throttle, the batched deletes, the deep check and the WAL
owner — stands as written.

## Context

### The promise this record pays off

The stamp-gated open (#87c, PR #101) made a healthy open lock-free by moving the generation sweep off the per-open path, and the fast path stopped running `PRAGMA quick_check` when it took a header smoke check instead. Both moves left the sweep unowned between provable events — and the store's own comment said so. Verbatim at `733003b` (`src/hash-store.ts:449-453`):

> `- PERIODIC BOUND: DESIGN-COMMITTED AND NOT YET IMPLEMENTED. Issue #90 records it — GC on lifecycle events only, throttled to at most about once a day, never on the tool-call open path, with batched deletes, wal_checkpoint(TRUNCATE) on close and a live-store guard. That design is NOT yet in docs/ (#90 should land it there or as an ADR before this comment can cite it as a commitment rather than as an intention).`

That is the commitment this record lands. The same comment now reads `PERIODIC BOUND: IMPLEMENTED, at the lifecycle boundary this file does not own` and points here; the sentence that said the docs half was unwritten is the debt this ADR retires.

### What the open path checks, and what nothing checked

An open reads the database header: `smokeCheckStoreFile` on the fast branch, `isHealthy` (the full `PRAGMA quick_check`) only when the stamp cannot be trusted. So a store with an intact header and a poisoned row, or with page-level damage inside an otherwise well-formed file, was accepted by every open and detected by nothing. #100 is the ticket for that exposure; its three clauses are its own words: "not detected at open, not quarantined at use, not healed on reopen."

### The trigger the API actually offers

The extension API exposes 36 `on(event, ...)` overloads. There is **no `deactivate` event and no idle timer** in that surface (measured at this commit: `grep -c 'on(event: "' node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` → `36`; no `deactivate` member, no timer API). A background timer is therefore **impossible, not merely unimplemented** — which is why the periodic bound had to be hung on an event, and why the choice of event became load-bearing.

## Decision

### 1. Triggers: `session_start` and `session_shutdown` only

`JANITOR_EVENTS` (`src/store-janitor.ts:81`) is exactly `["session_start", "session_shutdown"]`, and `registerJanitorHooks` (wired once from `index.ts`) subscribes to those two and nothing else. Both are off the tool-call hot path: `session_start` is the boundary an open already owns, and `session_shutdown` (reason `quit|reload|new|resume|fork`) fires while a session's work is finished and before the runtime is torn down, where a maintenance pass belongs. `session_shutdown` had **no consumer in this repository** before this change; the janitor is its first.

Both handlers are the same best-effort `janitorPass`, whose failure is reported to stderr and swallowed: a maintenance item must not fail the session it runs in. On `quit` the exit path still runs `shutdownDb`, and the pass is synchronous SQLite work; a handler that cannot finish leaves its throttle row unwritten, and the next `session_start` sweeps instead.

### 2. Never subscribe the janitor to the hot path

`tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `context`, `before_provider_request`. These are a **prohibition, not an untried option**: a run there is paid by every tool call of the session and could hold the write lock a call is waiting on — the latency regression #90 exists to avoid. The list is stated at `JANITOR_EVENTS` so a future reader adding one sees it forbidden.

### 3. The throttle, its interval and its own meta row

One run is gated by the primitives the served-mirror prune already uses (`periodicDue`/`markPeriodicRun`, exported from `src/hash-store.ts`); the janitor adds no second throttle mechanism. It keeps its **own** `meta` row, `JANITOR_META_KEY = "janitor_at"` (epoch ms), rather than sharing the stamp: the comment on the identity stamp requires that no time-varying state be folded in, because a stamp mismatch must mean "the store's identity moved", never "maintenance is due".

- `periodicDue` returns `true` when the row is absent, its value is non-finite, or `now - last >= intervalMs`; on any exception it returns `true` (conservative — a broken read must not silently suppress maintenance).
- The interval comes from the `store.janitorIntervalMs` ladder, defaulting to **one day** (`STORE_JANITOR_INTERVAL_DEFAULT_MS`, `src/store-config.ts`).
- `markPeriodicRun` (whose upsert runs under `withBusyRetry`) is written **only by a run whose GC completed** (`deletions !== undefined`, `src/store-janitor.ts:169`), because "ran" means "did something": a sweep that threw stays due and is retried at the next lifecycle event instead of being hidden for a full interval. The mark precedes the deep check, because a detected failure may close that connection.
- `mode: "off"` short-circuits before anything opens the store — an open is itself a maintenance boundary (sweep, TTL prune, vacuum), so "leave this store untouched" must not pay for one.

### 4. Batched deletes: batching is about hold time

Each family is deleted by `deleteInBatches`, in statements of at most `store.janitorBatchSize` rows (default **64**, the width `STAT_BATCH` already deletes in, `src/snapshot-store/index.ts:822`). Transaction **hold time** is what produces `SQLITE_BUSY`, not transaction count: one unbounded `DELETE` scans and holds the write lock for its whole scan, so a rival writer waits on a maintenance pass; a loop of bounded statements releases the lock between batches and lets a rival interleave. Each batch carries the store's own busy budget (`withBusyRetry`) rather than the janitor inventing a retry.

The bounded delete is spelled `DELETE FROM <table> WHERE rowid IN (SELECT rowid FROM <table> WHERE <predicate> LIMIT ?)` because `DELETE ... LIMIT` needs a SQLite build option this runtime does not guarantee, and every table here is an ordinary rowid table. The statement is re-prepared per batch so no state is held between them, and a short final batch ends the loop — nothing in this store re-creates foreign-generation or expired rows while a run is open.

### 5. The predicates are the sweep's own statements, imported

The generation and provenance predicates are **exported SQL fragments in `src/hash-store.ts`** — `FOREIGN_GENERATION_SNAPSHOT_SQL` (`anchor_generation != ${ANCHOR_GENERATION}`), `FOREIGN_GENERATION_LEASE_SQL` (`served_snapshot_hash NOT LIKE '%:${ANCHOR_GENERATION}:%'`), `ORPHAN_LINEAGE_SQL` (`snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)`), `DANGLING_LEASE_SQL` (no surviving **committed** `file_snapshots` row for the lease's own path and hash) — and **both** sweeps import them: the open-time `sweepGenerations` and the janitor's `collectGarbage`.

A parallel rule was refused. A second hand-written copy of any predicate is exactly how an open-time sweep and a periodic one drift into deleting different row sets, and "the swept rows" stops being one set that a reviewer can reason about. `ANCHOR_GENERATION = 1` (`src/hashline/hash-identity.ts`); the middle component of the 3-part served snapshot hash is the anchor generation, so a canon-only change keeps leases while a generation change sweeps them. The expired family reuses the vacuum's own `VACUUM_RETIRED_PIN_MS` grace rather than a janitor-local number.

### 6. The deep check is the periodic half of #100

`isHealthy` — the open path's own `PRAGMA quick_check`, whose visibility was widened to `export` rather than a second `quick_check` being written — runs after the GC on every run that happened, **even when the GC threw** (`src/store-janitor.ts`): a store whose pages are damaged is exactly a store the GC may fail on, and detection must not be conditional on the cleanup it is meant to trigger a heal for.

Against #100's three clauses, in its own words:

- **Closed here: "not detected at open."** The fast path stopped running `quick_check` (#87c), so page-level damage was detected by nothing at all; the janitor detects it periodically, on a store the fast path accepts.
- **Closed here: "not healed on reopen."** A detected failure routes into `healUnhealthyStore` (`src/hash-store.ts`), whose own sequence — re-check `isHealthy` (so it can never quarantine a healthy store), `shutdownHashStore`, `quarantineStore`, `openStore` — reaches the **one quarantine implementation**, `quarantineStore` (a single definition). That primitive has **two orchestrations**, not one: the open path's own recovery and this heal, each calling it with its own sequence. "Reuse" here means the primitive is shared; it is not a claim that either orchestration is the only recovery path, nor that one invokes the other.
- **Left to #100: "not quarantined at use."** Nothing triggers on the **first failing statement**. A statement that hits a damaged page still surfaces its own error and leaves the file damaged until the next janitor run. That is a use-time trigger, #100's own scope; this tranche must not grow a half-implemented one, and it does not.

### 7. The checkpoint: one owner, already complete

`shutdownDb` (`src/hash-store.ts`) owns `PRAGMA wal_checkpoint(TRUNCATE)` and the `db.close()`, registered **once** by `openStore` via `process.once("exit", ...)` and `process.once("SIGINT"|"SIGTERM", ...)`. Measured with a bundled probe (20k rows, ~4MB WAL) at the previous group's head: an explicit `shutdownHashStore()`, `process.exit(0)`, a `SIGTERM` and a `SIGINT` all truncate the WAL to non-existent.

The janitor therefore adds **no** checkpoint site and no second owner of the WAL. Its writes ride the WAL like any other writer's and are truncated by the close path that already truncates it; `wal_checkpoint(TRUNCATE)` on an already-truncated journal is a no-op, so the two cannot double-charge. Ticket #90's "`wal_checkpoint(TRUNCATE)` on close" clause is a **reconciliation, not new work**: the checkpoint was already complete, and this ADR records the division of labour rather than a second implementation.

### 8. The config ladder, and the one key that is deliberately absent

The janitor's knobs live in the same JSON seam the lens bridge uses — `<project>/.pi/agents/pi-better-edit.json` (project) and `<configDir>/pi-better-edit.json` (global, default `~/.config/pi-better-edit/pi-better-edit.json`) — resolved **per key** through one ladder: environment, then project file, then global file, then the default. The global file moved out of `~/.pi/agents/` after this record was accepted: a file left there is adopted on first read (written to the new location, renamed `.bak`), so the precedence order is unchanged. Both paths are themselves superseded by [ADR-0050](0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md): the project file is now `<project>/.pi/agents/pi-better-edit/settings.json` and the global file `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-better-edit/settings.json`, with this record's ladder order unchanged.

| setting | file key | env override | default |
|---|---|---|---|
| janitor on/off | `store.janitor` | `PI_BETTER_EDIT_STORE_JANITOR` | `on` |
| throttle interval | `store.janitorIntervalMs` | `PI_BETTER_EDIT_STORE_JANITOR_INTERVAL_MS` | 86400000 |
| delete batch width | `store.janitorBatchSize` | `PI_BETTER_EDIT_STORE_JANITOR_BATCH_SIZE` | 64 |

- A value outside its accepted shape is ignored (whole numbers ≥ 1 only for interval and batch: a fractional, zero or negative interval would silently turn every open into a sweep, and a batch of zero rows deletes nothing and reports success). An env value outside its shape loses to the file's rung for **its own key** only.
- The file, the two scopes, the read and the preserving atomic write are **extracted** into the neutral `src/json-config.ts`, which both settings owners import. That is a boundary requirement, not a taste: `test/arch/lens-bridge-boundary.test.ts` forbids importing `src/integrations/pi-lens` from outside that directory, so a second hand-rolled ladder was the alternative. The read/write contract has one owner; owners keep their own keys.
- **The read degrades with a warning, never throws.** `readConfigObject` catches both `readFileSync` and `JSON.parse`; a missing file is the ordinary "not configured" state and warns about nothing, while a file that **exists** but cannot be read, parsed, or has a non-object root is reported through the new optional `onWarn` and the values fall through the ladder. The lens-bridge path passes no `onWarn` and keeps its silent read, because a hand-edited file must never make a bridge read noisy.
- **There is deliberately no store-directory key.** `PI_BETTER_EDIT_CONFIG_DIR` alone owns the store path (`configDir`/`configDirOverride` in `src/hash-store.ts`, read verbatim, empty counting as unset, precedence over `XDG_CONFIG_HOME` and `$HOME/.config`). A config file must not be able to move the store — an operator/security decision, owner-ruled — so `store.dir` is an unknown key like any other: preserved on write, ignored on read, resolving to nothing. `test/core/store-config.test.ts` pins that the path stays on the variable alone. The store's **location** is superseded by [ADR-0050](0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md): the default is now `${XDG_STATE_HOME:-~/.local/state}/pi-better-edit`, the override owns `<override>/state`, and `XDG_CONFIG_HOME` no longer participates. The rule in this paragraph — no config-file key can move the store, and the override is read verbatim — still stands.
- Ticket #90's title says "yaml"; there is **no yaml config surface anywhere** in this repository — the only `.yaml` file is `pnpm-lock.yaml` — and the seam is JSON. The title has since been corrected to "JSON/env config seam". The "configurable store directory" as a test-isolation lever (#89) is not this: the lever is the env variable, which already existed.

The published schema (`schemas/pi-better-edit.json`) gains the `store` object with root and per-object `additionalProperties: true`, so an owner's keys need no schema change to be written, only to be validated. The write path (`saveStoreJanitorConfig` → `updateConfigFile`) rebuilds `$schema`, then spreads the existing object, so unknown keys, sibling `store.*` keys and the `lens` block survive; it throws `E_INTERNAL_INVARIANT` and writes nothing for a value outside its accepted shape, because a silently dropped value reads back as a default.

## Invariants GC must not break

- **Current-generation rows survive.** The predicates are generation- and provenance-scoped; a current-generation snapshot and a live lease are not named by any of them.
- **Pinned rows survive.** A snapshot a live `served_leases` row can still resolve to, a snapshot named by `file_undo.snapshot_hash`, and one retired within `VACUUM_RETIRED_PIN_MS` (1 hour) are the vacuum's pin set ([ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md)); the janitor's predicates are narrower than that pin set, so a GC pass cannot take a pinned row the vacuum would keep.
- **Counters never rewind.** `line_id_counters` is never deleted for a live path: a rewound counter would hand a live anchor's `line_id` to a different line ([ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md)). The janitor deletes lineage rows and never the counters behind them.
- **A live workspace's store is not destroyed.** The guard is structural rather than a live-hash set (the sibling project's shape): the janitor runs **only** at a lifecycle boundary, where no tool call of this session is in flight, and the one quarantine implementation it reaches (`quarantineStore`, through `healUnhealthyStore`) does not touch a store currently inside a transaction of its own. Combined with the disposable-cache invariant below, no live session can be reading the rows a pass removes.
- **The disposable-cache invariant.** Everything a GC pass or a heal drops is **re-derivable**: the served mirror, the snapshots and their lineage are rebuilt from the files on disk. That is why GC is safe by construction here rather than gated on a live-workspace set, and it is the same property the open path's own corruption recovery relies on.
- **The `served` table carries no generation.** Its `snapshotId` is a load-epoch string, and no generation predicate can judge it. TTL pruning at open owns it (`servedPruneOlderThan`, behind the same `periodicDue` throttle with key `served_prune_at`, `src/served-session/session.ts`) — and the 7-day `SERVED_TTL_MS` lease TTL is **unchanged** by this tranche, as is the vacuum's 50 MB / versions-per-path retention policy.

## Who owns each knob

| knob | owner | not owned by |
|---|---|---|
| janitor on/off, interval, batch width | the `store.*` ladder (`src/store-config.ts`) over `env > project > global > default` | a hard-coded constant at a call site |
| janitor due-ness instant | the janitor's own `meta` row (`janitor_at`) | the identity stamp, and the served-mirror prune's row |
| the store **path** | `PI_BETTER_EDIT_CONFIG_DIR` (verbatim, empty = unset) | any config file key |
| snapshot retention (50 MB budget, versions per path, pin set) | the vacuum ([ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md), `src/snapshot-store/vacuum.ts`) | the janitor |
| served-mirror TTL (7 days) and its prune cadence | `SERVED_TTL_MS` / `SERVED_PRUNE_INTERVAL_MS` (`src/constants.ts`), pruned at open | the janitor |
| the WAL checkpoint | `shutdownDb`, on `exit`/`SIGINT`/`SIGTERM` | the janitor, and every other writer |

## Consequences

- The store now has one periodic item, and it is owed to an event rather than to a timer. Anything that later wants "run this in the background" has to answer the same impossibility argument, not re-derive it.
- A damaged store is detected and rebuilt on the next lifecycle boundary rather than only when the header stops parsing. Between the first failing statement and the next boundary the file stays damaged: the error is still loud and fail-closed, and that window is #100's.
- A store opened for the first time in a session pays the janitor's pass only if the throttle says it is due; the tool-call open path pays nothing. `test/core/store-janitor.test.ts` pins that with the exec+prepare instrument reused from `test/core/hash-store-open-stamp.test.ts`: across a stamp-matching open plus the write a read/edit call performs, the janitor issues no statement, prepares no `PRAGMA quick_check` and leaves no `janitor_at` row.
- The store's maintenance is now configurable per workspace and per user with a warning channel, which means a dropped knob is visible instead of silent. The lens bridge's read stays total and silent, deliberately.
- Existing behaviour is untouched: [ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md)'s vacuum, the 7-day lease TTL, the stamp-gated open and the served-mirror prune all keep their contracts. No earlier ADR body is rewritten.

## Deferred

- **#100's use-time clause** — quarantine-and-rebuild triggered by the FIRST FAILING STATEMENT, with the failure staying loud and no false positive on a healthy store or a non-corruption error. #90's throttled deep check stays its periodic half.
- **File-per-workspace central tenancy** (`runtime/<name>-<hash8>/` plus a canonical path and sidecar) — the structural fix for cross-project contention, because separate files cannot contend. Adopt only if contention is still felt after #87 and #89; it needs canonicalisation and GC machinery of its own, and this store is already central (one file for every workspace).
- **A generation or TTL rule for the `served` table** — deliberately out of reach: its `snapshotId` carries no generation, so a generation predicate there would be a guess. Its TTL pruning at open stays the owner.
- **Provenance in the config write path** — the read side names the rung each key came from (`resolveStoreJanitorSettingsWithSources`, rendered by `/pi-better-edit lens status`); the write side names only the scope it wrote.

## Probe status

- The event-surface count (36, no `deactivate`, no idle timer) is a static reading of the installed `@earendil-works/pi-coding-agent` type declarations at this commit, not a runtime probe.
- The WAL figures (`~4MB` for 20k rows; truncate to non-existent on explicit close, `exit`, `SIGTERM` and `SIGINT`) were measured with a bundled probe at the previous group's head on this host; they are quoted from that measurement and are not re-derived here. The janitor's own WAL measurement — 40 planted rows leaving 1433792 bytes after the run, truncated to 0 by the close path — is pinned by `test/core/store-janitor.test.ts` ("leaves the WAL to the close path, measured").
- The ticket's brief and the landed code disagree in two places, both recorded above rather than smoothed over: the "yaml" seam is JSON, and the "`wal_checkpoint(TRUNCATE)` on close" clause was already satisfied before this tranche.
