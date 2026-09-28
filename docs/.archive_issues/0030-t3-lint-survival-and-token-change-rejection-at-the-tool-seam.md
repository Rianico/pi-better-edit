# T3: Lint-survival and token-change rejection at the tool seam

> **Archived from pre-migration issue #30.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-16T07:52:23Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

Part of #28 — Whitespace-insensitive anchors (ASCII strip, no fingerprint) — spec.

## What to build

End-to-end integration coverage proving the whitespace-insensitive canon changes real edit behavior at the tool seam. The whitespace-survival behavior is implemented by the canon change (T1); this ticket makes it verified externally: an edit followed by an external whitespace-only rewrite followed by another edit on the same region applies directly (no `[E_STALE_ANCHOR]`, no re-read), while token-level changes still reject exactly as today. Includes the measured edit → lint → edit loop now passing, plus regression tests for the boundary cases that must NOT become invisible.

## Acceptance criteria

- [ ] Integration test: read → external whitespace-only rewrite (prettier or plain write) → edit with pre-lint anchors applies without rejection (the edit → lint → edit loop from the spec measurement).
- [ ] Integration test: read → brace-merge rewrite (`func hello()` + `{` on its own line → `func hello() {`) → edit with pre-lint anchor rejects with `[E_STALE_ANCHOR]`.
- [ ] Integration test: string-content whitespace change (`"x y"` → `"xy"`) rejects — string contents remain significant.
- [ ] Integration test: chained edits after a format pass still work without re-read.
- [ ] All tests drive the real tool-execution seam (`setupIntegrationTest` + `withTempFile`, or the `makeSeamPi`/`tool_result` patterns), asserting on result text / error text / final file state — not internal served-record contents.
- [ ] `npm run typecheck && npm test` green on the feature branch.

## Blocked by

- T1 (#29) — the canon change this ticket verifies.

## Notes

Tests only — the behavior is implemented by the canon change. If a test exposes behavior that is wrong (e.g. brace-merge silently verifying, or chained edits breaking), that is a T1 defect: report it back rather than working around it.


## Comments

### @Rianico — 2026-08-16T08:23:46Z

Implemented in 4aeb33e on branch t3-lint-survival.

**Test file:** test/integration/whitespace-insensitive-tool-seam.test.ts (3 tests, all at the real tool-execution seam).

**Coverage delivered:**
1. edit -> external whitespace-only rewrite (prettier-style reindent via writeFile) -> second edit on the same target with pre-rewrite anchors applies without E_STALE_ANCHOR and without re-read — the measured loop, now green.
2. brace merged onto the signature line (func hello() + { own line -> func hello() {) -> edit with pre-rewrite anchor rejects with E_STALE_ANCHOR — token-level changes stay visible.
3. chained edits through format churn: edit, tool_result delivered, external whitespace-only rewrite, then a second edit on a diff-served line (gamma) applies without re-read.

**Verification:** typecheck clean; eslint clean; full suite 1012 passing (baseline 1009 + 3 new, no regressions).

**Behavior defect found (reported, not worked around): criterion 3 as written is not achievable under the implemented canon.** The ticket's acceptance criterion 'string-content whitespace change ("x y" -> "xy") rejects — string contents remain significant' does NOT hold: ADR-0005's strip-all canon removes the space INSIDE the string too, so `const s = "x y";` and `const s = "xy";` canonicalize identically (both strip to consts="xy";) and the edit silently applies. Probe confirmed: edit after that rewrite succeeds, no rejection. This contradicts the ADR-0005 consequence claim that string contents remain detectable — that claim is factually wrong for whitespace-within-strings. This is a spec/ADR wording issue (the linter-only workflow makes it benign in practice, since formatters never alter string contents), not a T1 implementation bug. Options for the orchestrator: (a) accept and update ADR-0005 consequence wording + this criterion, or (b) revisit lexer-scoped stripping. I did not ship a test asserting the opposite.
