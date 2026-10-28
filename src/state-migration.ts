/**
 * One-shot adoption of the STATE artifacts left in the retired per-user directory (#190).
 *
 * WHY a pass at all: the settings file is adopted by the ladder in `json-config.ts`, but the store
 * and the log are not settings — they are written by the extension itself, so nobody would ever
 * read the old copies by asking for them. Without this pass an upgraded install would silently
 * start a second, empty state root and leave the old log (the one that explains the bug the user
 * is reporting) behind.
 *
 * WHY the SQLite store is NOT migrated: an older pi process may still be using the old file, and
 * copying or renaming a live SQLite database corrupts one of the two owners. The store's contract
 * is therefore "fresh start, old file abandoned in place", and the only action left is to say
 * where it is — once, deduped by a marker file in the new root so a log reader is not told the
 * same thing every session.
 *
 * WHY everything here is best-effort: this runs underneath the diagnostics sink and the store open,
 * both of which have their own failure contracts. A migration that threw would turn "the user's
 * config moved" into "the tool stopped working", which is a worse outcome than a stale log. The
 * marker is written only when the pass COMPLETED, so a partial run is retried rather than recorded
 * as done.
 *
 * WHY the reporting sink is a parameter instead of an import of `diagnostics.ts`: this module runs
 * BEFORE the diagnostics sink's first write (that is the point — the old log has to be in place
 * first), and importing the sink would make the two modules import each other.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retiredConfigRoot, stateRoot } from "./config-dir.js";

/** Marker inside the state root: its presence is the record that the pass already ran. */
export const STATE_MIGRATION_MARKER = ".migration-v1";

/**
 * Artifacts that follow the state root, moved only when the new path is absent. The pre-SQLite
 * JSON store is still read by `snapshot-store/migrate.ts`; the log pair is what makes a bug report
 * written before the upgrade readable after it.
 */
const MOVED_ARTIFACTS = ["hash-store.json", "diagnostics.log", "diagnostics.log.1"] as const;

/** Forensic copies of a store we are abandoning: deleted, because they describe a file nobody
 * will open again and they are the largest thing in the retired directory. */
const CORRUPT_DUMP_PATTERN = /^hash-store\.(?:sqlite|json)\.corrupt-/;

/** Re-entrancy guard: reporting a move goes through the diagnostics sink, which calls back here
 * before its first write. Without this the first report would recurse. */
let running = false;

/**
 * Move what can be moved, delete what should be deleted, name what is abandoned. Never throws;
 * `report` receives one human-readable line per action worth an operator's attention.
 */
export function migrateLegacyState(report: (message: string) => void): void {
  if (running) return;
  running = true;
  try {
    const root = stateRoot();
    // WHY: the marker, not a module flag — a re-pointed override (tests do this) must migrate its own
    // WHY: root, and the marker is what makes "already done" a fact about the DIRECTORY.
    if (existsSync(join(root, STATE_MIGRATION_MARKER))) return;
    // SAFETY: the state root is created here (not by the caller) because the artifacts below have
    // SAFETY: to land inside it; a failure is swallowed by the enclosing catch and surfaces later as
    // SAFETY: the store open's own [E_ACCESS] refusal, which is where a caller can act on it.
    mkdirSync(root, { recursive: true });
    adoptArtifacts(root, report);
    writeFileSync(join(root, STATE_MIGRATION_MARKER), `${new Date().toISOString()}\n`, "utf-8");
  } catch {
    // SAFETY: best-effort by contract — the marker was not written, so the next call retries.
  } finally {
    running = false;
  }
}

function adoptArtifacts(root: string, report: (message: string) => void): void {
  const retired = retiredConfigRoot();
  for (const name of MOVED_ARTIFACTS) {
    moveIfAbsent(join(retired, name), join(root, name), report);
  }
  deleteCorruptDumps(retired, report);
  reportAbandonedStore(retired, report);
}

/** Rename `from` to `to` only when the source exists and the destination does not. An existing
 * destination wins: it was written by this install, and the retired file is history. */
function moveIfAbsent(from: string, to: string, report: (message: string) => void): void {
  if (!existsSync(from) || existsSync(to)) return;
  try {
    renameSync(from, to);
    report(`moved ${from} → ${to}`);
  } catch (error: unknown) {
    report(`could not move ${from} → ${to}: ${reasonOf(error)}`);
  }
}

function deleteCorruptDumps(retired: string, report: (message: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(retired);
  } catch {
    // WHY: an absent retired directory is the ordinary state of a fresh install.
    return;
  }
  for (const name of entries) {
    if (!CORRUPT_DUMP_PATTERN.test(name)) continue;
    const path = join(retired, name);
    try {
      unlinkSync(path);
      report(`deleted abandoned store dump ${path}`);
    } catch (error: unknown) {
      report(`could not delete abandoned store dump ${path}: ${reasonOf(error)}`);
    }
  }
}

/** The store trio is named, never touched: an old-version session may still own it. */
function reportAbandonedStore(retired: string, report: (message: string) => void): void {
  const storePath = join(retired, "hash-store.sqlite");
  for (const suffix of ["", "-wal", "-shm"] as const) {
    if (existsSync(`${storePath}${suffix}`)) {
      report(`left the old store in place at ${storePath} (fresh state root starts empty)`);
      return;
    }
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
