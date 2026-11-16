/**
 * The environment a dev-only harness must pin before it runs the extension (#190).
 * More than `PI_BETTER_EDIT_CONFIG_DIR`: the upgrade's retired sources resolve
 * through `$HOME` and `$XDG_CONFIG_HOME`, and the state pass deletes `.corrupt-*`
 * dumps while the settings ladder renames retired files to `.bak`.
 *
 * One map rather than five assignments per script, because the set is a contract
 * with `src/config-dir.ts`; `test/arch/harness-state-isolation.test.ts` holds every
 * harness to it. The sandbox directory also serves as `HOME` and the agent dir, so
 * that no real location is reachable.
 */
export function sandboxEnv(dir) {
  return {
    PI_BETTER_EDIT_CONFIG_DIR: dir,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_STATE_HOME: dir,
    PI_CODING_AGENT_DIR: dir,
  };
}
