import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { rename, mkdir } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { errCode } from "./utils.js";
import { initHasher } from "./hashline/hasher.js";
import { SERVED_TTL_MS } from "./constants.js";
import {
  HASH_STORE_VERSION,
  cachedOpenStore,
  resolveBusyBudget,
  setCachedOpenStore,
  withBusyRetry,
  type BusyBudget,
} from "./store-kernel/index.js";
import { ANCHOR_GENERATION, CANON_VERSION } from "./hashline/hash-identity.js";
import { DomainError } from "./domain-errors.js";
import { reportDiagnostic } from "./diagnostics.js";

import { reportInfo } from "./diagnostics.js";
import { migrateLegacyState } from "./state-migration.js";

import { stateRoot } from "./config-dir.js";
export { STORE_CONFIG_DIR_ENV_VAR, configDirOverride, stateRoot } from "./config-dir.js";

export function hashStorePath(): string {
  return join(stateRoot(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
  return join(stateRoot(), "hash-store.json");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}
/**
 * Create the state root, or refuse. WHY a DomainError rather than the raw mkdir failure: a store
 * that cannot be written has no fallback directory — a silent second state root is exactly the
 * fork this relocation removes — so the refusal is stated in the extension's own vocabulary and
 * names the directory a reader has to fix (permissions, a read-only mount, a file in the way).
 */
async function ensureStateRoot(): Promise<void> {
  const root = stateRoot();
  try {
    await mkdir(root, { recursive: true });
  } catch {
    throw new DomainError("E_ACCESS", { path: root, kind: "denied", access: "write" });
  }
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

export interface HashStore {
  readonly db: DatabaseSync;
  readonly engine: "node:sqlite";
}

/**
 * One open of the store FILE: the connection, plus the stamp-due decision `buildStore` made for it — the
 * persisted stamp did not match, so this open built, migrated and swept the store. `openStore` owes the
 * stamp write exactly when it is true, and pays it after the hooks; see `writeStoreStamp`.
 */
interface OpenedDb {
  readonly db: DatabaseSync;
  readonly stampDue: boolean;
}

let opening: { path: string; promise: Promise<HashStore> } | null = null;
/**
 * The use-time quarantine (#100) currently armed, or `null` when no statement has recently
 * proved the cached store corrupt. The trigger sets this SYNCHRONOUSLY — capture, flag-set
 * and cache check run with no await between them, so the section is atomic — and the runner
 * clears it when the heal settles. `loadHashStore` joins it, so the access after a loud failure
 * lands on the rebuilt store instead of the damaged one.
 */
let useTimeHeal: { generation: DatabaseSync; promise: Promise<void> } | null = null;
let exitHandlerRegistered = false;

/**
 * The stamp-due decision of the open that OWNS this connection right now, or `null` between opens:
 * `openStore` moves `buildStore`'s decision here for the hook phase, and the snapshot-store hook's
 * re-entrant `ensureSnapshotSchema` consults it instead of the persisted stamp. The persisted stamp
 * cannot answer for the hook phase — `openStore` writes it only after the LAST hook — so on the slow path
 * a row-based gate would sweep a SECOND time: every slow open, every upgrade, would pay two sweeps. The
 * decision is spent by the time the hooks run (the sweep's own site, `buildStore`, applies it first), so
 * a call from the hook phase only ever SKIPS the sweep. Cleared when the hook phase ends, so a caller
 * outside an open — the exported seam, a test that moves the stamp — decides from the row.
 * One slot is enough because opens are serialized: `loadHashStore` keeps one `opening` promise per path.
 */
let openStamp: { readonly db: DatabaseSync; readonly due: boolean } | null = null;

/** Whether the open that owns this connection has already settled the generation sweep. */
function sweepSettledByOpen(db: DatabaseSync): boolean {
  return openStamp !== null && openStamp.db === db;
}

export type StoreOpenHook = (db: DatabaseSync, info: { existed: boolean }) => void | Promise<void>;

const openHooks: StoreOpenHook[] = [];

export function onStoreOpen(hook: StoreOpenHook): void {
  openHooks.push(hook);
}

function openDbWithBusyRetry(storePath: string, budget?: BusyBudget): OpenedDb {
  return withBusyRetry(() => openDb(storePath, budget), budget);
}

function openDb(storePath: string, budget?: BusyBudget): OpenedDb {
  const db = new DatabaseSync(storePath, {
    timeout: resolveBusyBudget(budget).timeoutMs,
  });
  let stampDue: boolean;
  try {
    stampDue = buildStore(db);
  } catch (error) {
    try {
      db.close();
    } catch (closeError: unknown) {
      reportDiagnostic(
        "hash-store",
        "[hash-store] failed to close DB after buildStore error:",
        closeError,
      );
    }
    throw error;
  }
  return { db, stampDue };
}

const MIGRATION_COLUMNS = {
  cut_intent: { direction: "TEXT" },
  file_snapshots: { stat_key: "TEXT" },
  file_undo: { snapshot_hash: "TEXT", transaction_id: "TEXT", raw_pre: "TEXT" },
  served_session_meta: {
    outline_folds: "TEXT",
    hashes: "TEXT",
    blocked_hashes: "TEXT",
    epoch_id: "TEXT",
  },
} as const;

/** Tables carrying a migrated column from the map above. */
type MigrationTable = keyof typeof MIGRATION_COLUMNS;

/** Tables carrying the `anchor_generation` generation column. */
type GenerationTable = "file_snapshots" | "file_undo";

/** Every table the DDL helpers may name. */
type DdlTable = MigrationTable | GenerationTable | "served_leases";

function readTableColumns(db: DatabaseSync, table: DdlTable): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function tableColumns(db: DatabaseSync, table: DdlTable): Set<string> {
  try {
    return readTableColumns(db, table);
  } catch {
    return new Set<string>();
  }
}

function addColumnIfMissing<T extends MigrationTable>(
  db: DatabaseSync,
  table: T,
  column: keyof (typeof MIGRATION_COLUMNS)[T] & string,
): void {
  const definitions: Readonly<Record<string, string>> = MIGRATION_COLUMNS[table];
  const definition = definitions[column];
  if (!tableColumns(db, table).has(column)) {
    // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function renameGenerationColumn(db: DatabaseSync, table: GenerationTable): void {
  const cols = tableColumns(db, table);
  if (cols.has("anchor_generation")) return;
  if (cols.has("canon_version")) {
    try {
      // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
      db.exec(`ALTER TABLE ${table} RENAME COLUMN canon_version TO anchor_generation`);
      return;
    } catch {
      // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
      db.exec(`ALTER TABLE ${table} ADD COLUMN anchor_generation INTEGER NOT NULL DEFAULT 0`);
      // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
      db.exec(`UPDATE ${table} SET anchor_generation = canon_version`);
      // Ref: docs/.archive_adrs/0031-file-scoped-anchors-residual-and-generation-discipline.md
      try {
        // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
        db.exec(`ALTER TABLE ${table} DROP COLUMN canon_version`);
      } catch (dropError: unknown) {
        reportDiagnostic("hash-store", "skipped DROP COLUMN canon_version:", dropError);
      }
      return;
    }
  }
  // pi-lens-ignore: sql-injection -- the identifier comes from a closed MigrationTable/GenerationTable literal union; no external input
  db.exec(`ALTER TABLE ${table} ADD COLUMN anchor_generation INTEGER NOT NULL DEFAULT 0`);
}

/**
 * The persisted stamp's format — identity only, and BOTH halves must match: the `store_stamp` `meta`
 * row plus the header field `PRAGMA user_version`, whose value is
 * `<format>:<store schema>:<canon>:<anchor generation>:<registered open hooks>`.
 * - the LEADING field moves whenever that field list changes shape, so a stamp the old shape wrote is
 *   invalid by construction rather than by luck;
 * - `HASH_STORE_VERSION` is the schema half (`constants.ts` says when it must move), `CANON_VERSION`
 *   and `ANCHOR_GENERATION` the persisted anchor set's generation;
 * - the open-hook COUNT is the build fingerprint: module top-level pushes make an ADDITIONAL hook
 *   mismatch every older stamp. LIMITATION: a SWAP keeps the count, so a semantic change to an
 *   existing hook still needs the format bump; no time-varying state folds in.
 */
const META_VERSION_KEY = "version";
const META_STAMP_KEY = "store_stamp";

/** The stamp's format version — the leading field, bumped only when the field list itself changes. */
const STAMP_FORMAT_VERSION = 1;

/** The value the gate compares against, in the format documented above. */
function storeGenerationStamp(): string {
  return [
    STAMP_FORMAT_VERSION,
    HASH_STORE_VERSION,
    CANON_VERSION,
    ANCHOR_GENERATION,
    openHooks.length,
  ].join(":");
}

/**
 * Whether this store's stamp is current — the ONE fast-path decision of an open, and read-only by
 * construction: the header field, then the two `meta` rows, and nothing else. A file that is not one
 * of ours (no `meta` table yet, a partial build, a corrupt header) has no stamp to match, so the
 * answer is `false` and the slow path heals it; a read never throws out of the open.
 */
function storeStampMatches(db: DatabaseSync): boolean {
  try {
    // SAFETY: `node:sqlite` returns untyped rows; this lists SQLite's own integer header field.
    const header = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    if (header?.user_version !== HASH_STORE_VERSION) return false;
    // SAFETY: untyped rows again — the SELECT lists exactly `key` and `value`, both TEXT NOT NULL.
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
      .all(META_VERSION_KEY, META_STAMP_KEY) as unknown as { key: string; value: string }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return (
      values.get(META_VERSION_KEY) === String(HASH_STORE_VERSION) &&
      values.get(META_STAMP_KEY) === storeGenerationStamp()
    );
  } catch {
    return false;
  }
}

/**
 * Write BOTH halves of the stamp: the `meta` row carrying the store's provenance, and the header field
 * `PRAGMA user_version` that carries the schema half the gate reads. Called ONLY by `openStore`, and only
 * once EVERY open hook has succeeded, because the stamp certifies the whole open — the build, its
 * migrations, its sweep AND the hook work that follows them. Written from inside `buildStore`, where it
 * used to live, it certifies work that has not happened yet: a hook that throws then leaves a
 * valid-looking stamp over an unfinished store, and the next open takes the fast path over it. The two
 * statements are independent and each is atomic, so an interruption between them leaves a stamp that does
 * not match — one extra slow open, never a store that reads current while it is not.
 */
function writeStoreStamp(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(META_STAMP_KEY, storeGenerationStamp());
  db.exec(`PRAGMA user_version = ${HASH_STORE_VERSION}`);
}

/**
 * The generation and provenance sweep predicates, once per family: this file's open-time sweep and
 * the store janitor's periodic sweep (`src/store-janitor.ts`) both ask them, and a second copy is
 * how the two sweeps would come to delete different rows. The tables they read are created here,
 * the schema owner (docs/spec/content-addressed-line-identity-mvcc.md §5.1).
 */
/**
 * A served snapshot hash is `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`, so this pattern
 * keeps leases across a canon-only change and sweeps them on a generation change; pre-rename
 * two-part rows carry no middle component and never match, so they sweep as unknown.
 */
const FOREIGN_LEASE_LIKE = `%:${ANCHOR_GENERATION}:%`;

/** `file_snapshots` rows whose persisted anchor generation is not the current one. */
export const FOREIGN_GENERATION_SNAPSHOT_SQL = `anchor_generation != ${ANCHOR_GENERATION}`;

/** `served_leases` rows whose served snapshot hash carries a foreign anchor generation. */
export const FOREIGN_GENERATION_LEASE_SQL = `served_snapshot_hash NOT LIKE '${FOREIGN_LEASE_LIKE}'`;

/** `line_lineage` rows naming a snapshot that no longer exists. */
export const ORPHAN_LINEAGE_SQL = `snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)`;

/**
 * `served_leases` rows naming no surviving COMMITTED snapshot for their own path. The grant lookup
 * is path-scoped (`path = ? AND snapshot_hash = ? AND committed = 1`), so a lease naming a hash that
 * survives only in a foreign path's row — or only in an uncommitted row — is dangling.
 */
export const DANGLING_LEASE_SQL =
  "NOT EXISTS (SELECT 1 FROM file_snapshots fs " +
  "WHERE fs.path = served_leases.file_path AND fs.snapshot_hash = served_leases.served_snapshot_hash " +
  "AND fs.committed = 1)";

// Ref: docs/.archive_adrs/0045-ttl-ends-lease-resolution.md

/** The instant before which an un-retired lease has lost resolution authority (docs/.archive_adrs/0045-ttl-ends-lease-resolution.md). */
export function servedLeaseExpiryCutoff(now: number): number {
  return now - SERVED_TTL_MS;
}

/**
 * `served_leases` rows that are ACTIVE but past the session TTL — janitor GC's family. The
 * predicate names the table so both the batched delete (bare) and the vacuum's EXISTS subquery
 * (table-qualified) can share it; one parameter: the cutoff instant.
 */
export const EXPIRED_ACTIVE_LEASE_SQL =
  "served_leases.retired_at IS NULL AND served_leases.updated_at < ?";

/**
 * The complement INSIDE the same boundary: an ACTIVE lease still inside the session TTL. The
 * vacuum's pin probe uses this instead of restating the comparison, so pin authority and resolution
 * authority cannot drift apart.
 */
export const RESOLVABLE_LEASE_SQL =
  "served_leases.retired_at IS NULL AND served_leases.updated_at >= ?";

/**
 * The JS form of the same predicate, for the in-memory grant path (`leaseSpanSource`). The grant
 * path used to trust any un-retired lease regardless of age; hard expiry (docs/.archive_adrs/0045-ttl-ends-lease-resolution.md) makes the age
 * part of the authority, so an expired row is dropped before a lease identity can be returned.
 */
export function isExpiredActiveLease(
  lease: { retired_at: number | null; updated_at: number },
  now: number,
): boolean {
  return lease.retired_at === null && lease.updated_at < servedLeaseExpiryCutoff(now);
}

/**
 * Create the line-identity tables, then run the open-time generation sweep.
 * The sweep deletes foreign-generation snapshots, orphan lineage rows and dangling leases; a
 * current-generation row survives, and the served mirror is never swept at all — its `snapshotId` is
 * a load-epoch string (`v2|<path>|<ino>|...`), not a `file_snapshots` id, so no generation predicate
 * can judge it and an absent mirror costs one fresh serve.
 * The four deletes commit as one `BEGIN IMMEDIATE` unit. The fast-path gate lives HERE because both
 * sweep call sites — `buildStore` and the snapshot-store hook's `ensureSnapshotSchema` — reach the
 * sweep through this function; `openStamp` settles the same decision during an open's hook phase.
 */
export function ensureSnapshotTables(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_snapshots (" +
      "snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "path TEXT NOT NULL, " +
      "snapshot_hash TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "committed INTEGER NOT NULL DEFAULT 1, " +
      "UNIQUE (path, snapshot_hash)" +
      ")",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_created ON file_snapshots (created_at)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_id_counters (" +
      "path TEXT PRIMARY KEY, " +
      "next_id INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_lineage (" +
      "snapshot_id INTEGER NOT NULL, " +
      "line_number INTEGER NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "PRIMARY KEY (snapshot_id, line_number), " +
      "FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE" +
      ")",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_snapshot_line_id " +
      "ON line_lineage (snapshot_id, line_id)",
  );
  renameGenerationColumn(db, "file_snapshots");
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  addColumnIfMissing(db, "file_snapshots", "stat_key");
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_path_stat ON file_snapshots (path, stat_key)");
  if (sweepSettledByOpen(db) || storeStampMatches(db)) return;

  const hasTable = (table: DdlTable): boolean => {
    try {
      return readTableColumns(db, table).size > 0;
    } catch (error) {
      const err = error as { name?: string; message?: string };
      throw new DomainError("E_UNKNOWN", {
        errorName: err.name ?? "Error",
        message: `failed to read columns of table "${table}": ${err.message ?? String(error)}`,
      });
    }
  };
  const hasLeases = hasTable("served_leases");
  const sweepGenerations = (): void => {
    if (hasLeases) {
      // pi-lens-ignore: sql-injection -- the WHERE fragment is a module-level constant built from literals; no external input
      db.exec(`DELETE FROM served_leases WHERE ${FOREIGN_GENERATION_LEASE_SQL}`);
      // pi-lens-ignore: sql-injection -- the WHERE fragment is a module-level constant built from literals; no external input
    }
    // pi-lens-ignore: sql-injection -- the WHERE fragment is a module-level constant built from literals; no external input
    db.exec(`DELETE FROM file_snapshots WHERE ${FOREIGN_GENERATION_SNAPSHOT_SQL}`);
    // pi-lens-ignore: sql-injection -- the WHERE fragment is a module-level constant built from literals; no external input
    db.exec(`DELETE FROM line_lineage WHERE ${ORPHAN_LINEAGE_SQL}`);
    if (hasLeases) {
      // pi-lens-ignore: sql-injection -- the WHERE fragment is a module-level constant built from literals; no external input
      db.exec(`DELETE FROM served_leases WHERE ${DANGLING_LEASE_SQL}`);
    }
  };
  // SAFETY: `isTransaction` is an experimental `node:sqlite` field the read tolerates as absent
  // SAFETY: (`undefined` reads as not-in-transaction); the read is a boolean guard.
  // SAFETY: `BEGIN IMMEDIATE` cannot nest, so a caller already inside a transaction runs the sweep
  // SAFETY: on that transaction instead of opening its own.
  // SAFETY: the runtime floor is engines.node >= 24, so the read is present on every supported
  // SAFETY: runtime; the same read guards the vacuum-evict and dropServedState paths.
  const inSweepTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (inSweepTransaction) {
    sweepGenerations();
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      sweepGenerations();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        reportDiagnostic(
          "hash-store",
          "[hash-store] failed to rollback sweep transaction:",
          rollbackError,
        );
      }
      throw error;
    }
  }
}

/**
 * The undo schema, and the durable half of a multi-file cut: `file_undo` is the single source of
 * truth for undo history, its DDL owned here (docs/spec/content-addressed-line-identity-mvcc.md
 * §5.1) so the store and the undo domain cannot drift apart. `transaction_id` correlates the undo
 * rows of one cut transaction — a column, deliberately not a new table. `cut_intent` is the intent
 * record written BEFORE the first rename and deleted once every file of the transaction is
 * committed, so its presence at open marks a half-applied transaction for repair.
 */
const FILE_UNDO_DDL =
  "CREATE TABLE IF NOT EXISTS file_undo (" +
  "path TEXT PRIMARY KEY, " +
  "content TEXT NOT NULL, " +
  "bom TEXT NOT NULL, " +
  "ending TEXT NOT NULL, " +
  "hashes TEXT NOT NULL, " +
  "result_content TEXT NOT NULL, " +
  "snapshot_hash TEXT, " +
  "updated_at INTEGER NOT NULL" +
  ")";

const CUT_INTENT_DDL =
  "CREATE TABLE IF NOT EXISTS cut_intent (" +
  "txn_id TEXT PRIMARY KEY, " +
  "target_path TEXT NOT NULL, " +
  "created_at INTEGER NOT NULL" +
  ")";

// Ref: docs/.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md
export function ensureFileUndoSchema(db: DatabaseSync): void {
  db.exec(FILE_UNDO_DDL);
  addColumnIfMissing(db, "file_undo", "snapshot_hash");
  addColumnIfMissing(db, "file_undo", "transaction_id");
  addColumnIfMissing(db, "file_undo", "raw_pre");
  renameGenerationColumn(db, "file_undo");
  db.exec("CREATE INDEX IF NOT EXISTS idx_file_undo_transaction_id ON file_undo (transaction_id)");
  db.exec(CUT_INTENT_DDL);
  addColumnIfMissing(db, "cut_intent", "direction");
}

function buildStore(db: DatabaseSync): boolean {
  const stampDue = !storeStampMatches(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" + "key TEXT PRIMARY KEY, " + "value TEXT NOT NULL" + ")",
  );
  ensureSnapshotTables(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_leases (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "served_snapshot_hash TEXT NOT NULL, " +
      "served_line_number INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "retired_at INTEGER, " +
      "PRIMARY KEY (session_id, file_path, anchor)" +
      ")",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line " +
      "ON served_leases (session_id, file_path, line_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line_num " +
      "ON served_leases (session_id, file_path, served_line_number)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_file_retired " +
      "ON served_leases (file_path, retired_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_file_snapshot " +
      "ON served_leases (file_path, served_snapshot_hash, retired_at, updated_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_session_anchor " +
      "ON served_leases (session_id, anchor)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_session_meta (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "reported TEXT, " +
      "outline_folds TEXT, " +
      "hashes TEXT, " +
      "blocked_hashes TEXT, " +
      "epoch_id TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, file_path)" +
      ")",
  );
  ensureFileUndoSchema(db);
  addColumnIfMissing(db, "served_session_meta", "outline_folds");
  addColumnIfMissing(db, "served_session_meta", "hashes");
  addColumnIfMissing(db, "served_session_meta", "blocked_hashes");
  addColumnIfMissing(db, "served_session_meta", "epoch_id");

  if (!stampDue) return false;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(HASH_STORE_VERSION));
  return true;
}

/**
 * The SQLite database header — the 100-byte prefix of every database file (`fileformat2.html`
 * §1.3, "The Database Header"), read from those bytes directly: no page cache, no statement, no lock.
 * - bytes 0-15: the magic string `SQLite format 3\000`. A file without it is not a database.
 * - bytes 16-17: the page size, big-endian, a power of two from 512 to 32768 inclusive, or the
 *   literal value 1, the format's encoding of 65536.
 * - bytes 28-31: the database size in pages, big-endian, main file only — WAL frames live outside
 *   it (measured: the field equals the file's own page count with a WAL pending and after a
 *   checkpoint). Zero means "size unknown" to SQLite; no open of this store writes zero, so this
 *   check reads it as damage instead of guessing.
 * - the file's length must then be exactly page size x page count.
 */
const SQLITE_MAGIC = "SQLite format 3\0";
const SQLITE_HEADER_BYTES = 100;
const SQLITE_PAGE_SIZE_OFFSET = 16;
const SQLITE_PAGE_COUNT_OFFSET = 28;
/** The format's floor and ceiling for a page size; out of range is not a database. */
const SQLITE_MIN_PAGE_SIZE = 512;
const SQLITE_MAX_PAGE_SIZE = 65536;
/** The header value that ENCODES the ceiling — not a 1-byte page size. */
const SQLITE_MAX_PAGE_SIZE_ENCODING = 1;

/**
 * The FAST path's integrity check (#87c): does this store FILE still look like one SQLite file?
 *
 * WHY a header read replaces the full `PRAGMA quick_check`: the sweep walked every page and bought
 * only EARLIER notice, not prevention — the remedy is `quarantineStore` plus a rebuild from empty,
 * because this store is a disposable CACHE whose rows are re-derived from the files on disk. Page
 * damage inside a well-formed file is NOT checked here; it surfaces LATER, at the first statement
 * that touches it, as `database disk image is malformed` (SQLITE_CORRUPT) and never as a silently
 * wrong result. Issue #90 INHERITS the deep check: its janitor sweep MOVES the pass off the
 * tool-call path rather than losing it.
 */
function smokeCheckStoreFile(storePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(storePath, "r");
    const header = Buffer.allocUnsafe(SQLITE_HEADER_BYTES);
    const read = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
    if (read < SQLITE_HEADER_BYTES) return false;
    if (header.toString("latin1", 0, 16) !== SQLITE_MAGIC) return false;
    const rawPageSize = header.readUInt16BE(SQLITE_PAGE_SIZE_OFFSET);
    const pageSize =
      rawPageSize === SQLITE_MAX_PAGE_SIZE_ENCODING ? SQLITE_MAX_PAGE_SIZE : rawPageSize;
    if (pageSize < SQLITE_MIN_PAGE_SIZE || pageSize > SQLITE_MAX_PAGE_SIZE) return false;
    if ((pageSize & (pageSize - 1)) !== 0) return false;
    const pageCount = header.readUInt32BE(SQLITE_PAGE_COUNT_OFFSET);
    if (pageCount === 0) return false;
    return fstatSync(fd).size === pageSize * pageCount;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (closeError: unknown) {
        reportDiagnostic("hash-store", "failed to close the header probe fd:", closeError);
      }
    }
  }
}

