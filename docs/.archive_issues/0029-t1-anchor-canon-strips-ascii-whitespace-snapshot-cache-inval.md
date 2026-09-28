# T1: Anchor canon strips ASCII whitespace + snapshot-cache invalidation

> **Archived from pre-migration issue #29.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-16T07:52:10Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

Part of #28 — Whitespace-insensitive anchors (ASCII strip, no fingerprint) — spec.

## What to build

Line anchors are computed from a new canonical form that strips all ASCII whitespace (`[ \t\r\n]`), replacing the current strip-`\r`-and-trim-end form. The change lives in the single canonicalization function and propagates consistently to hashing, stable survivor/removed-hash reuse, duplicate-boundary stripping, and new-edge finding. In addition, the snapshot cache gains canon-version awareness so that hash snapshots written under the old canon are rebuilt on next read — never served as valid after the upgrade — while the raw whole-file checksum continues to cache across whitespace-only changes. Served state keeps one value per line; no fingerprint, no schema change (ADR-0005).

## Acceptance criteria

- [ ] The canonicalization function strips `[ \t\r\n]`; `func hello`, `func  hello`, `  func hello`, and `func hello ` hash identically.
- [ ] NBSP and all Unicode whitespace remain significant (differ from ASCII-space equivalents).
- [ ] Whitespace-only lines still hash as blank lines; genuinely blank lines unchanged.
- [ ] Stable mapping reuses hashes across whitespace-only differences and rotates on token-level differences.
- [ ] Duplicate-boundary stripping and new-edge finding behave correctly for lines that differ only in whitespace (no mis-stripping of legitimately distinct lines).
- [ ] A hash snapshot written under the old canon version is invalidated/rebuild on next read after the canon bump.
- [ ] The raw whole-file checksum still hits the snapshot cache across whitespace-only changes.
- [ ] Existing hashline/hash/stable-mapping/apply unit tests updated and green; new units cover the above.
- [ ] `npm run typecheck && npm test` green on the feature branch.

## Blocked by

None — can start immediately.


## Comments

### @Rianico — 2026-08-16T08:14:12Z

Implemented in 1b92f4f on feat/whitespace-insensitive-anchors.

**Changes:**
- `canon()` strips all ASCII whitespace `[ \t\r\n]` (leading, internal, trailing, tabs, CRLF) — replaces strip-\r-and-trim-end.
- `CANON_VERSION = 2` folded into the snapshot cache key (`cacheKey` in snapshot-store): pre-change cached hashes are never served as valid after the canon bump; the raw whole-file xxHash64 checksum is unchanged and still caches across whitespace-only changes.
- New regression tests: `test/core/whitespace-insensitive-canon.test.ts` (whitespace variants hash identically, NBSP/Unicode significant, stable-mapping reuse vs rotation, snapshot cache invalidation); existing hash-store/hashline.hash tests updated to the new canon.

**Verification:** typecheck clean; 1009 passing (was 1001). No duplicate-stripping behavior change observed — the new canon tests cover the brace-merge boundary (line with a merged token does NOT match).
