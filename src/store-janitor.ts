/**
 * The store janitor — the store's PERIODIC maintenance item, wired to the lifecycle events that are
 * OFF the tool-call hot path. Ticket #90; the open-time half is `src/hash-store.ts`'s stamp-gated
 * sweep, which this module REUSES rather than restates (see the exported `*_SQL` predicates there).
 *
 * WHAT ONE RUN DOES, in order, and why that order:
 * 1. THROTTLE — `periodicDue(db, JANITOR_META_KEY, intervalMs, now)`, the primitives the served-mirror
 *    prune already uses (#87c). Not due means the run ends here, having issued no DELETE and no
 *    `PRAGMA quick_check`. The interval is resolved from the shared config ladder
 *    (`src/store-config.ts`), defaulting to a day.
 * 2. GC — foreign-generation and expired rows, deleted in statements of at most `batchSize` rows.
 *    Batching is about HOLD TIME, not statement count: one unbounded DELETE scans and holds the write
 *    lock for its whole scan, so a rival writer waits on a maintenance pass; a loop of bounded
 *    statements releases the lock between batches and lets a rival interleave. The batch width
 *    defaults to 64, the width the snapshot store already deletes in (`STAT_BATCH`).
 * 3. MARK — `markPeriodicRun` records the run, and it is written BEFORE the deep check because a
 *    detected failure may close this connection (step 4).
 * 4. DEEP CHECK — the open path's own `PRAGMA quick_check` (`isHealthy`, never reimplemented), on a
 *    store the fast path no longer checks (PR #101 replaced it there with the header smoke check).
 *    A failing check routes into `healUnhealthyStore`, the janitor's orchestration over the one
 *    `quarantineStore` primitive; the open path's own recovery is its other caller.
 *
 * NO CHECKPOINT HERE, deliberately: `shutdownDb` owns `PRAGMA wal_checkpoint(TRUNCATE)`, registered
 * once by `openStore` on `exit`, `SIGINT` and `SIGTERM`. The janitor therefore adds no second
 * checkpoint site and no second owner of the same WAL; its writes ride the WAL and are truncated by
 * the close path that already truncates it, and `wal_checkpoint(TRUNCATE)` on an already-truncated
 * WAL is a no-op. One writer, one checkpoint, measured on close — see the report for the WAL numbers.
 *
 * THE #90 / #100 BOUNDARY, stated here in this module's own header. Issue #100's three clauses, its
 * own words: "not detected at open, not quarantined at use, not healed on reopen."
 * - CLOSED HERE: "not detected at open" — the fast path stopped running `PRAGMA quick_check` (#87c),
 *   so page-level damage was detected by nothing at all; this janitor detects it periodically, on a
 *   store the fast path accepts.
 * - CLOSED HERE: "not healed on reopen" — a detected failure routes into the SAME quarantine-and-
 *   rebuild the open path performs (`healUnhealthyStore`), so the store is rebuilt rather than left
 *   damaged until someone deletes it by hand.
 * - LEFT TO #100: "not quarantined at use" — nothing triggers on the FIRST FAILING STATEMENT. A
 *   statement that hits a damaged page still surfaces its own error and leaves the file damaged until
 *   the next janitor run. That is a USE-TIME trigger, #100's own scope; this module must not grow a
 *   half-implemented one, and it does not.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DANGLING_LEASE_SQL,
  FOREIGN_GENERATION_LEASE_SQL,
  FOREIGN_GENERATION_SNAPSHOT_SQL,
  ORPHAN_LINEAGE_SQL,
  healUnhealthyStore,
  isHealthy,
  loadHashStore,
  markPeriodicRun,
  periodicDue,
  withBusyRetry,
} from "./hash-store.js";
import { resolveStoreJanitorSettings, type StoreJanitorSettings } from "./store-config.js";
import type { ConfigOnWarn } from "./json-config.js";
import { VACUUM_RETIRED_PIN_MS } from "./snapshot-store";
import { reportDiagnostic } from "./diagnostics.js";

/**
 * The `meta` key recording when the janitor last ran — the janitor's OWN row, exactly as the stamp
 * comment in `src/hash-store.ts` requires: due-ness instants never enter the store's identity stamp.
 */
export const JANITOR_META_KEY = "janitor_at";

/**
 * The lifecycle events the janitor is wired to: the two that are OFF the tool-call hot path.
 * `session_shutdown` (reason quit|reload|new|resume|fork) had no consumer in this repo before this
 * module, so it is wired deliberately: it is the one event that fires while a session's work is
 * finished and before the runtime is torn down, which is where a maintenance pass belongs.
 *
 * NEVER SUBSCRIBE THIS JANITOR TO — the hot path, where a janitor run would be paid by every tool
 * call of the session and could hold the write lock a call is waiting on:
 *   `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`,
 *   `tool_execution_end`, `context`, `before_provider_request`.
 * These are forbidden, not merely unused: a run there is the latency regression #90 exists to avoid,
 * so a future reader adding one must see that it is prohibited rather than think it is untried.
 * A background timer is not an option either: the extension API exposes no idle timer and no
 * `deactivate` event, so a timer-based trigger is impossible rather than unimplemented.
 */
