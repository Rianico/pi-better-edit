/**
 * The two directories this extension owns, and the only module that names any of their paths.
 *
 * WHY two roots rather than one: settings belong to the pi agent tree (an operator reads them
 * beside the other extensions they configure), while the store, the legacy JSON and the
 * diagnostics log are STATE — machine-written, disposable, and never edited by hand. The XDG
 * state directory is where a machine-written artifact belongs, and keeping settings out of it is
 * what stops a `rm -rf` of the state root from deleting the user's configuration.
 *
 * WHY this is its own module rather than a corner of `hash-store.ts`: the diagnostics sink has to
 * answer "where is my directory?" on its very first line, and `hash-store.ts` is one of its
 * callers. Importing the directory rule from the store made a cycle (diagnostics → hash-store →
 * hash-identity → diagnostics) whose partial initialisation reached the schema as `undefined`
 * columns. The directory rule has no dependency on the store, so it lives where nothing forces a
 * cycle: below both of them.
 *
 * WHY every RETIRED path is spelled here too: `test/arch/config-ladder-single-owner.test.ts` pins
 * exactly one module naming the config-file locations. A second copy of a retired literal is how
 * an adoption chain silently reads a path nobody meant it to.
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
 * The retired per-user directory: it held the settings file AND every state artifact, which is
 * exactly the coupling this relocation breaks. Read once for adoption, never written again.
 */
export function retiredConfigRoot(): string {
  return join(homeBase(), ".config", "pi-better-edit");
}

/** The retired FLAT settings location, relative to either a project root or the home directory. */
const RETIRED_FLAT_SETTINGS_REL = ".pi/agents/pi-better-edit.json";

/**
 * The retired global settings files, strongest first: the old XDG config directory, then the
 * even older flat `$HOME/.pi/agents/` one. WHY ordered here rather than at the call site: the
 * adoption chain is a contract, and a caller that reordered it would adopt a different file than
 * its neighbour.
 */
export function retiredGlobalSettingsPaths(): readonly string[] {
  return [
    join(retiredConfigRoot(), "pi-better-edit.json"),
    join(homeBase(), RETIRED_FLAT_SETTINGS_REL),
  ];
}

/** The retired PROJECT settings file: the flat file beside the new directory. */
export function retiredProjectSettingsPath(cwd: string): string {
  return join(cwd, RETIRED_FLAT_SETTINGS_REL);
}
