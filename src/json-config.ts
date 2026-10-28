/**
 * The settings-file seam — WHERE the file lives, HOW it is read and HOW it is written, shared by
 * every settings owner that keeps keys in it.
 *
 * WHY this module owns the file and not each settings owner: the scopes, the precedence order and
 * the preserving atomic write are ONE contract, and a second hand-rolled copy of any of them is how
 * two ladders over one file drift apart. Owners keep their own KEYS (`lens.bridge`, `store.*`) and
 * import everything else from here.
 *
 * Shape: `{ "$schema": <CONFIG_SCHEMA_ID>, ...owner keys... }` — documented by
 * `schemas/pi-better-edit.json`, whose root `additionalProperties` stays `true` so an owner's keys
 * need no schema change to be written, only to be validated.
 *
 * The LOCATIONS are not spelled here: `src/config-dir.ts` names every path (current and retired),
 * because the arch guard pins one naming module and an adoption chain that re-derived a retired
 * path would read a file nobody meant it to. This module owns the ladder over those paths.
 *
 * Absence is never an error. A missing file reads as "not configured"; so does a file that exists
 * but cannot be read or parsed. The difference is only whether anyone is TOLD: `readConfigObject`
 * takes an optional `onWarn` for callers whose setting is load-bearing (the store path warns, so a
 * dropped knob cannot silently change what the store does), and stays silent when the caller passes
 * none (the bridge path keeps reading total, because a hand-edited file must never make a read
 * noisy). Nothing here throws on the read side.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  PROJECT_SETTINGS_REL,
  SETTINGS_FILE_NAME,
  retiredGlobalSettingsPaths,
  retiredProjectSettingsPath,
  settingsRoot,
} from "./config-dir.js";
import { reportInfo, reportWarning } from "./diagnostics.js";

/** The two places the config file may live: beside the project, or in the settings root. */
export type ConfigScope = "project" | "global";

/**
 * The rung a resolved setting came from: the two file scopes, the environment override above them,
 * or the built-in default below them. Named once here because every settings owner's ladder is built
 * from the same four rungs — `ConfigScope` alone would leave each owner spelling the other two out.
 */
export type ConfigRung = "env" | ConfigScope | "default";
/** Called with a human-readable reason when a config file exists but could not be used. */
export type ConfigOnWarn = (reason: string) => void;

/**
 * The PROJECT config location, relative to the project root, and the settings file name inside
 * `settingsRoot()`. Re-exported from the naming module: every settings owner and the
 * `/pi-better-edit` status display name these, and this seam is where they have always imported
 * them from.
 */
export { PROJECT_SETTINGS_REL as CONFIG_REL, SETTINGS_FILE_NAME as CONFIG_FILE_NAME };
/** Published schema id written into config files (see `schemas/pi-better-edit.json`). */
export const CONFIG_SCHEMA_ID =
  "https://github.com/Rianico/pi-better-edit/schemas/pi-better-edit.json";

/** SAFETY: HOME wins over homedir() because pi runs the extension with the user's shell env; an
 * empty HOME counts as unset. Mirrors the `homeBase` convention in `src/paths.ts`. */
function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome !== undefined && envHome.length > 0 ? envHome : homedir();
}

/** The config file one scope reads and writes. A path is derived, never created, by asking for it. */
export function configFilePath(scope: ConfigScope, cwd: string): string {
  return scope === "global"
    ? join(settingsRoot(), SETTINGS_FILE_NAME)
    : join(cwd, PROJECT_SETTINGS_REL);
}

/**
 * A path as a person reads it: `~` for the home prefix, unchanged otherwise. WHY a separate
 * function: `/pi-better-edit` prints these paths, and a status line that shows an absolute home
 * path is both long and wrong for a machine whose HOME moved.
 */
export function displayPath(path: string): string {
  const home = homeBase();
  return path === home || !path.startsWith(home + sep) ? path : `~${path.slice(home.length)}`;
}

export function configFileDisplayPath(scope: ConfigScope, cwd: string): string {
  return displayPath(configFilePath(scope, cwd));
}

/**
 * The config object for one scope, after adopting a file left at a retired location.
 *
 * WHY migration lives here rather than in each owner: an owner that spelled the old path out would
 * adopt a different subset of keys than its neighbour. One read, one adoption, one report.
 */
export function readScopeConfig(
  scope: ConfigScope,
  cwd: string,
  onWarn?: ConfigOnWarn,
): Record<string, unknown> | undefined {
  const path = configFilePath(scope, cwd);
  const current = readConfigObject(path, onWarn);
  if (current !== undefined) return current;
  return adoptRetiredConfig(scope, cwd, path);
}

/**
 * Serve a file left at a retired location, and retire it once the new one holds its keys (#190).
 *
 * WHY every retired source is renamed, not just the one that won: the chain is ordered, so the
 * losers are history the moment the winner's keys are adopted; leaving one behind makes a later
 * edit to it silently do nothing. WHY a renamed source keeps its bytes (`.bak`) rather than being
 * deleted: the same convention the store's own retirements use, and it leaves the operator's
 * hand-written file recoverable.
 *
 * WHY a failed adoption still returns the object: settings must keep working when the destination
 * is, say, read-only — the write is the only part that can fail, and the read side never depends
 * on it. A project tree that refuses the write is the same case: the old keys serve, nothing is
 * renamed, and one warning names the destination.
 */
