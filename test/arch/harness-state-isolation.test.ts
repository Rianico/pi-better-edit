/**
 * Dev-only harnesses must not be able to touch the developer's real state (#190).
 *
 * The state pass reads retired sources from `$HOME` and `$XDG_CONFIG_HOME` as well as from the
 * override, DELETES `.corrupt-*` dumps, and the settings ladder renames retired settings files to
 * `.bak`. A script that pins only `PI_BETTER_EDIT_CONFIG_DIR` therefore still has the walk of the
 * real `~/.config/pi-better-edit` behind it: running a benchmark could delete the developer's dumps
 * and move their log and their settings file. Pinning the override is only half the sandbox, so the
 * other half is one shared map (`scripts/lib/sandbox-env.mjs`), and this guard keeps every harness
 * that names the override on it.
 *
 * WHY the map is asserted by EXECUTING the helper in a child process instead of importing it: it is
 * a script-side `.mjs`, outside the TypeScript program (`tsconfig.json` includes `index.ts`, `src`
 * and `test`), so a typed import cannot see it — and the guard should read the real object the
 * harnesses spread into `env`, so a pin dropped from the helper fails here rather than in a
 * benchmark run that has already deleted something.
 *
 * WHY the source scan rather than a benchmark run: `bench-adopt` seeds a 100k-line fixture and
 * measures for minutes, so what is guarded is the seam — the helper is the only place a pin can be
 * added or lost, and the scan proves each harness hands that map to the process it runs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = "scripts";
const HELPER = join(SCRIPTS, "lib", "sandbox-env.mjs");
const OVERRIDE = "PI_BETTER_EDIT_CONFIG_DIR";
const SANDBOX = "/tmp/pbe-sandbox-probe";

const PINNED = [
  OVERRIDE,
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
] as const;

/** The retired-source names that must never be spelled outside the shared map. */
const COMPANION = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR"] as const;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name)) out.push(path);
  }
  return out;
}
/**
 * The harnesses: the dev-only `bench-*` entries and the runtime harness — the scripts whose job is to
 * RUN the extension (they import `../index` / `../src/**`, spawn the bundle they built, or spawn
 * `pi`). Opening the store is what runs the retired-source walk, so every one of them has to carry
 * the whole sandbox. The pure in-memory micro-benchmarks import nothing from the repo and reach none
 * of it, so they are correctly absent; the helper is skipped because it DEFINES the pins.
 */
const harnesses = sources(SCRIPTS).filter((file) => {
  const name = basename(file);
  if (!/^bench-.*\.(?:mjs|ts)$/.test(name) && name !== "runtime-edge-test.mjs") return false;
  const source = readFileSync(file, "utf-8");
  return (
    /from "\.\.\/(?:index|src\/)/.test(source) ||
    /scripts\/bench-[\w-]+\.ts/.test(source) ||
    /spawnSync\(\s*"pi"/.test(source)
  );
});

/** The map a harness spreads into `env`, read back from the helper itself. */
function sandboxMap(): Record<string, string> {
  const printed = execFileSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(`./${HELPER}`)}).then((m) => process.stdout.write(JSON.stringify(m.sandboxEnv(${JSON.stringify(SANDBOX)}))))`,
    ],
    { encoding: "utf-8", cwd: process.cwd() },
  );
  return JSON.parse(printed) as Record<string, string>;
}

describe("the sandbox map is the whole sandbox (#190)", () => {
  it("points every environment variable the retired walk reads at the sandbox", () => {
    const env = sandboxMap();

    expect(Object.keys(env).sort()).toEqual([...PINNED].sort());
    for (const name of PINNED) expect(env[name], name).toBe(SANDBOX);
  });
});

describe("every harness that can reach state is sandboxed (#190)", () => {
  it("finds the harnesses it is meant to guard", () => {
    expect(harnesses.length).toBeGreaterThanOrEqual(8);
  });

  it("takes the override and its companions from one map", () => {
    for (const file of harnesses) {
      const source = readFileSync(file, "utf-8");

      expect(source, `${file} does not import the sandbox map`).toMatch(
        /from "\.{1,2}\/lib\/sandbox-env\.mjs"/,
      );
      expect(source, `${file} runs without the sandbox map`).toMatch(/sandboxEnv\(/);
    }
  });

  it("never spells the override or a retired-source base by hand", () => {
    for (const file of harnesses) {
      const source = readFileSync(file, "utf-8");

      for (const name of [OVERRIDE, ...COMPANION]) {
        expect(source, `${file} pins ${name} outside the sandbox map`).not.toMatch(
          new RegExp(`${name}:`),
        );
      }
      expect(source, `${file} assigns the override outside the sandbox map`).not.toMatch(
        new RegExp(`process\\.env\\.${OVERRIDE} =`),
      );
    }
  });

  it("names every pin once, in the helper", () => {
    const source = readFileSync(HELPER, "utf-8");

    for (const name of PINNED) expect(source, name).toContain(name);
  });
});
