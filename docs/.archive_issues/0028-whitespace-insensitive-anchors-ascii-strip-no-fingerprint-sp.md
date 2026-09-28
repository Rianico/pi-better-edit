# Whitespace-insensitive anchors (ASCII strip, no fingerprint) — spec

> **Archived from pre-migration issue #28.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-16T07:50:45Z · state CLOSED · labels: ready-for-agent

## Body

# Whitespace-insensitive anchors (ASCII strip, no fingerprint)

## Problem Statement

In workflows where an external formatter runs between the model's edits (editor format-on-save, CI, a watcher — the linter being the only external writer), every whitespace-only lint pass rotates anchors under the current canon (strip `\r` + trim trailing whitespace). Measured: an edit followed by `prettier --write` followed by another edit on the same region rejects with `[E_STALE_ANCHOR]` and demands a full `read()`. On this repo's own source, ~93–98% of the lines prettier touches change only in whitespace, so the rejection/re-read tax is recurring in exactly these workflows.

## Solution

Compute line anchors from the line with **ASCII whitespace (`[ \t\r\n]`) removed**, so formatting that only moves whitespace does not rotate the anchor. Verification, served state, reject-and-serve, and drift all keep their current semantics — the only change is the anchor's canonical form. Because the workflow assumption is a formatter as the sole external writer (which never alters semantics), **no fingerprint is added** (ADR-0005); token-level changes (quotes, semicolons, arrow-parens, wrapping, a brace merged onto a signature line) still rotate the anchor and are rejected exactly as today.

## User Stories

1. As a model editing a file, I want my anchors to survive a formatter that reindents or respaces my target lines, so that I do not get rejected with `[E_STALE_ANCHOR]` and forced to re-read after every lint pass.
2. As a model, I want a whitespace-only change on disk (leading indentation, internal spacing, trailing whitespace) to keep the anchor valid, so that my next edit applies directly.
3. As a model, I want a token-level change on disk (quote style, semicolon, arrow-parens, line wrapping, a brace moving from its own line onto the signature line) to still rotate the anchor and be rejected, so that verification never silently applies against content I have not been shown.
4. As a model, I want string literal contents, regex classes, and comment text to remain significant even when they differ only by whitespace, so that `"a b"` vs `"ab"` never verify as the same line.
5. As a model, I want NBSP and all Unicode whitespace to remain significant, so that exotic-whitespace bugs stay detectable.
6. As a model, I want the stable mapping to reuse hashes for lines that differ only in whitespace across an edit, so that chained edits without re-read keep working through format churn.
7. As a model, I want a line that is only whitespace and a genuinely blank line to still hash identically (as today), so that blank-line handling is unchanged.
8. As a model, I want the rejection feedback (`[E_STALE_ANCHOR]`, `[E_RANGE_STALE]`, `[E_RANGE_UNSERVED]`) and their echo rows to behave exactly as before, so that reject-and-serve still terminates without re-read.
9. As a developer, I want pre-change cached hash snapshots to be invalidated on upgrade, so that a file read after the canon change never gets served old-canon hashes from the store.
10. As a developer, I want the whole-file `contentChecksum` (snapshot cache key) to stay raw, so that a whitespace-only format pass still hits the cache.
11. As a developer, I want the duplicate-boundary stripping and new-edge finding in the apply path to key on the stripped canon consistently, so that edit auto-corrections do not behave differently after the change.
12. As a maintainer, I want the README's canon description and the error-code contract test to stay aligned with the new canon, so that documentation and enforced behavior do not drift.
13. As a maintainer, I want the anchor-philosophy language in CONTEXT.md to reflect ASCII-whitespace stripping, so that the glossary matches the implemented model.

## Implementation Decisions