/**
 * The SLOW path's integrity check: SQLite's own full pass over the store, unchanged. Runs when
 * there is no stamp to trust — a fresh store, a stamp mismatch, `existed === false`, or the open
 * after a quarantine — where the open is already rebuilding from empty.
 *
 * WHY it is ALSO the periodic deep check, half of #100: `src/store-janitor.ts` runs this function
 * on `session_start` and `session_shutdown`, off the tool-call hot path. That closes "not detected
 * at open" and "not healed on reopen" (a failure routes into `healUnhealthyStore`, the one
 * `quarantineStore` primitive) and leaves "not quarantined at use" — the FIRST FAILING STATEMENT
 * as the trigger — to #100. See the janitor's header for the full boundary statement.
 */
export function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        reportDiagnostic("hash-store", "Failed to quarantine corrupt hash store file:", error);
      }
    }
  }
}

/**
 * The WAL checkpoint's ONLY owner: truncate the journal, then close. `openStore` registers it once on
 * `exit`, `SIGINT` and `SIGTERM`, so every path out of the process arrives here.
 *
 * WHY the division of labour is worth stating: the store's periodic work (`src/store-janitor.ts`)
 * deliberately adds no checkpoint of its own — a run's writes ride the WAL like any other writer's —
 * so this is the single site that truncates it, and the rows a run leaves in the journal are
 * truncated by the close path that already truncates every other writer's. Nothing periodic needs to
 * duplicate that, and `wal_checkpoint(TRUNCATE)` on an already-truncated journal is a no-op, so the
 * two cannot double-charge.
 */