export const JANITOR_EVENTS = ["session_start", "session_shutdown"] as const;

/** The rows one janitor run removed, per family. */
interface JanitorDeletions {
  readonly snapshots: number;
  readonly lineage: number;
  readonly leases: number;
  readonly expiredLeases: number;
}

export interface JanitorOutcome {
  /** Whether the run happened at all. `false` means the throttle or the mode said no. */
  readonly ran: boolean;
  readonly reason?: "off" | "throttled";
  readonly deleted: JanitorDeletions;
  /** Whether the run's deep check found the store damaged (only ever set on a run that happened). */
  readonly deepCheckFailed: boolean;
  /** Whether the store was handed to the open path's quarantine-and-rebuild. */
  readonly rebuilt: boolean;
}

const NOTHING_DELETED: JanitorDeletions = {
  snapshots: 0,
  lineage: 0,
  leases: 0,
  expiredLeases: 0,
};

function skipped(reason: "off" | "throttled"): JanitorOutcome {
  return { ran: false, reason, deleted: NOTHING_DELETED, deepCheckFailed: false, rebuilt: false };
}

/**
 * Delete every row a predicate names, at most `batchSize` rows per statement, returning the count.
 * The statement is re-prepared per batch so no state is held between them, and each batch carries
 * the store's own busy budget (`withBusyRetry`) rather than the janitor inventing a retry.
 *
 * WHY `rowid IN (SELECT rowid ... LIMIT ?)`: `DELETE ... LIMIT` needs a SQLite build option this
 * runtime does not guarantee, while every table here is an ordinary rowid table, so the bounded
 * delete is spelled with a subquery instead. `table` admits only `JanitorTable` members, so the
 * two interpolated table slots cannot name a table no call site passes (#105 rider).
 *
 * A short final batch ends the loop: no statement re-reads rows it could have deleted twice, because
 * nothing in this store re-creates foreign-generation or expired rows while a janitor run is open.
 */
/** The only tables the janitor's batched deletes may name (#105 rider). */
type JanitorTable = "file_snapshots" | "line_lineage" | "served_leases";

