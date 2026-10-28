/**
 * One-shot adoption of the STATE artifacts left in the retired per-user directories (#190).
 *
 * WHY the retired side is an ORDERED LIST and not one directory: before the relocation the layout
 * resolved to `PI_BETTER_EDIT_CONFIG_DIR` when set, else `$XDG_CONFIG_HOME/pi-better-edit` or
 * `$HOME/.config/pi-better-edit`. All three held the same artifacts, so a user who set the override
 * or relocated with `XDG_CONFIG_HOME` has their old store and log somewhere the default root never
 * looks. `retiredConfigRoots()` orders them strongest first.
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
 * marker is written only when every attempted MOVE succeeded, so a partial run is retried rather
 * than recorded as done. A failed DELETION does not withhold the marker: it is reported, and retrying
 * it would mean re-walking a directory on every session forever for a file we already stopped
 * caring about.
 *
 * WHY the reporting sink is a parameter instead of an import of `diagnostics.ts`: this module runs
 * BEFORE the diagnostics sink's first write (that is the point — the old log has to be in place
 * first), and importing the sink would make the two modules import each other.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { retiredConfigRoots, stateRoot } from "./config-dir.js";

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

/** What the pass has to remember across its own calls: whether anything it TRIED to move failed. */
interface MigrationOutcome {
  moveFailed: boolean;
}

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
    const outcome: MigrationOutcome = { moveFailed: false };
    adoptArtifacts(root, report, outcome);
    // SAFETY: the marker means "nothing is left to move". A failed move keeps it unwritten so the
    // SAFETY: next session tries again; a completed copy counts as moved, and a failed DELETION is
    // SAFETY: only reported — see the header for why that does not withhold the marker.
    if (!outcome.moveFailed) {
      writeFileSync(join(root, STATE_MIGRATION_MARKER), `${new Date().toISOString()}\n`, "utf-8");
    }
  } catch {
    // SAFETY: best-effort by contract — the marker was not written, so the next call retries.
  } finally {
    running = false;
  }
}

function adoptArtifacts(
  root: string,
  report: (message: string) => void,
  outcome: MigrationOutcome,
): void {
  const retired = retiredConfigRoots();
  for (const name of MOVED_ARTIFACTS) {
    moveFirstExisting(name, root, retired, report, outcome);
  }
  for (const directory of retired) deleteCorruptDumps(directory, report);
  reportAbandonedStore(retired, report);
}

/**
 * Move `name` from the FIRST retired root that holds it, unless the destination already exists. An
 * existing destination wins: it was written by this install, and every retired copy is history.
 *
 * WHY only the first source: the roots are ordered, so a later copy is a weaker record of the same
 * artifact; moving both would either clobber the first or need a merge nobody can define.
 */
function moveFirstExisting(
  name: string,
  root: string,
  retired: readonly string[],
  report: (message: string) => void,
  outcome: MigrationOutcome,
): void {
  const to = join(root, name);
  if (existsSync(to)) return;
  const directory = retired.find((candidate) => existsSync(join(candidate, name)));
  if (directory === undefined) return;
  move(join(directory, name), to, report, outcome);
}

/**
 * `rename` `from` to `to`, falling back to copy-then-unlink when the two live on different
 * filesystems.
 *
 * WHY the fallback: `rename` cannot cross a device boundary (`EXDEV`), and a state root on another
 * mount — an override pointing into a container volume is the ordinary case — would otherwise lose
 * the move while still looking like "nothing to do", leaving the old log behind AND, worse,
 * recording the pass as complete. Only the three artifacts in `MOVED_ARTIFACTS` come through here;
 * the SQLite trio is never moved at all, so a live database is never copied behind its owner's back.
 */
function move(
  from: string,
  to: string,
  report: (message: string) => void,
  outcome: MigrationOutcome,
): void {
  try {
    renameSync(from, to);
    report(`moved ${from} → ${to}`);
    return;
  } catch (error: unknown) {
    if (codeOf(error) !== "EXDEV") {
      outcome.moveFailed = true;
      report(`could not move ${from} → ${to}: ${reasonOf(error)}`);
      return;
    }
  }
  copyAcrossDevices(from, to, report, outcome);
}

/** The `EXDEV` half of `move`: the bytes have to arrive at the destination before the source goes. */
function copyAcrossDevices(
  from: string,
  to: string,
  report: (message: string) => void,
  outcome: MigrationOutcome,
): void {
  try {
    copyFileSync(from, to);
  } catch (error: unknown) {
    outcome.moveFailed = true;
    report(`could not copy ${from} → ${to}: ${reasonOf(error)}`);
    return;
  }
  try {
    unlinkSync(from);
  } catch (error: unknown) {
    // WHY: the destination holds the bytes, so the move's purpose is served and the stale source is
    // WHY: inert history the destination wins over anyway.
    report(`copied ${from} → ${to} but left the original in place: ${reasonOf(error)}`);
    return;
  }
  report(`moved ${from} → ${to} (copied across filesystems)`);
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
function reportAbandonedStore(retired: readonly string[], report: (message: string) => void): void {
  for (const directory of retired) {
    const storePath = join(directory, "hash-store.sqlite");
    if (["", "-wal", "-shm"].some((suffix) => existsSync(`${storePath}${suffix}`))) {
      report(`left the old store in place at ${storePath} (fresh state root starts empty)`);
      return;
    }
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
