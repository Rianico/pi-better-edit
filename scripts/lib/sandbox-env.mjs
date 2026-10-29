/**
 * The environment a dev-only harness must pin before it runs the extension (#190).
 *
 * WHY more than the override: `PI_BETTER_EDIT_CONFIG_DIR` moves the settings root and the state
 * root, but it does NOT move the RETIRED sources the upgrade walks — those are read from `$HOME`
 * and `$XDG_CONFIG_HOME` — and the state pass DELETES `.corrupt-*` dumps while the settings ladder
 * renames retired files to `.bak`. A harness that pinned only the override therefore ran with the
 * developer's real `~/.config/pi-better-edit` behind it: `node scripts/bench-adopt.mjs` could delete
 * their abandoned dumps and move their log and their `~/.pi/agents/pi-better-edit.json` away.
 *
 * WHY one map rather than five assignments per script: the set is a contract with `src/config-dir.ts`
 * (the module that names every one of these variables), so a script that spells four of them and
 * forgets the fifth is the exact defect this file removes. `test/arch/harness-state-isolation.test.ts`
 * holds every harness to it.
 *
 * WHY the sandbox directory is also `HOME` and the agent dir, rather than a fresh path per variable:
 * the point is that NO real location is reachable, and one directory is the cheapest way to say that
 * — every retired source, the settings file and the store all resolve inside it.
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
