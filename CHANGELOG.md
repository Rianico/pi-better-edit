# Changelog

All notable changes to this project will be documented in this file.

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
