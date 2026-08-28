# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.2.3] - 2026-08-28

### Fixed

- allow _-prefixed unused exports and scoped no-comments for publish

### Changed

- wire semantic-release (conventionalcommits) with pinned release workflow


## [1.2.2] - 2026-08-28

### Fixed

- address P1 blocking — error-swallowing + SAFETY for as-unknown-as + unknown returns
- harden path traversal and ReDoS via root containment and bounded RegExp, tighten CI permissions
- propagate errors after log instead of swallowing undefined
- prune deadcode via knip whitelist and barrel dedupe
- add node: prefix and .js extensions to relative imports
- reduce complexity via helper extraction and early returns
- fix nits — console, typos (ALPH→ALPHA), prefer-at, slice-copy and style

### Changed

- remove deprecated agent skills (coding-protocol, keel, show-me) — .pi/ is source of truth
- ignore .lsz/ ephemeral artifacts
