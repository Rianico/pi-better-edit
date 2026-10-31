# Two-signal line identity: whitespace-stripped anchors + raw fingerprints

Date: 2026-08-16

## Status

superseded by ADR-0005 (anchor-strip adopted; fingerprint dropped)

## Context

Lint passes (prettier, black, eslint --fix) mostly rewrite whitespace — measured on this repo's own source, ~93–98% of lines prettier changed rotate their anchor under the old canon because the change was internal or leading whitespace, which trailing-trim did not absorb.

## Decision

We decided that line anchors are computed from the line with ASCII whitespace (`[ \t\r\n]`) stripped, so formatting survives, while a second, tool-internal **fingerprint** (the hash of the raw line, whitespace included) preserves byte-level change detection; verification runs on anchors, and a fingerprint mismatch alone is informational drift, never a rejection.

### Considered Options

- **Strip all whitespace, no fingerprint** — maximal lint survival, but empirically makes `"x y"` vs `"xy"`, `\s+` vs `\+`, and 4-space vs 8-space Python nesting hash identically: the tool silently verifies as "unchanged" ranges whose runtime behavior changed. Rejected: that is the exact failure ADR-0001 exists to prevent.
- **Two signals (chosen)** — the anchor absorbs ASCII whitespace (lint survives); the fingerprint sees every byte change (staleness stays honest). A whitespace-only change re-serves the current row but does not rotate the anchor, so retry needs no re-read.
- **Lexer-scoped stripping** (strip only outside string/regex/template tokens) — most precise, but requires a per-language tokenizer; disproportionate for the common case. Not taken.

## Consequences

- The served-store schema and serve-recording paths carry two values per line (anchor, fingerprint); the fingerprint is never shown to the model.
- Drift is two-tier: anchor differs = token-tier notice (always fires); anchor same but fingerprint differs = whitespace-only drift (quieter tier, never a rejection, never suppresses the token tier).
- Stripping is ASCII-only: NBSP and all Unicode whitespace remain significant in both signals.
- The whole-file `contentChecksum` (snapshot cache key) stays raw — only per-line anchor computation strips.
- `E_STALE_RANGE`/`E_UNSERVED_RANGE` rejection logic is unchanged: it keys on anchors. Whitespace-only changes do not reject.
