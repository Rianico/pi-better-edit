# ADR-0025 — Rename `tombstone` to `blockedHashes` (term and diagnosis)

Date: 2026-09-29

## Status

accepted — pure-rename decision required by issue [#17](https://github.com/Rianico/pi-better-edit/issues/17) (enhancement, ready-for-agent). Supersedes the *names* used in [ADR-0013](0013-pos-free-roundtrip-optimization.md), [ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md), and every earlier record that says `tombstone`; those ADRs stay byte-identical as historical records. No behavior, control flow, or semantics change.

## Context

"The tombstone is dead; long live the blocked hashes." — the term promised death it never delivered.

The `tombstone` set never marks deleted or lease-terminal state: it is the per-session set of hashes freed since the last full `read`, kept alive so a freed anchor never re-binds (hash-allocation guard) and as a verification signal at the library-level seam. Lease-terminal state is owned by `retirement` (`retired_at`). A name that reads as a terminal marker was actively misleading — issue #17 asks for `blockedHashes` / "blocked hashes", which says what the set does: the hash is blocked from re-allocation.

## Decision

1. **Term and identifiers.** Every live use of `tombstone` becomes `blockedHashes` (identifier, case-adjusted: `Tombstone` → `BlockedHashes`, `TOMBSTONE` → `BLOCKED_HASHES`, `tombstoned` → "blocked hash"/"blocked-hash") — `loadTombstone` → `loadBlockedHashes`, `getTombstoneInner` → `getBlockedHashesInner`, `throwStaleForTombstone` → `throwStaleForBlockedHash`, `batchTombstone` → `batchBlockedHashes`, and the integration file `test/integration/batch-legacy-tombstone.test.ts` → `batch-legacy-blocked-hashes.test.ts`.
2. **Diagnostic contract.** The `RangeCause` union member and emitted value `cause: "tombstone"` becomes `cause: "blocked-hash"` (`src/domain-errors.ts`, produced in `src/hashline/served-verification.ts`, asserted across `test/core/`).
3. **Glossary.** The `CONTEXT.md` entry `tombstone` becomes **blocked hashes** with a single `formerly tombstone` alias line; that alias is the only intentional survivor in the live term set, alongside ADR-citation pointers in comments/tests.
4. **History.** Existing `docs/adr/*.md`, `CHANGELOG.md` entries, and `docs/.archive_issues/` records are untouched historical records. `README.md`, `docs/spec/content-addressed-line-identity-mvcc.md`, and `docs/spec/stale-identity-reject-and-serve.md` describe live contracts and were renamed with the code.

## Consequences

- Readers of old ADRs and changelog entries meet `tombstone`; the alias line in `CONTEXT.md` and this ADR keep the mapping traceable.
- The `details.cause: "blocked-hash"` value is a contract-visible rename: any consumer matching the old string must move to `blocked-hash`.
- Issue #10's separate decision — whether the verification signal itself should be removed — is untouched here; if the signal is later removed, it goes under this name.