function shutdownDb(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error: unknown) {
    reportDiagnostic("hash-store", "[hash-store] failed to checkpoint WAL on shutdown:", error);
  }
  db.close();
}

/**
 * The HEAL half of the janitor's deep check: when the open store fails `isHealthy`, quarantine and
 * rebuild through the one `quarantineStore`, then `openStore`. Called only by `src/store-janitor.ts`,
 * off the tool-call path, where no tool call is in flight — so it never touches a store inside a
 * transaction of its own, and a statement prepared on the closed connection fails closed. It
 * re-checks rather than trusting its caller, so it can never quarantine a healthy store.
 * The sequence is its OWN — `shutdownHashStore`, `quarantineStore`, `openStore` — never a second
 * quarantine implementation: ONE `quarantineStore`, THREE orchestrations (this heal, the open path's
 * recovery, `triggerUseTimeHeal`, which skips the re-check because the failing statement proved the
 * damage). The rebuild runs through `openStore`, so the store comes back COMPLETE (hooks run, stamp
 * written after them) and the caller's `db` is stale: re-read with `loadHashStore`, never reuse it.
 */
export async function healUnhealthyStore(budget?: BusyBudget): Promise<boolean> {
  const current = cachedOpenStore();
  if (current === null || !current.db.isOpen) return false;
  if (isHealthy(current.db)) return false;
  reportDiagnostic(
    "hash-store",
    "[hash-store] deep check found the store damaged, quarantining and rebuilding",
  );
  shutdownHashStore();
  await quarantineStore(current.path);
  await openStore(current.path, budget);
  return true;
}

