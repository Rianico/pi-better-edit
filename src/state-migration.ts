/**
 * One-shot adoption of the STATE artifacts in the retired per-user directories (#190): the store
 * and the log are written by the extension itself, so only this pass reads the old copies.
 * The retired side is an ORDERED LIST: `PI_BETTER_EDIT_CONFIG_DIR` when set, else
 * `$XDG_CONFIG_HOME/pi-better-edit` or `$HOME/.config/pi-better-edit`, all three holding the same
 * artifacts, strongest first per `retiredConfigRoots()`.
 * WHY the SQLite store is NOT migrated: an older pi process may still own the old file and copying
 * or renaming a live database corrupts one owner — "fresh start, old file abandoned in place".
 * WHY best-effort: it never throws, and the marker is written only when every attempted MOVE
 * succeeded. WHY `report` is a parameter, not an import: this module runs before the diagnostics
 * sink's first write, so importing it would make the two modules import each other.
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
    if (existsSync(join(root, STATE_MIGRATION_MARKER))) return;
    mkdirSync(root, { recursive: true });
    const outcome: MigrationOutcome = { moveFailed: false };
    adoptArtifacts(root, report, outcome);
    if (!outcome.moveFailed) {
      writeFileSync(join(root, STATE_MIGRATION_MARKER), `${new Date().toISOString()}\n`, "utf-8");
    }
  } catch {
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
