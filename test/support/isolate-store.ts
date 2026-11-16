/**
 * Worker-level hash-store isolation (#89): the harness owns it, not each fixture call site — 73
 * test files go through `setupIntegrationTest` and 5 through `setupReadTest` (measured), plus
 * every ad-hoc `withTempFile`, and one forgotten stub is how runs came to open the developer's
 * real store and race live pi sessions ("database is locked", observed 4708ms). Pinning the seam
 * at setupFiles time also covers module-scope store access, before any test module is imported.
 *
 * HOW: `PI_BETTER_EDIT_CONFIG_DIR` and `HOME` point at fresh `mkdtemp` dirs and
 * `XDG_STATE_HOME`/`XDG_CONFIG_HOME` are cleared, because the RETIRED sources are still read from
 * them (adoption, #190). Three stubs, no real path reachable; a test needing a fresh dir per CALL
 * clears the seam with an empty `PI_BETTER_EDIT_CONFIG_DIR`.
 */
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Registry {
  readonly dirs: Set<string>;
  hookInstalled: boolean;
}

const holder = globalThis as typeof globalThis & { __piBetterEditStoreRegistry?: Registry };
const registry: Registry = (holder.__piBetterEditStoreRegistry ??= {
  dirs: new Set<string>(),
  hookInstalled: false,
});

const workerStoreDir = await mkdtemp(join(tmpdir(), "pi-better-edit-store-"));
const workerHomeDir = await mkdtemp(join(tmpdir(), "pi-better-edit-home-"));
process.env.PI_BETTER_EDIT_CONFIG_DIR = workerStoreDir;
process.env.HOME = workerHomeDir;
process.env.XDG_STATE_HOME = "";
process.env.XDG_CONFIG_HOME = "";
process.env.PI_CODING_AGENT_DIR = "";
globalThis.fetch = (async () => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
registry.dirs.add(workerStoreDir);
registry.dirs.add(workerHomeDir);

function cleanup(): void {
  for (const dir of registry.dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  registry.dirs.clear();
}

if (!registry.hookInstalled) {
  registry.hookInstalled = true;
  process.on("exit", cleanup);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      cleanup();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
