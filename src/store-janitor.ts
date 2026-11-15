/**
 * The store janitor — the store's PERIODIC maintenance item on lifecycle events that are OFF the
 * tool-call hot path (ticket #90); its open-time half is `src/hash-store.ts`'s stamp-gated sweep, REUSED.
 * ONE RUN, in order: THROTTLE (`due`, #87c — not due ends it: no DELETE, no `quick_check`);
 * GC of foreign-generation, dangling and expired rows in batches of at most `batchSize` — batching is
 * HOLD TIME, not statement count, since one unbounded DELETE holds the write lock for its whole scan —
 * expiry covering BOTH terminal states (docs/.archive_adrs/0045-ttl-ends-lease-resolution.md); MARK (`markRun`, before the deep check, which may
 * close this connection); DEEP CHECK (`isHealthy`, never reimplemented, on a store the fast path stops
 * checking — PR #101), a failure routing into `healUnhealthyStore` over the one `quarantineStore`.
 * NO checkpoint here: `shutdownDb` owns the only `wal_checkpoint(TRUNCATE)` (docs/.archive_adrs/0037-store-janitor-lifecycle-maintenance-model.md holds the model).
 * #90 / #100: "not detected at open" and "not healed on reopen" CLOSE HERE; "not quarantined at use" — the FIRST FAILING STATEMENT — is LEFT TO #100.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DANGLING_LEASE_SQL,
  EXPIRED_ACTIVE_LEASE_SQL,
  FOREIGN_GENERATION_LEASE_SQL,
  FOREIGN_GENERATION_SNAPSHOT_SQL,
  ORPHAN_LINEAGE_SQL,
  healUnhealthyStore,
  isHealthy,
  loadHashStore,
  servedLeaseExpiryCutoff,
} from "./hash-store.js";
import { isBusyError, markRun, due, withBusyRetry } from "./store-kernel/index.js";
import { resolveStoreJanitorSettings, type StoreJanitorSettings } from "./store-kernel/settings.js";
import type { ConfigOnWarn } from "./json-config.js";
import { VACUUM_RETIRED_PIN_MS } from "./snapshot-store";
import { diagnosticsLogPath, reportDiagnostic, reportInfo, reportWarning } from "./diagnostics.js";
import {
  JANITOR_WARNING_PREFIX,
  formatJanitorWarning,
  type JanitorWarning,
} from "./store-janitor-warning.js";

/**
 * The `meta` key recording when the janitor last ran — the janitor's OWN row, exactly as the stamp
 * comment in `src/hash-store.ts` requires: due-ness instants never enter the store's identity stamp.
 */
export const JANITOR_META_KEY = "janitor_at";

/**
 * The lifecycle events the janitor is wired to: the two that are OFF the tool-call hot path.
 * `session_shutdown` (reason quit|reload|new|resume|fork) is wired deliberately: it is the one event
 * that fires while a session's work is finished and before the runtime is torn down.
 * NEVER SUBSCRIBE THIS JANITOR TO the hot path — `tool_call`, `tool_result`,
 * `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `context`,
 * `before_provider_request` — where a run would be paid by every tool call and could hold the write
 * lock a call is waiting on. These are forbidden, not merely unused: the latency regression #90
 * exists to avoid. A timer is not an option either: the extension API exposes no idle timer and no
 * `deactivate` event, so a timer-based trigger is impossible rather than unimplemented.
 */
export const JANITOR_EVENTS = ["session_start", "session_shutdown"] as const;

/** The rows one janitor run removed, per family. */
interface JanitorDeletions {
  readonly snapshots: number;
  readonly lineage: number;
  readonly leases: number;
  /** Lease rows removed for expiry: active past the session TTL plus retired past the grace. */
  readonly expiredLeases: number;
}

/**
 * What the compaction step did (docs/.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md). `freeBytesBefore` is the reclaimable page space the
 * sweep left behind; `reclaimedBytes` is the logical file space the VACUUM actually returned.
 * `reason` is present exactly when `ran` is false, so a caller can tell "nothing to do" from
 * "contended" from "failed" without parsing prose.
 */
interface CompactionOutcome {
  readonly ran: boolean;
  readonly reason?:
    | "skipped"
    | "in-transaction"
    | "no-free-pages"
    | "below-threshold"
    | "busy"
    | "failed";
  readonly freeBytesBefore: number;
  readonly reclaimedBytes: number;
  /** The failure text when `reason` is `"failed"`; the log line carries the same message. */
  readonly error?: string;
}