function adoptRetiredConfig(
  scope: ConfigScope,
  cwd: string,
  newPath: string,
): Record<string, unknown> | undefined {
  const sources =
    scope === "global" ? retiredGlobalSettingsPaths() : [retiredProjectSettingsPath(cwd)];
  for (const source of sources) {
    const retired = readConfigObject(source);
    if (retired === undefined) continue;
    adoptSettings(newPath, retired, source, sources);
    return retired;
  }
  return undefined;
}

function adoptSettings(
  newPath: string,
  settings: Record<string, unknown>,
  source: string,
  sources: readonly string[],
): void {
  try {
    updateConfigFile(newPath, () => settings);
    // WHY: the re-read — the atomic write is only as good as the file it leaves behind, and the
    // WHY: rename below is irreversible for the retired source — a file that does not parse must
    // WHY: not be marked as adopted.
    if (readConfigObject(newPath) === undefined) {
      throw new Error(`the adopted file does not parse: ${newPath}`);
    }
    for (const retiredSource of sources) {
      if (existsSync(retiredSource)) renameSync(retiredSource, `${retiredSource}.bak`);
    }
    reportInfo("json-config", `adopted settings ${source} → ${newPath}`);
  } catch (error: unknown) {
    // SAFETY: the read side keeps working from the retired object; only the move is reported.
    reportWarning("json-config", `could not adopt settings ${source} → ${newPath}:`, error);
  }
}

/** Runtime guard for the two config scopes. */
export function isConfigScope(value: unknown): value is ConfigScope {
  return value === "project" || value === "global";
}

/** Whether a parsed JSON value can hold settings at all — arrays and scalars cannot. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a read failure means the file is simply not there. */
function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The parsed config object at `path`, or `undefined` when there is none to read: missing, unreadable
 * and unparseable all read the same way, and a root that is not a JSON object is no config object
 * either. Never throws.
 *
 * `onWarn` is told about the cases where a file WAS there and was skipped — a permissions error, a
 * truncated or hand-edited file, a root of the wrong kind. A missing file is not one of them: it is
 * the ordinary "not configured" state that every first run starts in.
 */
function readConfigObject(
  path: string,
  onWarn?: ConfigOnWarn,
): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error: unknown) {
    // SAFETY: an absent config means "not configured", so the caller falls through the precedence
    // SAFETY: ladder; any OTHER read failure is a file someone meant to be read, so a caller that
    // SAFETY: cares is told while a caller that does not still reads it as "not configured".
    if (!isMissingFile(error)) onWarn?.(`cannot read config ${path}: ${reasonOf(error)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    // SAFETY: a hand-edited file can be unparseable mid-write; reading it as "not configured" keeps
    // SAFETY: the read total and lets the next save rewrite the file from the canonical shape.
    onWarn?.(`cannot parse config ${path}: ${reasonOf(error)}`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    const kind = Array.isArray(parsed) ? "JSON array" : `JSON ${typeof parsed}`;
    onWarn?.(`config ${path} has a ${kind} root, not an object`);
    return undefined;
  }
  return parsed;
}

/**
 * Replace the file at `path` with `update(existing)`. The update function receives the existing
 * object and returns the full next object, so keeping a key it does not own is the default rather
 * than something each writer has to remember; a non-object or unparseable existing file is an empty
 * one, which is what makes the next save rewrite it from the canonical shape.
 *
 * `$schema` is this seam's OWN key: an existing non-empty string survives (a deliberate editor-time
 * choice belongs to the user), anything else is replaced by `CONFIG_SCHEMA_ID`. It is written first,
 * so the head of the file is the same for every writer.
 *
 * Creates the parent directory as needed and replaces the file atomically (sibling temp file +
 * rename, same filesystem). Throws only what the filesystem throws.
 */
export function updateConfigFile(
  path: string,
  update: (existing: Record<string, unknown>) => Record<string, unknown>,
): void {
  const existing = readConfigObject(path) ?? {};
  const existingSchema = existing.$schema;
  const updated = update(existing);
  // WHY: `$schema` is rebuilt FIRST and skipped out of the caller's object rather than spread and
  // WHY: overwritten — the head of the written file is then the same for every writer, and only this
  // WHY: seam decides the value.
  const next: Record<string, unknown> = {
    $schema:
      typeof existingSchema === "string" && existingSchema.length > 0
        ? existingSchema
        : CONFIG_SCHEMA_ID,
  };
  for (const [key, value] of Object.entries(updated)) {
    if (key !== "$schema") next[key] = value;
  }

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // SAFETY: the temp file is a sibling of the target inside the directory just created (same
  // SAFETY: filesystem), so renameSync replaces the target atomically; the pid suffix keeps
  // SAFETY: concurrent writers from clobbering each other's staging file.
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    renameSync(tempPath, path);
  } catch (error: unknown) {
    try {
      unlinkSync(tempPath);
    } catch {
      // SAFETY: best-effort cleanup after a failed write — the original error is the actionable one,
      // SAFETY: and an orphaned .tmp-<pid> sibling is inert.
    }
    throw error;
  }
}
