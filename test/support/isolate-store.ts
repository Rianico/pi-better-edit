/**
 * Worker-level hash-store isolation (#89).
 *
 * WHY this file exists at all, instead of stubbing HOME at each fixture call site: isolation belongs
 * to the harness, not to each call site. Store-touching call sites are many — 73 test files go
 * through setupIntegrationTest and 5 through setupReadTest (measured with `grep -rl 'setupIntegrationTest('
 * test/ --include=*.test.ts`), plus every ad-hoc `withTempFile` — and each new call site can forget the
 * stub, which is exactly how test runs came to open the developer's real store at
 * ~/.config/pi-better-edit/hash-store.sqlite and race live pi sessions ("database is locked",
 * observed 4708ms). Pinning the seam once at setupFiles time also covers code that never touches the
 * fixtures at all, and module-scope store access, because setup files are imported (and awaited)
 * before the test module is.
 *
 * HOW: point PI_BETTER_EDIT_CONFIG_DIR (read by configDir() in src/hash-store.ts) at a fresh temp dir
 * for each evaluation (per test file under the default isolate: true). The variable names the app
 * config dir itself, so it needs no suffix.
 *
 * GRANULARITY and the guarantee. Guaranteed: every evaluation of this module allocates its own fresh
 * directory with mkdtemp under the OS temp root and publishes it as PI_BETTER_EDIT_CONFIG_DIR before
 * the test module is imported; configDir() returns that value verbatim while it is non-empty, so the
 * store path cannot be derived from HOME, XDG_CONFIG_HOME or the cwd and cannot be a pre-existing
 * config dir. Isolation therefore holds at any granularity and under any pool setting, however many
 * files share one dir or however often one is re-allocated. Granularity only decides how often a fresh
 * dir appears: under the default isolate: true the module registry resets per test file, so allocation
 * happens per file (measured with a two-file probe) — nothing asserts two files get different dirs,
 * because the safety property does not rest on that.
 *
 * THE OPT-OUT RULE: a test needing a store dir fresh per CALL must clear the seam with an empty
 * PI_BETTER_EDIT_CONFIG_DIR. Those needs arise when a test asserts the store file does not exist yet,
 * counts rows across a whole table, or reads a plan cached under a fixed path. The current set is
 * enumerated by `grep -rlE 'PI_BETTER_EDIT_CONFIG_DIR("?, ""| = "")' test/ --include=*.test.ts` —
 * re-measure rather than trusting a count.
 */
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Registry {
  readonly dirs: Set<string>;
  hookInstalled: boolean;
}

// The module registry is reset per test file (isolate: true), so the registry must outlive it.
const holder = globalThis as typeof globalThis & { __piBetterEditStoreRegistry?: Registry };
const registry: Registry = (holder.__piBetterEditStoreRegistry ??= {
  dirs: new Set<string>(),
  hookInstalled: false,
});

const workerStoreDir = await mkdtemp(join(tmpdir(), "pi-better-edit-store-"));
process.env.PI_BETTER_EDIT_CONFIG_DIR = workerStoreDir;
registry.dirs.add(workerStoreDir);

function cleanup(): void {
  for (const dir of registry.dirs) {
    // Best-effort: a leftover temp dir is untidy rather than harmful, and nothing can report a
    // failure from a shutdown path.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // swallow on purpose
    }
  }
  registry.dirs.clear();
}

if (!registry.hookInstalled) {
  registry.hookInstalled = true;
  // WHY the signal handlers and not just `exit`: the forks pool tears workers down with SIGTERM,
  // and a signal's default disposition terminates the process WITHOUT running `exit` listeners —
  // measured, exit-only cleanup left one temp dir per worker behind. Clean up, then re-raise the
  // signal with our listener removed so the worker still dies of the signal it was sent.
  process.on("exit", cleanup);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      cleanup();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