export interface JanitorOutcome {
  /** Whether the run happened at all. `false` means the throttle or the mode said no. */
  readonly ran: boolean;
  readonly reason?: "off" | "throttled";
  readonly deleted: JanitorDeletions;
  readonly compacted: CompactionOutcome;
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

const NOTHING_COMPACTED: CompactionOutcome = {
  ran: false,
  reason: "skipped",
  freeBytesBefore: 0,
  reclaimedBytes: 0,
};

function skipped(reason: "off" | "throttled"): JanitorOutcome {
  return {
    ran: false,
    reason,
    deleted: NOTHING_DELETED,
    compacted: NOTHING_COMPACTED,
    deepCheckFailed: false,
    rebuilt: false,
  };
}

/**
 * Delete every row a predicate names, at most `batchSize` rows per statement, returning the count.
 * The statement is re-prepared per batch so no state is held between them, and each batch carries
 * the store's own busy budget (`withBusyRetry`) rather than the janitor inventing a retry.
 *
 * WHY `rowid IN (SELECT rowid ... LIMIT ?)`: `DELETE ... LIMIT` needs a SQLite build option this
 * runtime does not guarantee, while every table here is an ordinary rowid table. `table` admits only
 * `JanitorTable` members, so the two interpolated table slots cannot name a table no call site
 * passes (#105 rider). A short final batch ends the loop: it does not re-read rows it could have
 * deleted twice, because nothing re-creates foreign-generation or expired rows during a run.
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
  /**
   * Injection seam for the reclaim floor (docs/.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md): tests use a small value to exercise a VACUUM
   * on a tiny store. Production omits it and takes `STORE_COMPACT_MIN_FREE_BYTES`.
   */
  readonly compactMinFreeBytes?: number;
}): JanitorOutcome {
  const { db, now, settings } = input;
  if (settings.mode === "off") return skipped("off");
  if (!due(db, JANITOR_META_KEY, settings.intervalMs, now)) return skipped("throttled");

  const batchSize = settings.batchSize;
  const deletions = collectGarbage(db, now, batchSize);
  // Ref: docs/.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md
  const compacted =
    deletions === undefined
      ? NOTHING_COMPACTED
      : compactStore(db, input.compactMinFreeBytes ?? STORE_COMPACT_MIN_FREE_BYTES);

  if (deletions !== undefined) markRun(db, JANITOR_META_KEY, now);

  return {
    ran: true,
    deleted: deletions ?? NOTHING_DELETED,
    compacted,
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
    // Ref: docs/.archive_adrs/0045-ttl-ends-lease-resolution.md
    const expiredActive = deleteInBatches(
      db,
      "served_leases",
      EXPIRED_ACTIVE_LEASE_SQL,
      [servedLeaseExpiryCutoff(now)],
      batchSize,
    );
    const expiredRetired = deleteInBatches(
      db,
      "served_leases",
      "retired_at IS NOT NULL AND retired_at < ?",
      [now - VACUUM_RETIRED_PIN_MS],
      batchSize,
    );
    return {
      snapshots,
      lineage,
      leases: leases + dangling,
      expiredLeases: expiredActive + expiredRetired,
    };
  } catch (error) {
    reportDiagnostic("store-janitor", "[store-janitor] GC pass failed:", error);
    return undefined;
  }
}

/**
 * WHY these numbers: a VACUUM rewrites the whole database, so its cost scales with the FILE while its
 * benefit scales with the FREE PAGES. A quarter-free file amortises the rewrite; below that, a big
 * store would be rewritten for a few reclaimed pages. The megabyte floor keeps a tiny store from
 * paying a rewrite for one free page, and the 100 ms start budget means a contended compaction
 * defers to the next maintenance pass instead of stalling a session behind a rival writer.
 */
const STORE_COMPACT_MIN_FREE_RATIO = 0.25;
const STORE_COMPACT_MIN_FREE_BYTES = 1024 * 1024;
const STORE_COMPACT_BUSY_TIMEOUT_MS = 100;

function pragmaNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  return typeof value === "number" ? value : 0;
}

/**
 * Reclaim free pages into the file after a maintenance sweep (docs/.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md).
 *
 * One `VACUUM` in autocommit, gated on the reclaimable share, with a SHORT busy budget for STARTING
 * it: if a rival writer holds the store the pass returns `busy` and the next pass retries. The
 * VACUUM itself is not interruptible once started (SQLite owns it). Any failure is reported through
 * the OUTCOME and never thrown out of a lifecycle hook.
 *
 * WHY this function writes NOTHING itself — neither console nor log: a console call cannot see the
 * per-event surface map, so it would print on `session_shutdown` too, where the console is already
 * torn down (#199). The warning pipeline renders this outcome on the surface its event owns.
 */
