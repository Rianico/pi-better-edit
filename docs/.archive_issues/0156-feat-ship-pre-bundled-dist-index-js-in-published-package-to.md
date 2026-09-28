# [feat] Ship pre-bundled dist/index.js in published package to cut startup latency

> **Archived from pre-migration issue #156.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @wfzyx on 2026-09-21T23:50:51Z · state CLOSED · labels: released

## Body

### Problem — is your request related to a problem?
`pi-better-edit` publishes 55 raw TypeScript source files to npm with `"main": "index.ts"` and `"pi": { "extensions": ["./index.ts"] }`.

When Pi boots, its extension loader (`jiti` with `moduleCache: false`) parses, transforms, and evaluates all 55 TypeScript modules sequentially. Profiling startup via `PI_TIMING=1` reveals this takes **~1,300ms** on every CLI invocation:

```
--- Startup Timings: extensions ---
  .../pi-better-edit/index.ts module import: 1297ms
  .../pi-better-edit/index.ts factory: 2ms
```

### Proposal — describe the solution you'd like
Add a build step before publishing (e.g. `tsup` or `esbuild`) that emits a single `dist/index.js`, externalizing runtime dependencies (`@earendil-works/*`, `typebox`, `diff`, `file-type`, `xxhash-wasm`), and point `"main"` and `"pi.extensions"` in `package.json` to `./dist/index.js`.

### Benchmark Results
Pre-bundling drops extension import time from **1,297ms** to **25ms** (-98%):
```
--- Startup Timings: extensions ---
  .../pi-better-edit/dist/index.js module import: 25ms
  .../pi-better-edit/dist/index.js factory: 1ms
```

## Comments

### @Rianico — 2026-09-22T07:50:06Z

Thanks for this report — it's accurate, well-evidenced, and it turned out to matter more than the latency number alone. I went through it, reproduced the measurements, and then hit something worth flagging before anyone merges the current PR.

## Your diagnosis checks out

| Claim | Verdict | Evidence |
|---|---|---|
| `main: "index.ts"`, `pi.extensions: ["./index.ts"]` | correct | `package.json` |
| Ships raw TS to npm | correct, count now stale | published `2.0.0` tarball carries **61** `.ts` files (you said 55) |
| ~1,300 ms extension import | correct | measured **1082 / 1090 / 1096 ms** |

I reproduced the timing through pi's actual loader path (`jiti@2.7.0`, `createJiti(import.meta.url, { moduleCache: false })`, `jiti.import(entry, { default: true })` — matching `loader.js:416-427`), so the number is real and the root cause is exactly what you identified.

One small methodology note, only so the benchmark is reproducible: `PI_TIMING=1` isn't the gate in `pi-coding-agent@0.85.1`. `dist/core/timings.js` reads `const ENABLED = process.env.n === "1"`, and printing additionally needs `PI_STARTUP_BENCHMARK=1` in interactive mode. As written the command produces no output.

## Blocking issue in the current PR

`tsup`'s `removeNodeProtocol` **defaults to `true`** and installs a plugin that rewrites every `^node:` specifier to a bare one:

```
src/hash-store.ts:1   import { DatabaseSync } from "node:sqlite";
dist/index.js:634     import { DatabaseSync } from "sqlite";       ← prefix stripped
```

`sqlite` is not a package and not a dependency, so the extension can't load. Packing the current PR and installing it into a clean consumer with all declared deps present:

```
LOAD FAILED: Cannot find module 'sqlite'
```

pi's `pi.extensions` entry point throws on import, so `read`, `edit`, `undo_last_edit` and `read_skill` all disappear. Worse than the latency it fixes.

The reason CI stayed green is that nothing in the repo ever imports the build output — `pnpm pack --dry-run` proves the build *exited 0*, which is treated as correctness. `rg -l 'dist/index.js|tsup' test/ scripts/ .github/` returns zero hits.

## The patch

I pushed [`build/prebundle-tsdown-guard`](https://github.com/Rianico/pi-better-edit/tree/build/prebundle-tsdown-guard), which merges your PR and reworks the bundler:

**tsdown instead of tsup.** tsup's README now says it's not actively maintained and points at tsdown. Beyond that it's a smaller change than it sounds: tsdown reuses `rolldown@1.2.7`, which is already in `main`'s lockfile via `vite@8.2.2` (`rolldown: ~1.2.4`) — so no second bundler engine is added, and the lockfile delta is **+20 package names vs tsup's +26**. It also derives externals from `dependencies`/`peerDependencies`, so the hand-maintained 6-entry `external` array goes away.

**`publint: true`** runs as part of the build. Worth knowing it catches a *different* class than the `node:` bug: I ran publint against the broken artifact and it reports clean. What it does catch is entry-resolution drift — tsdown defaults ESM output to `.mjs`, so without `outExtensions` you get `pkg.main is dist/index.js but the file does not exist`, failed at build time.

**`scripts/verify-dist.mjs`**, wired into `prepack` and CI. It rejects unresolvable bare specifiers, imports the built entry, and resolves every prompt asset reference the bundle makes (11 of them — they load via `new URL("../prompts/*.md", import.meta.url)`, which only works because `dist/` sits exactly one level below the package root). I verified it's refutable by stripping `node:` from the built artifact: it fails with `dist/index.js has unresolvable bare specifiers: crypto, fs, fs/promises, os, path, sqlite`.

Verified end to end — packed, installed into a clean project, loaded through pi's loader: `LOAD OK — factory: function`. Full gate green: 1544 tests pass, lint/format/typecheck clean.

## Two corrections to my own earlier numbers

Being straight about this, since the framing in the original report leaned on the speedup:

- **The gain is ~55%, not 98%.** Unbundled ~1090 ms → bundled ~490 ms warm (~760 ms on first run in a fresh consumer). A 25 ms figure is reachable only for a warm re-import in the same process (measured: #1 = 742 ms, #2 = 1 ms) — Node's ESM registry cache, which a CLI cold start doesn't have.
- **Bundler choice has no runtime effect.** Measured with alternating runs in one worktree: tsup ~495–499 ms vs tsdown ~487–488 ms, i.e. within noise. The win comes from bundling at all; tsdown is chosen for maintenance and the artifact guard, not speed.

## Open question

`files` still lists `index.ts` and `src`, so the tarball now ships `dist` *in addition to* 61 raw `.ts` files: 148.1 KB → 218.3 KB. Dropping them fully addresses the payload half of your issue but breaks anyone deep-importing `pi-better-edit/src/*`, so I left it out. Happy to do it if you'd prefer the tarball slimmed.

Also note `CHANGELOG.md` appears in the branch diff — `main` is currently out of sync with its own commits (`changelog-unreleased.py check` reports drift on `main` today), and the `changelog-check` PR gate requires it regenerated. That's a pre-existing condition, not something this work introduced.


### @github-actions — 2026-09-22T09:38:21Z

:tada: This issue has been resolved in version 2.1.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.1.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
