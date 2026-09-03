# Anchor canon unchanged — whitespace-insensitive anchors rejected

Date: 2026-08-16

## Status

superseded by ADR-0005 (whitespace-insensitive anchors adopted for the linter-only workflow)

## Context

After measuring that prettier-style formatting rotates anchors for ~93–98% of the lines it touches (the motivation for ADR-0003), we re-examined whether the anchor should strip ASCII whitespace `[ \t\r\n]`. Reject-and-serve already handles formatting churn correctly (one extra round-trip, zero correctness risk), and the measured win only helps the *external-formatter-between-read-and-edit* case, not the common agent-driven flow where writes/edits re-serve fresh anchors anyway.

## Decision

We decided **no: the anchor canon stays as-is** (`canon()` = strip `\r` + trim trailing whitespace). The anchor-stripping half of the two-signal design is rejected.

### Considered Options

- **Keep the anchor as-is (chosen)** — verification semantics unchanged: any content change, including `"x y"` → `"xy"` inside a range, stays a detectable change. No schema migration, no collision pressure from strip-all (which would make `func(a, b)` and `func(a,b)` canonically identical and blur survivor/removed-hash reuse). Existing reject-and-serve handles formatting staleness: reject, echo fresh rows (which count as serves), retry without re-read.
- **Strip-all anchors (ADR-0003)** — only helps when an external formatter runs between the model's read and edit. Costs: weakened in-range verification (whitespace-only changes silently verified as unchanged — exactly what ADR-0001 exists to catch), a two-value schema on every served line, and model-context-vs-disk divergence. Even at the measured 98% success, the remaining token-level changes (quotes, semicolons, wrapping, arrow-parens) still rotate.
- **Fingerprint-only as an additional informational drift signal** — pure addition: keep the anchor unchanged, add a raw-line hash used only to tell the model "this line changed in whitespace", never for verification. Not adopted now; revisit only if external-format churn between reads and edits demonstrably hurts and retry round-trips are measurably annoying.

## Consequences

- The code (`src/hashline/hash.ts`, `src/hashline/served.ts`, `src/served-state.ts`) stays on the trailing-trim canon; no schema or serve-path change. ADR-0003 is superseded and must not be implemented as written.
- Formatting staleness continues to surface as `E_STALE_RANGE` rejections with fresh served rows — the designed, working mechanism.
- If the fingerprint-only signal is later adopted, it is informational only: it never changes verification meaning, never rejects, and never suppresses an anchor-based notice.
