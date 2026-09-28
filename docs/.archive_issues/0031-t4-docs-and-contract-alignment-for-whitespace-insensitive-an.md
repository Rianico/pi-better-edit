# T4: Docs and contract alignment for whitespace-insensitive anchors

> **Archived from pre-migration issue #31.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-16T07:52:34Z · state CLOSED · labels: ready-for-agent, released

## Body

## Parent

Part of #28 — Whitespace-insensitive anchors (ASCII strip, no fingerprint) — spec.

## What to build

Documentation and contract alignment for the whitespace-insensitive canon. The README's hash-derivation prose must describe the ASCII-whitespace-stripping canon instead of the old strip-`\r`-and-trim-end form, the error-code contract test (which enforces the README) must stay green, and CONTEXT.md's anchor-philosophy language must reflect the implemented model per ADR-0005. ADR-0005 itself is already committed on the feature branch.

## Acceptance criteria

- [ ] README hash-derivation section describes ASCII-whitespace stripping (`[ \t\r\n]`) and that string/regex/comment contents and Unicode whitespace remain significant.
- [ ] README anchor-stability/guidelines prose does not contradict ADR-0005 (no fingerprint, verification unchanged, token-level changes still reject).
- [ ] The error-code contract test against the README passes unchanged (error codes themselves do not change).
- [ ] CONTEXT.md `anchor philosophy` entry reflects ASCII-whitespace-stripped content derivation (ADR-0005 language).
- [ ] `npm run typecheck && npm test` green on the feature branch.

## Blocked by

- T1 (#29) — the canon whose contract this documents.


## Comments

### @Rianico — 2026-08-16T08:21:54Z

Implemented in b8fb8a0 on branch t4-docs (isolated worktree).

**Changes:**
- README 'How anchors work': now describes ASCII-whitespace stripping (`[ \t\r\n]` — spaces, tabs, CR, LF), that string/regex/comment contents and Unicode whitespace (NBSP) remain significant, and that token-level changes (quote style, semicolons, arrow-parens, wrapping, brace merges) still rotate anchors and reject. No fingerprint; verification and error codes unchanged.
- CONTEXT.md 'anchor philosophy': updated to 'content-derived with ASCII whitespace stripped, stable for unchanged lines and across whitespace-only formatting'; notes byte-level detection of non-whitespace changes is unchanged. No fingerprint/whitespace-only-drift terms added.
- Reviewed remaining README guidelines/re-read prose (drift notices, chained edits, on-demand recovery) — consistent with ADR-0005, no stale trailing-whitespace-only claims found.

**Verification:** error-code contract test (bidirectional README↔src code match, 19 codes each) green; typecheck clean; full suite 1009 passed | 1 skipped (baseline match). First full run showed a flaky single-file failure not reproducible on re-run (JSON reporter clean) — see residual risk.

**Commit:** b8fb8a0 — DOCS: whitespace-insensitive anchor canon in README + glossary — issue #31

### @github-actions — 2026-09-01T15:45:14Z

:tada: This issue has been resolved in version 1.4.3 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v1.4.3)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
