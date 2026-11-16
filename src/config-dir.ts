/**
 * The two directories this extension owns, and the only module that names any of their paths.
 *
 * WHY two roots: settings belong to the pi agent tree, while the store, the legacy JSON and the
 * diagnostics log are STATE — machine-written, disposable, never edited by hand — so they live
 * under an XDG state root where an `rm -rf` cannot reach the user's configuration. Every RETIRED
 * path is spelled here too: `test/arch/config-ladder-single-owner.test.ts` pins one naming module.
 *
 * WHY its own module: the diagnostics sink reads it on its first line and `hash-store.ts` is a
 * caller, so the import made a cycle (diagnostics → hash-store → hash-identity → diagnostics)
 * whose partial initialisation reached the schema as `undefined` columns.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** SAFETY: HOME wins over homedir() because pi runs the extension with the user's shell env; an
 * empty HOME counts as unset. Mirrors the `homeBase` convention in `src/paths.ts`. */
function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome !== undefined && envHome.length > 0 ? envHome : homedir();
}

/** `~` or a path under it, expanded against `homeBase`; anything else is returned unchanged. */
function expandHome(value: string): string {
  const home = homeBase();
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

/**
 * The environment variable that names the extension's own root, and so — through
 * `<root>/state/` — the only thing that can move the store.
 */
export const STORE_CONFIG_DIR_ENV_VAR = "PI_BETTER_EDIT_CONFIG_DIR";

/** pi's own agent directory, where the extensions live. */
const CODING_AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/** The XDG base for machine-written state. */
const XDG_STATE_HOME_ENV_VAR = "XDG_STATE_HOME";

/** The XDG base the RETIRED config directory used to resolve against. Read for adoption only. */
const XDG_CONFIG_HOME_ENV_VAR = "XDG_CONFIG_HOME";

/** The directory name the extension owned before #190, under either config base. */
const RETIRED_CONFIG_DIR_NAME = "pi-better-edit";

/**
 * The operator's override, read VERBATIM, or `undefined` when unset. An empty value counts as
 * unset. WHY it is exported rather than read where it is used: `settingsRoot`, `stateRoot` and the
 * `/pi-better-edit` status display all have to answer "is the root overridden, and to what", and
 * two readings of one variable is how they come to disagree about "unset".
 */
export function configDirOverride(): string | undefined {
  const override = process.env[STORE_CONFIG_DIR_ENV_VAR];
  return override !== undefined && override.length > 0 ? override : undefined;
}

/**
 * pi's agent directory: `PI_CODING_AGENT_DIR` after `~` expansion when that yields an ABSOLUTE
 * path, otherwise `$HOME/.pi/agent`.
 *
 * WHY the absolute requirement: a relative value would resolve against whatever cwd the host
 * process happens to have, so the same settings would live under a different root per session —
 * the silent fork this relocation exists to remove. A value that cannot be trusted is ignored
 * rather than guessed at.
 */
function agentHome(): string {
  const raw = process.env[CODING_AGENT_DIR_ENV_VAR];
  if (raw !== undefined && raw.length > 0) {
    const expanded = expandHome(raw);
    if (isAbsolute(expanded)) return expanded;
  }
  return join(homeBase(), ".pi", "agent");
}

/** `$XDG_STATE_HOME` when it is non-empty AND absolute; otherwise `$HOME/.local/state`. The
 * relative-value rule matches `agentHome`'s: a relative base is another cwd-shaped fork. */
function stateHome(): string {
  const raw = process.env[XDG_STATE_HOME_ENV_VAR];
  if (raw !== undefined && raw.length > 0 && isAbsolute(raw)) return raw;
  return join(homeBase(), ".local", "state");
}

/**
 * Where the user-level settings file lives. The override names this directory VERBATIM (no
 * suffix is appended beyond `settings.json` itself), so `$PI_BETTER_EDIT_CONFIG_DIR/settings.json`
 * is the file an operator who set the variable will find.
 */
export function settingsRoot(): string {
  const override = configDirOverride();
  if (override !== undefined) return override;
  return join(agentHome(), "extensions", "pi-better-edit");
}

/**
 * Where everything the extension writes at runtime lives: the store, the pre-SQLite JSON store and
 * the diagnostics log. The override owns it through `<override>/state`, so one variable still
 * moves the store and nothing else can.
 */
export function stateRoot(): string {
  const override = configDirOverride();
  if (override !== undefined) return join(override, "state");
  return join(stateHome(), "pi-better-edit");
}

/** The settings file name inside `settingsRoot()`. */
export const SETTINGS_FILE_NAME = "settings.json";

/** The PROJECT settings location, relative to the project root. */
export const PROJECT_SETTINGS_REL = ".pi/agents/pi-better-edit/settings.json";

/**
 * The retired per-user config directories, strongest first: each held the settings file AND every
 * state artifact before #190, the coupling this relocation breaks. Read once for adoption, never
 * written again. WHY the override first: it is the strongest statement of where that user meant
 * their files to live.
 *
 * WHY `$XDG_CONFIG_HOME` is read HERE and only here: the pre-#190 ladder honoured it, so adoption
 * must look where the old ladder looked — every NEW path derives from the agent dir and the state
 * home, so changing this variable never moves a file written by this version. A relative value is
 * ignored, as it was. WHY deduped: an unset `$XDG_CONFIG_HOME` resolves to `<home>/.config`, so two
 * rungs collapse into one and a single artifact must not be visited, moved or reported twice.
 */
export function retiredConfigRoots(): readonly string[] {
  const override = configDirOverride();
  return dedupe([
    ...(override === undefined ? [] : [override]),
    join(xdgConfigBase(), RETIRED_CONFIG_DIR_NAME),
    join(homeBase(), ".config", RETIRED_CONFIG_DIR_NAME),
  ]);
}

/** `$XDG_CONFIG_HOME` when it is non-empty AND absolute; otherwise `$HOME/.config`. */
function xdgConfigBase(): string {
  const raw = process.env[XDG_CONFIG_HOME_ENV_VAR];
  if (raw !== undefined && raw.length > 0 && isAbsolute(raw)) return raw;
  return join(homeBase(), ".config");
}

/** First occurrence wins, order preserved. */
function dedupe(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

/** The retired FLAT settings location, relative to either a project root or the home directory. */
const RETIRED_FLAT_SETTINGS_REL = ".pi/agents/pi-better-edit.json";

/** The settings file name the retired directories held before #190. */
const RETIRED_SETTINGS_FILE_NAME = "pi-better-edit.json";

/**
 * The retired global settings files, strongest first: the override's own directory (when set),
 * the retired directory under the XDG config base, the same directory under `$HOME/.config`, then
 * the even older flat `$HOME/.pi/agents/` file. WHY one function rather than three rungs at the call
 * site: the adoption chain is a contract, and a caller that reordered it would adopt a different
 * file than its neighbour.
 */
export function retiredGlobalSettingsPaths(): readonly string[] {
  return dedupe([
    ...retiredConfigRoots().map((root) => join(root, RETIRED_SETTINGS_FILE_NAME)),
    join(homeBase(), RETIRED_FLAT_SETTINGS_REL),
  ]);
}

/** The retired PROJECT settings file: the flat file beside the new directory. */
export function retiredProjectSettingsPath(cwd: string): string {
  return join(cwd, RETIRED_FLAT_SETTINGS_REL);
}
