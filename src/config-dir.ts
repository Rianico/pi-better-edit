/**
 * Where this extension keeps everything it persists: the store, its WAL, the janitor's
 * bookkeeping, and now the diagnostics log.
 *
 * WHY this is its own module rather than a corner of `hash-store.ts`: the diagnostics sink has to
 * answer "where is my directory?" on its very first line, and `hash-store.ts` is one of its
 * callers. Importing the directory rule from the store made a cycle (diagnostics → hash-store →
 * hash-identity → diagnostics) whose partial initialisation reached the schema as `undefined`
 * columns. The directory rule has no dependency on the store, so it lives where nothing forces a
 * cycle: below both of them.
 */
import { homedir } from "node:os";
import { join } from "node:path";

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  // SAFETY: join of trusted homedir (or HOME env validated by OS) with fixed ".config" segment — not user-controlled traversal, base is homedir and suffix is constant.
  return join(homeBase(), ".config");
}

/** The environment variable that names the app config directory, and so the store's own directory. */
export const STORE_CONFIG_DIR_ENV_VAR = "PI_BETTER_EDIT_CONFIG_DIR";

/**
 * The operator's store-directory override, read VERBATIM, or `undefined` when unset. An empty value
 * counts as unset. WHY it is exported rather than read where it is used: `configDir` and the
 * `/pi-better-edit` status display both have to answer "is the store directory overridden, and to
 * what", and two readings of one variable is how they come to disagree about "unset".
 */
export function configDirOverride(): string | undefined {
  const override = process.env[STORE_CONFIG_DIR_ENV_VAR];
  return override !== undefined && override.length > 0 ? override : undefined;
}

export function configDir(): string {
  // WHY: precedence for the app config dir is PI_BETTER_EDIT_CONFIG_DIR > XDG_CONFIG_HOME > $HOME/.config
  // WHY: — off Windows only. configBase() reads XDG_CONFIG_HOME behind a `process.platform !== "win32"`
  // WHY: guard, so on Windows this env var is the only way to relocate the store.
  // SAFETY: PI_BETTER_EDIT_CONFIG_DIR is trusted operator config, not attacker-controlled tool input, and
  // SAFETY: it is returned VERBATIM: configDir() appends nothing, sanitises nothing and creates nothing.
  // SAFETY: It IS a filesystem path, though — resolved against process.cwd() when relative, created on
  // SAFETY: first open by openStore() (mkdir(recursive: true)), and any EEXIST/EACCES/EINVAL from that
  // SAFETY: mkdir or the SQLite open surfaces raw out of the open path without naming the variable. The
  // SAFETY: contract is deliberately verbatim — trimming, validating or wrapping here is out of scope by
  // SAFETY: ticket mandate, so do not "fix" that; document it instead. An empty string counts as UNSET,
  // SAFETY: mirroring the XDG reading in configBase() above: that whole rule lives in configDirOverride().
  const override = configDirOverride();
  if (override !== undefined) return override;
  // SAFETY: join of trusted configBase (homedir/.config) with fixed "pi-better-edit" — constant suffix, no traversal.
  return join(configBase(), "pi-better-edit");
}
