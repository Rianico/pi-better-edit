# [bug] git install resolves zero extensions: pi.extensions points at a gitignored dist/

> **Archived from pre-migration issue #163.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-22T20:29:06Z · state CLOSED · labels: bug, ready-for-agent, released

## Body

## Summary

2.2.0 — `pi install git:github.com/Rianico/pi-better-edit` → pi loads **zero** extensions from the package, so the built-in `read`/`edit` are used instead of the hash-anchored ones. No error, no warning.

## Environment

- Version: 2.2.0 (introduced in 2.1.0 by 8cdc716 / #160)
- Module: `package.json` → `pi.extensions: ["./dist/index.js"]`
- Command: `pi install git:github.com/Rianico/pi-better-edit`

## Steps to Reproduce

1. `pi install git:github.com/Rianico/pi-better-edit`
2. Inspect the checkout: `ls ~/.pi/agent/git/github.com/Rianico/pi-better-edit/dist` → absent. `dist` is gitignored and nothing builds it during a git install (`prepare` is `husky || true`).
3. Resolve the package through pi's own resolver (`DefaultPackageManager.resolveExtensionSources([<clone>], { temporary: true })`).

## Expected behavior

The clone resolves the declared extension entry, or pi reports that the declared entry is missing.

## Actual behavior

`extensions resolved: 0`. pi's package path (`collectPackageResources` → `addManifestEntries` → `collectFilesFromManifestEntries`, `dist/core/package-manager.js:1801-1920`) drops declared paths that do not exist on disk, and unlike the auto-discovery path (`resolveExtensionEntries`, `dist/core/extensions/loader.js:546`) it has no `index.ts` fallback. It is silent.

Git checkouts cannot be repaired locally either: `cleanAndInstallGitDependencies` (`package-manager.js:1577`) runs `git clean -fdx` + `npm install` on every ref-moving update, so an untracked `dist/` is deleted.

npm installs are unaffected — `files` ships `dist` inside the tarball.

## Fix

Ship the extension from source: `pi.extensions: ["./index.ts"]` — pi's documented model (no bundler in `docs/packages.md`; every `examples/extensions/*/package.json` uses `./index.ts`), then drop `tsdown`/`verify-dist` and the CI build steps.

Cost, measured on this machine with `PI_TIMING=1` (same tree, 3 launches each):

| entry | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| `dist/index.js` | 705ms | 481ms | 449ms |
| `index.ts` | 704ms | 665ms | 666ms |

≈200ms per pi launch, paid once per process (the extension factory is memoized in `extensionCache`), not per tool call. The 1090ms→490ms figure in #160 came from a synthetic jiti harness on a different machine and does not reproduce here.


## Comments

### @github-actions — 2026-09-27T13:09:33Z

:tada: This issue has been resolved in version 2.3.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.3.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