- **Canon change (the core):** the single canonicalization function strips all ASCII whitespace (`[ \t\r\n]`) from the line before hashing, replacing the current strip-`\r`-and-trim-end form. This one function is the only behavior change; it propagates consistently to hashing, stable survivor/removed-hash reuse, duplicate-boundary stripping, and new-edge finding because they all already key on it.
- **No fingerprint, no schema change:** served state stays one value per line; verification and drift semantics are unchanged. ADR-0005 (accepted) records the decision; ADR-0003/0004 are superseded.
- **Snapshot-cache invalidation:** the snapshot store keys on `(path, whole-file checksum, line_count)` where the checksum is raw xxHash64 — unchanged by this feature. Because the canon changed, a **canon version** must participate in cache identity (folded into the key, or a schema/cache version bump reusing the existing store-version machinery) so pre-change cached hashes are rebuilt on next read rather than served as valid.
- **Unicode safety:** stripping is ASCII-only. NBSP, ideographic spaces, and all other Unicode whitespace remain in the anchor.
- **In-flight rotation:** at upgrade, all served rows re-derive (anchors rotate once); per-session served state is short-lived (cleared at session start / TTL-swept), so no served-store migration is needed — only snapshot-cache invalidation.
- **Behavioral risk to watch:** strip-all canon makes more lines canonically identical, so duplicate-boundary stripping in the apply path becomes more aggressive (e.g. `func(a, b)` and `func(a,b)` now "match"). Verify this does not change edit outcomes for legitimately distinct lines; adjust the strip's uniqueness checks if needed.
- **Test seams (all existing):** the hashline pure seam for canon/stable-mapping units; the tool-execution integration seam (`setupIntegrationTest` + `withTempFile`, and the `tool_result`-handler seam for serve recording) for external behavior; the store seam for snapshot-cache invalidation. No new seams.

## Testing Decisions

- **What makes a good test:** external behavior at the highest seam — drive read/edit through the tool-execution seam against a real temp file, mutate the file on disk between calls, assert on result text / error text / final file state; never assert internal served-record contents through tool tests.
- **Hashline core (pure seam):** canon strips leading/internal/trailing ASCII whitespace; `func hello` vs `func  hello` vs `  func hello` hash identically; NBSP and Unicode whitespace differ; whitespace-only lines still hash as blank lines; stable mapping reuses hashes across whitespace-only differences and rotates on token changes; duplicate-boundary stripping does not mis-handle lines that differ only in whitespace.
- **Tool-execution seam (behavior):** read → external whitespace-only rewrite (prettier or plain write) → edit with pre-lint anchors applies without rejection (the edit → lint → edit loop from the measurement); read → brace-merge rewrite → edit rejects with `[E_STALE_ANCHOR]`; string-content whitespace change (`"x y"` → `"xy"`) rejects; chained edits after a format pass still work without re-read.
- **Store seam:** a snapshot written under the old canon version is invalidated/rebuild on next read after the version bump; raw checksum still hits the cache across whitespace-only changes.
- **Contract seam:** the error-code contract test against the README stays green; README canon prose updated to match.
- **Prior art:** hashline.hash / hashline-stable-mapping / hashline.apply unit tests; served-truncation-chained and served-truncation-external-shrink integration tests (the `makeSeamPi`/`tool_result` patterns); snapshot-store tests; error-codes contract test.

## Out of Scope

- **Fingerprint / two-signal design** — rejected (ADR-0005); a future workflow with concurrent human writers may revisit it.
- **Fuzzy matching, lexer-scoped stripping, or semantic line equivalence** — rejected by the anchor philosophy (ADR-0001).
- **Served-store schema migration** — not needed; in-flight anchors rotate once, per-session state is short-lived.
- **Concurrent multi-agent writers** — workflow-level concern (git worktrees); the linter-only assumption is load-bearing.
- **Formatters changing tokens** (quote style, semicolons, wrapping, brace merges) — intentionally still visible rejections.

## Further Notes

- Design authority: ADR-0005 (accepted), ADR-0001, ADR-0002. Glossary terms: anchor, anchor philosophy, served state, reject-and-serve, boundary staleness, range staleness, drift.
- Measurement backing the decision: `prettier@3` on this repo's `src/` — ~93–98% of changed lines are whitespace-only under strip-all; the edit→lint→edit loop was reproduced with the real tool seam and real prettier.
- The linter-only assumption is the load-bearing boundary: the moment a human or other agent can edit files concurrently, whitespace-only semantic changes become invisible and the fingerprint option returns.


## Comments

### @Rianico — 2026-08-16T08:25:57Z

**Spec correction (found during T3 implementation, verified):** the acceptance criterion 'string-content whitespace change (`"x y"` → `"xy"`) rejects — string contents remain significant' is **not achievable** under the strip-all canon: ASCII whitespace inside string literals is stripped too, so `const s = "x y";` and `const s = "xy";` canonicalize identically and the edit silently applies (verified: both hash QJ3). This is benign under the linter-only assumption (formatters never alter string contents) and ADR-0005's consequence wording has been corrected accordingly. The criterion is replaced by: **string-content changes that are not whitespace-only (letters, punctuation) still rotate and reject** — which T3 does not assert, and which is covered by the general token-level rejection property.