function compactStore(db: DatabaseSync, minFreeBytes: number): CompactionOutcome {
  // SAFETY: node:sqlite exposes `isTransaction` at runtime although DatabaseSync's public type omits it;
  // SAFETY: a missing flag reads as autocommit, which is the janitor's own normal state.
  const inTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (inTransaction) {
    return { ran: false, reason: "in-transaction", freeBytesBefore: 0, reclaimedBytes: 0 };
  }
  const pageSize = pragmaNumber(db, "PRAGMA page_size");
  const pagesBefore = pragmaNumber(db, "PRAGMA page_count");
  const freePages = pragmaNumber(db, "PRAGMA freelist_count");
  const freeBytesBefore = freePages * pageSize;
  if (freePages === 0) {
    return { ran: false, reason: "no-free-pages", freeBytesBefore: 0, reclaimedBytes: 0 };
  }
  const totalBytes = pagesBefore * pageSize;
  if (
    freeBytesBefore < minFreeBytes ||
    (totalBytes > 0 && freeBytesBefore / totalBytes < STORE_COMPACT_MIN_FREE_RATIO)
  ) {
    return { ran: false, reason: "below-threshold", freeBytesBefore, reclaimedBytes: 0 };
  }

  const previousTimeout = pragmaNumber(db, "PRAGMA busy_timeout");
  try {
    db.exec(`PRAGMA busy_timeout = ${STORE_COMPACT_BUSY_TIMEOUT_MS}`);
    db.exec("VACUUM");
  } catch (error) {
    if (isBusyError(error)) {
      return { ran: false, reason: "busy", freeBytesBefore, reclaimedBytes: 0 };
    }
    return {
      ran: false,
      reason: "failed",
      freeBytesBefore,
      reclaimedBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${previousTimeout}`);
    } catch (error) {
      reportDiagnostic("store-janitor", "[store-janitor] failed to restore busy timeout:", error);
    }
  }
  const pagesAfter = pragmaNumber(db, "PRAGMA page_count");
  const reclaimedBytes = Math.max(0, (pagesBefore - pagesAfter) * pageSize);
  return { ran: true, freeBytesBefore, reclaimedBytes };
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
 * WHERE one event's warning may appear. `session_start` runs while the session is live, so the
 * operator sees the console; `session_shutdown` runs as the runtime tears that console down, so only
 * the log survives. Modelled as a value because "which surface" is the whole rule, and a boolean
 * would leave a reader to infer it from the event name.
 */
type JanitorWarningSurface = "console" | "log";

/** The surface each wired event publishes on. Keyed by the tuple, so a new event cannot be silent. */
const WARNING_SURFACE_BY_EVENT: Record<(typeof JANITOR_EVENTS)[number], JanitorWarningSurface> = {
  session_start: "console",
  session_shutdown: "log",
};

/**
 * Render one run's warning and publish it on `surface`. The TRIGGER is not re-derived here: the
 * formatter owns "did anything observable happen" (#197), so `null` is the only decision left — and
 * it means write nothing, on either surface.
 *
 * WHY the log path is resolved here and handed down: the formatter is pure by contract (#197), and
 * resolving it here keeps the damaged-store shape pointed at the file this process is writing.
 *
 * WHY the level picks the sink helper (`reportInfo` / `reportWarning`) rather than `reportDiagnostic`:
 * that one writes level `error`, and a routine cleanup filed as an error would make the log's
 * severity column lie.
 */
function publishJanitorWarning(outcome: JanitorOutcome, surface: JanitorWarningSurface): void {
  const warning = formatJanitorWarning(outcome, { logPath: diagnosticsLogPath() });
  if (warning === null) return;
  if (surface === "console") printJanitorWarning(warning);
  const report = warning.level === "info" ? reportInfo : reportWarning;
  report("store-janitor", recordBody(outcome, warning));
}

/**
 * The record body: the rendered lines, plus — for a FAILED compaction only — the exception's own
 * message. WHY the extra line: the rendered shape points at this log for details, so the log must
 * carry them; WHY only here and not on the console: the console line stays short because the
 * exception text is diagnostic evidence, not operator prose.
 */
function recordBody(outcome: JanitorOutcome, warning: JanitorWarning): string {
  const error = outcome.compacted.reason === "failed" ? outcome.compacted.error : undefined;
  return [
    ...warning.lines,
    ...(error === undefined ? [] : [`${JANITOR_WARNING_PREFIX} Error: ${error}`]),
  ].join("\n");
}

/**
 * The console half, which only `session_start` has. `warn` goes to `console.error` because that is
 * this repo's console habit for an operator-visible problem (`console.warn` appears nowhere in
 * `src/`); the severity that matters is the diagnostic record's, not which fd the line lands on.
 *
 * Never throws: the session's own work must not fail because a surface refused a warning, and a
 * console the host has already detached is exactly the shutdown case this module must survive.
 */
function printJanitorWarning(warning: JanitorWarning): void {
  try {
    for (const line of warning.lines) {
      if (warning.level === "info") console.info(line);
      else console.error(line);
    }
  } catch {}
}

/**
 * Wire the janitor to `JANITOR_EVENTS`. Both handlers run the same best-effort pass and differ only in
 * where they publish its warning: a failure is reported to the log and swallowed, because the
 * session's own work must not fail with maintenance.
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
  const handlerFor = (surface: JanitorWarningSurface) => async (): Promise<void> => {
    try {
      publishJanitorWarning(await deps.runJanitor(), surface);
    } catch (error) {
      reportDiagnostic("store-janitor", "[store-janitor] maintenance pass failed:", error);
    }
  };
  // SAFETY: `pi.on` is typed per event name while `JANITOR_EVENTS` is a runtime tuple, so the
  // SAFETY: registration needs the same string-key widening the entry point already uses; the
  // SAFETY: handler's `(event, ctx) => Promise<void>` shape is what every lifecycle event accepts.
  const register = (pi as unknown as { on: (event: string, handler: () => Promise<void>) => void })
    .on;
  for (const event of JANITOR_EVENTS) {
    register.call(pi, event, handlerFor(WARNING_SURFACE_BY_EVENT[event]));
  }
}