/**
 * The use-time quarantine's SEAM (#100): the single wrap point for the single cached handle.
 * `openStore` publishes the proxy into `cachedDb` and returns it, so both statement paths share it:
 * `loadHashStore` hands out `cachedDb.db`, and `withStore` frames `BEGIN`/`COMMIT`/`ROLLBACK` on
 * `cachedDb.db` directly while `fn`'s statements come from a closure over a `loadHashStore` handle.
 * Guarding only `loadHashStore`'s return would leave the framing statements unguarded.
 *
 * WHY a proxy: the handle must stay ONE object — `openStamp`, the hook phase and the `WeakMap`
 * statement caches all key on its identity — and `DatabaseSync` is a native class. Members outside
 * `prepare`/`exec` forward bound to the raw connection, so native-method receivers stay valid and
 * teardown (`shutdownDb`'s checkpoint, `close`) keeps working through the guard.
 */
/**
 * The watched methods resolve through the LIVE prototype on every call rather than being captured
 * when the handle is wrapped: the suite patches `DatabaseSync.prototype` (statement tracers,
 * `quick_check` counters) and those patches must observe guarded-handle calls exactly as they
 * observe raw ones. Instance own-property doubles (`vi.spyOn`) are handled one layer up — the traps
 * return those directly — so this lookup never sees a double.
 */