function deleteInBatches(
  db: DatabaseSync,
  table: JanitorTable,
  predicate: string,
  params: readonly (string | number)[],
  batchSize: number,
): number {
  const sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`;
  let deleted = 0;
  for (;;) {
    const changes = withBusyRetry(() => {
      const result = db.prepare(sql).run(...params, batchSize);
      return Number(result.changes);
    });
    deleted += changes;
    if (changes < batchSize) return deleted;
  }
}

/**
 * ONE janitor run against an OPEN store, with `now` injected so the throttle is judged from the
 * caller's clock rather than from whatever the host's is doing. Sync on purpose: every statement it
 * issues is synchronous, so a caller can drive it from a test without touching the event loop.
 */
export function runJanitor(input: {
  readonly db: DatabaseSync;
  readonly now: number;
  readonly settings: StoreJanitorSettings;
}): JanitorOutcome {
  const { db, now, settings } = input;
  if (settings.mode === "off") return skipped("off");
  if (!periodicDue(db, JANITOR_META_KEY, settings.intervalMs, now)) return skipped("throttled");

  const batchSize = settings.batchSize;
  // WHY: the generation family, in the sweep's own order: leases are swept before the snapshots they
  // WHY: name (a lease whose snapshot a later batch removes is swept as dangling), and lineage after
  // WHY: the snapshots that cascade it. All four predicates are the sweep's, imported — not restated.
  const deletions = collectGarbage(db, now, batchSize);

  // WHY: the mark is written only by a run whose GC COMPLETED: the primitives' contract is that
  // WHY: "ran" means "did something", and a sweep that threw did not — so a failed sweep stays due
  // WHY: and is retried at the next lifecycle event instead of being hidden for a full interval.
  // WHY: the mark precedes the deep check because a detected failure may close this connection.
  if (deletions !== undefined) markPeriodicRun(db, JANITOR_META_KEY, now);

  // WHY: the deep check runs even when the GC threw, and that ordering is the point of ticket #100:
  // WHY: a store whose pages are damaged is exactly a store the GC may fail on, and detection must
  // WHY: not be conditional on the cleanup it is meant to trigger a heal for.
  return {
    ran: true,
    deleted: deletions ?? NOTHING_DELETED,
    deepCheckFailed: !isHealthy(db),
    rebuilt: false,
  };
}

/**
 * The janitor's cleanup half: foreign-generation and expired rows, in bounded batches. `undefined`
 * means a statement threw, which the caller reports as "nothing was removed" — a store damaged
 * enough to fail a DELETE is the case the deep check exists for, so the failure is swallowed here
 * and reported there rather than thrown out of a lifecycle hook.
 */
function collectGarbage(
  db: DatabaseSync,
  now: number,
  batchSize: number,
): JanitorDeletions | undefined {
  try {
    const leases = deleteInBatches(
      db,
      "served_leases",
      FOREIGN_GENERATION_LEASE_SQL,
      [],
      batchSize,
    );
    const snapshots = deleteInBatches(
      db,
      "file_snapshots",
      FOREIGN_GENERATION_SNAPSHOT_SQL,
      [],
      batchSize,
    );
    const lineage = deleteInBatches(db, "line_lineage", ORPHAN_LINEAGE_SQL, [], batchSize);
    const dangling = deleteInBatches(db, "served_leases", DANGLING_LEASE_SQL, [], batchSize);
    const expiredLeases = deleteInBatches(
      db,
      "served_leases",
      "retired_at IS NOT NULL AND retired_at < ?",
      [now - VACUUM_RETIRED_PIN_MS],
      batchSize,
    );
    return { snapshots, lineage, leases: leases + dangling, expiredLeases };
  } catch (error) {
    // SAFETY: a failed sweep removes nothing and is retried by the next due run; the deep check below
    // SAFETY: is what decides whether this store needs the open path's recovery instead.
    reportDiagnostic("store-janitor", "[store-janitor] GC pass failed:", error);
    return undefined;
  }
}

export interface JanitorPassOptions {
  /** The directory the config ladder resolves against; defaults to the process cwd. */
  readonly cwd?: string;
  /** The instant the throttle and the retirement grace are judged at; defaults to `Date.now()`. */
  readonly now?: number;
  /** Resolved knobs, for a caller that already read them (and for tests). */
  readonly settings?: StoreJanitorSettings;
  /** The open store, for a caller that already holds one (and for tests). */
  readonly db?: DatabaseSync;
  readonly onWarn?: ConfigOnWarn;
  /** The heal step, injectable so a test can observe a detected failure without damaging a store. */
  readonly heal?: () => Promise<boolean>;
}

/**
 * A full janitor pass: resolve the knobs, open the store if the caller has none, run once, and hand a
 * damaged store to the open path's recovery. Never throws for a store problem — the caller here is a
 * lifecycle hook, and a maintenance item must not break the session it runs in.
 */
export async function janitorPass(options: JanitorPassOptions = {}): Promise<JanitorOutcome> {
  const settings =
    options.settings ?? resolveStoreJanitorSettings(options.cwd ?? process.cwd(), options.onWarn);
  // WHY: the early return: mode `off` means "leave this store untouched", so it must not even OPEN
  // WHY: the store — an open is the store's own maintenance boundary (sweep, TTL prune, vacuum).
  if (settings.mode === "off") return skipped("off");

  const db = options.db ?? (await loadHashStore()).db;
  const outcome = runJanitor({ db, now: options.now ?? Date.now(), settings });
  if (!outcome.ran || !outcome.deepCheckFailed) return outcome;

  const healed = await (options.heal ?? (() => healUnhealthyStore()))();
  return { ...outcome, rebuilt: healed };
}

export interface JanitorHookDeps {
  /** The pass one lifecycle event triggers; overridden in tests so wiring can be observed. */
  readonly runJanitor: () => Promise<JanitorOutcome>;
}

/**
 * Wire the janitor to `JANITOR_EVENTS`. Both handlers are the same best-effort pass: a failure is
 * reported to stderr and swallowed, because the session's own work must not fail with maintenance.
 *
 * WHY `session_shutdown` is wired even though the runtime is being torn down: on `quit` the exit path
 * still runs `shutdownDb` (the WAL checkpoint's single owner), and the pass itself is synchronous
 * SQLite work with no awaits of its own inside the run — a handler that cannot finish simply leaves
 * the throttle row unwritten, and the next session_start runs the sweep instead.
 */
export function registerJanitorHooks(
  pi: ExtensionAPI,
  overrides: Partial<JanitorHookDeps> = {},
): void {
  const deps: JanitorHookDeps = {
    runJanitor: () => janitorPass(),
    ...overrides,
  };
  const onEvent = async (): Promise<void> => {
    try {
      await deps.runJanitor();
    } catch (error) {
      // SAFETY: best-effort maintenance — a failed janitor run leaves the store exactly as it was
      // SAFETY: (every step is idempotent and its own work is its own throttle record), so the
      // SAFETY: session continues and the next lifecycle event retries.
      reportDiagnostic("store-janitor", "[store-janitor] maintenance pass failed:", error);
    }
  };
  // SAFETY: `pi.on` is typed per event name while `JANITOR_EVENTS` is a runtime tuple, so the
  // SAFETY: registration needs the same string-key widening the entry point already uses; the
  // SAFETY: handler's `(event, ctx) => Promise<void>` shape is what every lifecycle event accepts.
  const register = (pi as unknown as { on: (event: string, handler: () => Promise<void>) => void })
    .on;
  for (const event of JANITOR_EVENTS) {
    // SAFETY: narrowed to the handler signature the widened `on` above declares.
    register.call(pi, event, onEvent);
  }
}
