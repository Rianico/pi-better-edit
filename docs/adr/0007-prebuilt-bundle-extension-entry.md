# 0007. Prebuilt Bundle Extension Entry Across Install Surfaces

Date: 2026-10-30

## Status

Accepted

## Context

`pi-better-edit` is installed across two distinct deployment surfaces:
1. **npm package installation**: Installed into the global pi agent environment via `pi install npm:pi-better-edit`.
2. **Git repository installation**: Installed directly from source checkouts or submodules via `pi install git:...` or `pi -e ./dist/index.js`.

Relying on runtime TypeScript transpilation (e.g. `jiti`, `tsx`, or `esbuild-register`) introduced substantial startup delays (>800ms) on every agent launch and introduced fragile runtime dependencies on host compiler toolchains. Furthermore, an earlier attempt to maintain dual entry points (pointing npm to compiled JavaScript and git checkouts to raw TypeScript) caused severe installation regressions where git installations resolved zero extensions (recorded in historical issue #37, [`docs/.archive_adrs/0027-prebuilt-bundle-is-the-extension-entry-on-both-install-surfaces.md`](../.archive_adrs/0027-prebuilt-bundle-is-the-extension-entry-on-both-install-surfaces.md)).

## Decision

We will compile and distribute a prebuilt JavaScript bundle at `dist/index.js` as the exclusive extension entry point for both installation surfaces, built automatically at install/pack time via `prepare`.

1. **Prebuilt Bundle via esbuild**: The extension source is bundled into `dist/index.js` using `esbuild` (`scripts/build-dist.mjs`). Host packages are kept external and runtime dependencies (`diff`, `file-type`, `unbash`, `xxhash-wasm`) are resolved via the registry, inlining only the project's internal TypeScript sources.
2. **Unified Entry Point Configuration**: In `package.json`, both the package `main` field and the pi extension declaration point directly to the prebuilt bundle:
   ```json
   {
     "main": "./dist/index.js",
     "pi": {
       "extensions": ["./dist/index.js"]
     }
   }
   ```
3. **Install-Time `prepare` Hook**: Because `dist/` is gitignored (`.gitignore`) and never committed to the repository, the bundle is compiled automatically via `pnpm run prepare` (`scripts/prepare.mjs`) during package installation and packing. This ensures fresh git checkouts build `dist/index.js` before pi's extension scanner checks the manifest path.
4. **Performance Gate**: Extension initialization latency is monitored via `scripts/measure-import.mjs`, enforcing an import budget with warm startup measured at 425–436 ms (bounded by `--max-artifact-ms 600`).

### Considered Options

- **Runtime TypeScript transpilation (`jiti`/`tsx`)** — rejected: excessive startup latency and fragile dependency graphs on clean host environments.
- **Dual entry points (TS for git, JS for npm)** — rejected: caused divergence and resulted in git installations failing to resolve extensions.
- **Committing `dist/index.js` to git** — rejected: causes merge conflicts on every PR, pollutes git history with large binary-like diffs, and risks stale artifacts.

## Consequences

- Consistent extension entry and behavior across npm and git checkouts.
- Zero runtime compilation overhead on clean host environments.
- Warm startup latency strictly budgeted under 600 ms.
- Development workflows require running `pnpm run build` after modifying source code, guarded by CI verification gates.
