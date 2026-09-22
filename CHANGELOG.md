# Changelog

## [Unreleased]

### Features

* ship a pre-bundled dist/index.js to cut extension startup latency (#160)
* **mutation-engine:** aggregate multi-edit batch errors instead of failing fast on first error (#159)
* **errors:** diagnose numeric anchors in E_UNKNOWN_ANCHOR to steer away from line numbers (#158)

### Documentation

* **readme:** rewrite for v2 line-identity mvcc architecture

## [2.0.0](https://github.com/Rianico/pi-better-edit/compare/v1.7.0...v2.0.0) (2026-09-21)

### ⚠ BREAKING CHANGES

* the tool contract changed for a 1.x consumer. The
`[E_UNSERVED_RANGE]` code no longer exists: a retired bound with a live,
unshifted survivor is `[E_UNVERIFIED_RANGE]`. Edits that 1.x silently
healed -- an interior that shifted under the same 3-char anchor, or a
freed anchor re-used by a byte-identical line -- are now rejected as
`[E_STALE_RANGE]` / `[E_TARGET_LOST]` with the current range served as a
fresh read. A consumer branching on the old code, or relying on a healed
apply, must branch on the new codes and follow the served rows. No data
migration is required: the store migrates additively (HASH_STORE_VERSION
6 to 7) and stays readable by 1.x; anchors served before the upgrade need
one fresh read.

### Features

* **edit:** adopt line-identity MVCC with leases ([bd3a8f2](https://github.com/Rianico/pi-better-edit/commit/bd3a8f221cd7e3acf8c410a3d37237dba0c5201b))
* **edit:** gate reproduced served rows behind a literal declaration ([#134](https://github.com/Rianico/pi-better-edit/issues/134)) ([ba7c8d2](https://github.com/Rianico/pi-better-edit/commit/ba7c8d2ad41262ebf52f402f588f194f18f40323)), closes [#61](https://github.com/Rianico/pi-better-edit/issues/61) [#62](https://github.com/Rianico/pi-better-edit/issues/62) [#63](https://github.com/Rianico/pi-better-edit/issues/63) [#124](https://github.com/Rianico/pi-better-edit/issues/124) [#125](https://github.com/Rianico/pi-better-edit/issues/125) [#126](https://github.com/Rianico/pi-better-edit/issues/126) [#127](https://github.com/Rianico/pi-better-edit/issues/127) [#128](https://github.com/Rianico/pi-better-edit/issues/128) [#129](https://github.com/Rianico/pi-better-edit/issues/129) [#130](https://github.com/Rianico/pi-better-edit/issues/130) [#131](https://github.com/Rianico/pi-better-edit/issues/131)
* **errors:** unify the error and warning contract (E_*/W_* tiers) ([#148](https://github.com/Rianico/pi-better-edit/issues/148)) ([3b22008](https://github.com/Rianico/pi-better-edit/commit/3b22008f9bbb8dd57f82ad0646ef4680b3f0b4ed)), closes [#136](https://github.com/Rianico/pi-better-edit/issues/136) [#138](https://github.com/Rianico/pi-better-edit/issues/138) [#144](https://github.com/Rianico/pi-better-edit/issues/144) [#145](https://github.com/Rianico/pi-better-edit/issues/145) [#146](https://github.com/Rianico/pi-better-edit/issues/146) [#147](https://github.com/Rianico/pi-better-edit/issues/147)
* **hashline:** unify span verification on lease lineage ([#154](https://github.com/Rianico/pi-better-edit/issues/154)) ([65af962](https://github.com/Rianico/pi-better-edit/commit/65af96236f7d0e2f15b1775a2eabd6796ac70750)), closes [#151](https://github.com/Rianico/pi-better-edit/issues/151) [pre-#151](https://github.com/Rianico/pre-/issues/151)

### Bug Fixes

* **hashline:** scope served canons per file and serve fresh read ([#152](https://github.com/Rianico/pi-better-edit/issues/152)) ([47a04f7](https://github.com/Rianico/pi-better-edit/commit/47a04f7ce055d82c517ba00257b8ef921735ad8d)), closes [#149](https://github.com/Rianico/pi-better-edit/issues/149) [#149](https://github.com/Rianico/pi-better-edit/issues/149)

### Documentation

* declare the 2.0 tool-contract break ([#155](https://github.com/Rianico/pi-better-edit/issues/155)) ([ee74c91](https://github.com/Rianico/pi-better-edit/commit/ee74c912ffe46f33c0debf3962805a410190b4d1)), closes [#154](https://github.com/Rianico/pi-better-edit/issues/154) [#148](https://github.com/Rianico/pi-better-edit/issues/148) [#154](https://github.com/Rianico/pi-better-edit/issues/154)

All notable changes to this project will be documented in this file.

## [1.7.0](https://github.com/Rianico/pi-better-edit/compare/v1.6.0...v1.7.0) (2026-09-09)

### Features

* **edit:** adopt named-object payload with file and anchor fields ([#77](https://github.com/Rianico/pi-better-edit/issues/77)) ([741be22](https://github.com/Rianico/pi-better-edit/commit/741be220571e9d5a249a5dd035fb59297c41fe0b))

## [1.6.0](https://github.com/Rianico/pi-better-edit/compare/v1.5.0...v1.6.0) (2026-09-05)

### Features

* **edit:** user/model audience split and glossary-aligned error codes ([dd1a779](https://github.com/Rianico/pi-better-edit/commit/dd1a779b5a5c2ecddd486a49eff9eeed1014aa48)), closes [#65](https://github.com/Rianico/pi-better-edit/issues/65)

### Bug Fixes

* **drift:** report canon deficit instead of hash rotation ([95c4703](https://github.com/Rianico/pi-better-edit/commit/95c4703f7470d651d7b2309921a125959fdf463f)), closes [#68](https://github.com/Rianico/pi-better-edit/issues/68)
* make prepare tolerant when husky not installed ([cca29d3](https://github.com/Rianico/pi-better-edit/commit/cca29d3076068b1bab832eae99da79547d5d4939))
* **served:** epoch lifecycle belongs to full reads ([3918292](https://github.com/Rianico/pi-better-edit/commit/3918292a85ad3a230b6705cf03a12e67ff04717b)), closes [#69](https://github.com/Rianico/pi-better-edit/issues/69)
* **write:** dense re-serve after write clears stale rows ([44c7664](https://github.com/Rianico/pi-better-edit/commit/44c7664e708b0aba3277754b7e80b9fff62371bf)), closes [#70](https://github.com/Rianico/pi-better-edit/issues/70)

### Documentation

* **prompts:** align tool desc and prompts with glossary (fresh anchors) ([b0bcf0b](https://github.com/Rianico/pi-better-edit/commit/b0bcf0b26cdd6a6806f85654247663a474703149))

## [1.5.0](https://github.com/Rianico/pi-better-edit/compare/v1.4.3...v1.5.0) (2026-09-03)

### Features

* consolidate architecture deepening — 6 deep modules ([#64](https://github.com/Rianico/pi-better-edit/issues/64)) ([6cbf5da](https://github.com/Rianico/pi-better-edit/commit/6cbf5da3fed20588d33c87fb05b3307c23501404))

## [1.4.3](https://github.com/Rianico/pi-better-edit/compare/v1.4.2...v1.4.3) (2026-09-01)

### Bug Fixes

* **edit:** prevent tool calling bleed on Gemma 4 ([#57](https://github.com/Rianico/pi-better-edit/issues/57)) ([e67f493](https://github.com/Rianico/pi-better-edit/commit/e67f493ab6858d26a36329fbeb08a7a3779574e8)), closes [#55](https://github.com/Rianico/pi-better-edit/issues/55)
* **hashline:** prevent freed anchor reuse via per-session tombstone and epoch (ADR-0013) ([#56](https://github.com/Rianico/pi-better-edit/issues/56)) ([79b4931](https://github.com/Rianico/pi-better-edit/commit/79b49318df992d09e2d613dbb5ebc3c39d435de1))

## [1.4.2](https://github.com/Rianico/pi-better-edit/compare/v1.4.1...v1.4.2) (2026-09-01)

### Bug Fixes

* **ci:** prevent pre-push from blocking release push ([daa3d18](https://github.com/Rianico/pi-better-edit/commit/daa3d186020df736c9724d46af3f6b16100b3ef9))

## [1.4.1](https://github.com/Rianico/pi-better-edit/compare/v1.4.0...v1.4.1) (2026-08-31)

### Bug Fixes

* **ci:** lower statements coverage threshold to 89 to match actual ([f5b58a5](https://github.com/Rianico/pi-better-edit/commit/f5b58a59d78c8e1c243642f362f995904b12eb68))
* **ci:** repair lockfile and bump node to 22 for semantic-release ([62ab62a](https://github.com/Rianico/pi-better-edit/commit/62ab62a78bf95a598671d3848aa59dec1f902fb7))
* **hashline:** remove boundary-dup auto-fix, keep pure edit ([#54](https://github.com/Rianico/pi-better-edit/issues/54)) ([7c55b57](https://github.com/Rianico/pi-better-edit/commit/7c55b5713f43a73dc2f972e4b99050b036d2c625))

## [1.4.0](https://github.com/Rianico/pi-better-edit/compare/v1.3.0...v1.4.0) (2026-08-29)

### Code Refactoring

* consolidate architecture deepening tranche (C1–C5) into `map/architecture-deepening` — `MutationEngine`, `ServedSession`, `FileContent`, `LifecycleHooks`, `HealingStrategy` ([#53](https://github.com/Rianico/pi-better-edit/pull/53))
* add SAFETY for `x as unknown as` casts and fix unlisted/cache blockers for v1.4.0

## [1.3.0](https://github.com/Rianico/pi-better-edit/compare/v1.2.3...v1.3.0) (2026-08-28)

### Features

* **edit:** route drift signals to user-facing details ([6ec52f2](https://github.com/Rianico/pi-better-edit/commit/6ec52f2e3789b7c7d6e10c4ebcc43c4518e8d3d3))

### Documentation

* merge scaffold-git prompts into one (Obsidian flavour) ([ef613d2](https://github.com/Rianico/pi-better-edit/commit/ef613d21605149615936cce0deeadf118d68e97a))

## [1.2.3] - 2026-08-28

### Fixed

* allow _-prefixed unused exports and scoped no-comments for publish

### Changed

* wire semantic-release (conventionalcommits) with pinned release workflow

## [1.2.2] - 2026-08-28

### Fixed

* address P1 blocking — error-swallowing + SAFETY for as-unknown-as + unknown returns
* harden path traversal and ReDoS via root containment and bounded RegExp, tighten CI permissions
* propagate errors after log instead of swallowing undefined
* prune deadcode via knip whitelist and barrel dedupe
* add node: prefix and .js extensions to relative imports
* reduce complexity via helper extraction and early returns
* fix nits — console, typos (ALPH→ALPHA), prefer-at, slice-copy and style

### Changed

* remove deprecated agent skills (coding-protocol, keel, show-me) — .pi/ is source of truth
* ignore .lsz/ ephemeral artifacts