function realMethod(
  target: DatabaseSync | StatementSync,
  property: string,
): (...args: unknown[]) => unknown {
  const prototype = Object.getPrototypeOf(target) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const method = prototype[property];
  if (method === undefined) {
    throw new Error(`Missing method ${property} on ${target.constructor.name}`);
  }
  return method.bind(target);
}

function guardDatabaseHandle(raw: DatabaseSync, storePath: string): DatabaseSync {
  const guarded: DatabaseSync = new Proxy(raw, {
    get(target, property) {
      if (property === "prepare" || property === "exec") {
        if (Object.prototype.hasOwnProperty.call(target, property)) {
          const override: unknown = Reflect.get(target, property, target);
          return typeof override === "function" ? override.bind(target) : override;
        }
        if (property === "prepare") {
          return (sql: string) => {
            let statement: StatementSync;
            try {
              statement = realMethod(target, "prepare")(sql) as StatementSync;
            } catch (error) {
              triggerUseTimeHeal(guarded, storePath, error);
              throw error;
            }
            return guardStatement(statement, guarded, storePath);
          };
        }
        return (sql: string) => {
          try {
            realMethod(target, "exec")(sql);
          } catch (error) {
            triggerUseTimeHeal(guarded, storePath, error);
            throw error;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return guarded;
}

/** Statement methods whose failure can be the first proof of damage — the rest forward untouched. */
const GUARDED_STATEMENT_METHODS: ReadonlySet<string> = new Set(["get", "all", "run", "iterate"]);

function guardStatement(
  statement: StatementSync,
  generation: DatabaseSync,
  storePath: string,
): StatementSync {
  return new Proxy(statement, {
    get(target, property) {
      if (typeof property === "string" && GUARDED_STATEMENT_METHODS.has(property)) {
        if (Object.prototype.hasOwnProperty.call(target, property)) {
          const override: unknown = Reflect.get(target, property, target);
          return typeof override === "function" ? override.bind(target) : override;
        }
        const raw = realMethod(target, property);
        if (property === "iterate") {
          return (...args: unknown[]) => {
            try {
              return guardIterator(
                raw(...args) as IterableIterator<unknown>,
                generation,
                storePath,
              );
            } catch (error) {
              triggerUseTimeHeal(generation, storePath, error);
              throw error;
            }
          };
        }
        return (...args: unknown[]) => {
          try {
            return raw(...args);
          } catch (error) {
            triggerUseTimeHeal(generation, storePath, error);
            throw error;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

/**
 * `next` is guarded too: `iterate` steps lazily, so damage it walks can throw long after the `iterate`
 * call returned. The proxy keeps the iteration protocol intact and watches only `next`.
 */
function guardIterator(
  iterator: IterableIterator<unknown>,
  generation: DatabaseSync,
  storePath: string,
): IterableIterator<unknown> {
  const rawNext = iterator.next.bind(iterator) as (...args: unknown[]) => unknown;
  return new Proxy(iterator, {
    get(target, property) {
      if (property === "next" && Object.prototype.hasOwnProperty.call(target, property)) {
        const override: unknown = Reflect.get(target, property, target);
        return typeof override === "function" ? override.bind(target) : override;
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "next") return (value as (...args: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        try {
          return rawNext(...args);
        } catch (error) {
          triggerUseTimeHeal(generation, storePath, error);
          throw error;
        }
      };
    },
  });
}

/**
 * The use-time quarantine's TRIGGER (#100): a guarded statement or `exec` calls this with the
 * error it just threw, and it arms at most one heal — then the caller rethrows the ORIGINAL
 * error, so the failure stays loud and no success is ever synthesized.
 *
 * The section below runs with NO await between its lines, so capturing the generation, setting
 * the flag and checking the cache is atomic: two interleaved corruptions cannot both arm a heal,
 * and a handle the cache has already moved past can never arm one.
 */
function triggerUseTimeHeal(generation: DatabaseSync, storePath: string, error: unknown): void {
  if (!isCorruptionError(error)) return;
  if (useTimeHeal !== null) return;
  const cached = cachedOpenStore();
  if (cached === null || cached.db !== generation) return;
  const promise = runUseTimeHeal(storePath, generation);
  useTimeHeal = { generation, promise };
}

/**
 * The THIRD `quarantineStore` orchestration — the thin sibling of `healUnhealthyStore` the
 * mandate allows: the same tail (`shutdownHashStore`, then `quarantineStore`, then `openStore`)
 * but no `quick_check`, because the failing statement already proved the damage. Never rejects:
 * a heal that itself fails is reported, and the next `loadHashStore` opens normally.
 */
async function runUseTimeHeal(storePath: string, generation: DatabaseSync): Promise<void> {
  try {
    await Promise.resolve();
    const cached = cachedOpenStore();
    if (cached === null || cached.db !== generation) return;
    shutdownHashStore();
    await quarantineStore(storePath);
    await openStore(storePath);
  } catch (error) {
    reportDiagnostic("hash-store", "[hash-store] use-time quarantine failed:", error);
  } finally {
    if (useTimeHeal !== null && useTimeHeal.generation === generation) useTimeHeal = null;
  }
}

async function openStore(storePath: string, budget?: BusyBudget): Promise<HashStore> {
  shutdownHashStore();

  await initHasher();
  migrateLegacyState((message) => reportInfo("state-migration", message));
  await ensureStateRoot();

  let existed = existsSync(storePath);
  let opened: OpenedDb;
  try {
    opened = openDbWithBusyRetry(storePath, budget);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    reportDiagnostic("hash-store", "Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, budget);
  }
  let db = opened.db;
  const stampTrusted = existed && !opened.stampDue;
  if (stampTrusted ? !smokeCheckStoreFile(storePath) : !isHealthy(db)) {
    shutdownDb(db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, budget);
    db = opened.db;
  }

  const stamp = { db, due: opened.stampDue };
  openStamp = stamp;
  try {
    for (const hook of openHooks) {
      await hook(db, { existed });
    }

    if (stamp.due) withBusyRetry(() => writeStoreStamp(db), budget);

    const guarded = guardDatabaseHandle(db, storePath);
    setCachedOpenStore({ path: storePath, db: guarded });

    if (!exitHandlerRegistered) {
      exitHandlerRegistered = true;
      process.once("exit", () => shutdownHashStore());
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          shutdownHashStore();
          process.kill(process.pid, sig);
        });
      }
    }

    return { db: guarded, engine: "node:sqlite" };
  } finally {
    openStamp = null;
  }
}

/**
 * Open (or return the cached) store. `budget` shapes the contention wait of THIS open; production
 * callers pass nothing, and a cached open returns immediately without consulting it.
 */
export function loadHashStore(budget?: BusyBudget): Promise<HashStore> {
  const healing = useTimeHeal;
  if (healing !== null) return healing.promise.then(() => loadHashStore(budget));
  const storePath = hashStorePath();
  const cached = cachedOpenStore();
  if (cached && cached.path === storePath && cached.db.isOpen) {
    return Promise.resolve({ db: cached.db, engine: "node:sqlite" });
  }
  if (opening && opening.path === storePath) {
    return opening.promise;
  }
  const promise = openStore(storePath, budget).finally(() => {
    if (opening?.path === storePath) opening = null;
  });
  opening = { path: storePath, promise };
  return promise;
}

export function shutdownHashStore(): void {
  const cached = cachedOpenStore();
  if (cached) {
    shutdownDb(cached.db);
    setCachedOpenStore(null);
  }
}

export function __isStoreOpen(): boolean {
  const cached = cachedOpenStore();
  return cached !== null && cached.db.isOpen;
}
