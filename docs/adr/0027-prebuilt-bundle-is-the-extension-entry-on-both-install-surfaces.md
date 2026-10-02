# ADR-0027 — Prebuilt bundle is the extension entry on both install surfaces

Date: 2026-10-02

## Status

accepted — required by issue [#37](https://github.com/Rianico/pi-better-edit/issues/37) (enhancement). Reverses the revert shipped in 2.3.0 for the git-install regression recorded at [`0156`](../.archive_issues/0156-feat-ship-pre-bundled-dist-index-js-in-published-package-to.md) → [`0163`](../.archive_issues/0163-bug-git-install-resolves-zero-extensions-pi-extensions-point.md); that revert was recorded only in release notes, which is why the same proposal was re-derived from scratch. No older ADR is modified.

## Context

**The cost (measured, pi 0.99.1).** The extension entry is TypeScript source, so pi transpiles ~67 modules through jiti on every session start: 806 ms of `module import`, the largest single extension and 48% of total extension load (all extensions 1665 ms). The driver is per-module evaluation, not source size: a one-line extension through the same loader costs 13 ms warm, while the same source bundled into one module costs 425–436 ms warm (766 ms cold) against 1077 ms warm (1893 ms cold) for source. jiti caches transforms in the OS temporary directory, so every number is stated with its cache state.

**The constraints — not visible in the code, and the reason this ADR exists.**

1. Two install surfaces with different jobs: a git source clone, which the maintainer installs to verify current source, and the npm tarball, which general users install.
2. pi's git install runs the package manager's install with devDependencies omitted for every supported manager — npm `install --omit=dev --legacy-peer-deps`, pnpm `install --prod --config.auto-install-peers=false`, bun `install --omit=dev --omit=peer` — after `git clean -fdx`. npm 11.19.0 and pnpm 12.5.1 both still run the root `prepare` under those exact arguments, and a `prepare` that needs a devDependency fails, failing the install.
3. pi silently drops manifest entries whose path does not exist, and its dependency-repair path compares only `dependencies` against `node_modules`, so a missing build artifact is invisible and never repaired. That is the 2.2.0 regression: `pi.extensions` pointed at a gitignored build output, `git clean -fdx` removed it, and the install resolved zero extensions with no message — permanently.
4. pi aliases host-provided packages to its own copies and passes that alias map to the extension loader; a vendored copy builds a second module graph (measured upstream at 720 ms of 838 ms).
5. pi has no source-map support, so a bundle cannot be stepped through back to its source.
6. The package manager pi uses for git installs comes from its `npmCommand` setting, not from repository lockfiles.

## Decision

The built bundle is the only extension entry, on both surfaces, and it is produced at install or publish time by the package's `prepare` lifecycle rather than committed.

1. `pi.extensions` and `main` point at the built artifact. `prepare` builds it: the git install runs it through the package manager, the tarball runs it through pack/publish. The artifact stays gitignored and is never committed.
2. The build must not depend on devDependencies being present. It prefers a locally installed bundler binary and otherwise provisions a pinned bundler through an isolated throwaway install prefix. It must exit non-zero rather than skip when it cannot produce the artifact — a silent skip recreates constraint 3 permanently.
3. The manifest keeps a single entry path, with no fallback to source.
4. Host-provided packages stay external and are declared as optional peers plus devDependencies, never runtime dependencies, so no user installs a bundler or a duplicate host graph.
5. Source debugging stays available without touching the manifest: pi accepts explicit extension file paths that bypass discovery.

### Considered Options

- Rejected: commit the built artifact.
  - Pros: no build at install time, no install-time network, the clone always has the artifact.
  - Cons: the artifact goes stale between releases, so the git surface — installed to verify current source — would verify the previous release's bundle; and a build artifact lands in every diff.
  - Why not: it defeats the purpose of the surface it is meant to serve.
- Rejected: keep the repository manifest on source and rewrite it at pack time so only the tarball uses the artifact.
  - Pros: no install-time build, no artifact risk, the clone keeps running source.
  - Cons: the git surface stays at 806 ms, and the two surfaces run different code.
  - Why not: it optimizes only users and never exercises the shipped artifact on the surface that exists to verify it.
- Rejected: reduce the source module count instead of shipping an artifact.
  - Pros: no artifact, no pipeline change, no install-time build, no gitignore hazard.
  - Cons: a source restructure with an unknown ceiling.
  - Why not: once the artifact is the entry on both surfaces, module count no longer affects startup, so the restructure would buy nothing. Recorded here as the answer to "why not just merge the files?".
- Rejected: a fallback entry (artifact first, source second) as a safety net.
  - Pros: a missing artifact degrades to source instead of zero extensions.
  - Cons: it depends on constraint 3's silent skip, and the tarball would not carry the source fallback anyway.
  - Why not: failing loudly is the right posture for a missing artifact, and building on a known defect invites a future break.

## Consequences

- Extension load drops to the artifact's cost on both surfaces (~430 ms warm against 806 ms), and an npm install gains nothing to build and no bundler in its dependency tree.
- New install-time requirement: the build needs registry access to provision its pinned bundler. Offline or registry-restricted environments fail the install loudly instead of silently shipping nothing. Load-bearing assumptions: the pinned bundler stays fetchable, and it preserves `node:` specifier prefixes — a bundler that rewrote them to bare specifiers broke 2.1.0.
- `prepare` running under pi's install arguments is observed, not contractual: verified for npm and pnpm, unverified for bun. An install smoke must cover each supported package manager, and the manager pi selects comes from its `npmCommand` setting.
- The clone and a working copy both load the artifact, so source is no longer step-debuggable from either (constraint 5). Debugging uses explicit source paths.
- A stale artifact in a working copy is a failure mode source mode did not have; a freshness check must fail verification.
- Revisit this decision if pi gains a manifest fallback, an install-time build hook, install-time devDependencies, or source-map support — each would change the failure posture or the single-entry rule.
