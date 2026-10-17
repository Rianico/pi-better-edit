# ADR-0040 — Read payload: one canonical shape, and the model-facing schema as a cheap surface

Date: 2026-10-17

## Status

accepted — operator grill Q1–Q15. Extends the tolerant-admission design of
`docs/spec/search-and-read-evolution.md` §4.2 and removes the legacy aliases that design introduced.
Implementation tracks #142; the render-projection fix that makes this safe ships separately in #141.

Superceded by [41. Read payload flat file target with windows and top level mode](0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md)

## Context

The `read` tool has carried **three argument shapes at once**:

1. **Model-facing schema** — `files`/`mode` as canonical, *plus* `file`, `path`, top-level `offset`,
   `limit` and `windows`, which the schema itself labelled "legacy; prefer `files`".
2. **Admission** — `admitReadRequest` folded every accepted shape into `files` on a copy, so that
   caps, window resolution and row serving saw exactly one shape. It also emitted `legacyPage`, a
   surviving page ask used by the render path.
3. **Render projection** — a separate mapping onto pi's builtin single-file renderer, which reads
   `file_path ?? path` plus `offset`/`limit`.

When the multi-file payload became canonical (`d272b1c`, #79), the schema and admission were
migrated but the render projection was not, so the TUI call line lost its target path entirely
(#141). The migration also revealed the cost of the union: two shapes to publish, one shape to
normalize, a third to render — and a normalizer whose only reason to exist was the union.

## Decision

**D1 — The model-facing schema accepts exactly one shape.**
`{ files: [{ file, windows?, mode? }], mode? }`. The legacy `file`, `path`, top-level `offset`,
`limit` and `windows` fields are removed from `readToolSchema`.

**D2 — The admission fold is deleted.**
With a single accepted shape there is nothing to normalize. A legacy-only payload is rejected by
the schema and pinned by one test asserting that rejection; the removal must be a stated contract,
not an absence.

**D3 — The render projection tolerates recorded history.**
Rendering derives from the canonical payload and additionally falls back to `files?.[0]?.file ??
file ?? path`. Transcripts store the arguments actually sent, so a session recorded before D1 must
still render its target. This tolerance is **history**, not model compatibility: it is invisible to
the schema and costs one `??` chain.

**D4 — Multi-file calls render the first target.**
No synthetic `(+N more)` suffix: pi's builtin header is a `Text` with `setText` but no public
getter, so it cannot be post-processed, and a bespoke header would diverge from pi's TUI. A
collapsed line showing one of N targets is honest; inventing a format is not.

**D5 — The model-facing schema is a cheap surface.**
The model re-reads the schema every session and there is no compiled client, so adding or removing
a field is a MINOR change at most — never `!`. This is scoped: **cheap** means the input schema,
the tool descriptions and the rendered row format the model consumes; **not cheap** means recorded
history (D3) and pinned removals (D2). Recorded in `AGENTS.md`.

**D6 — The fold's support structure goes with it.**
`legacyPage` becomes unreachable once no payload can produce it. It is not detectably dead by
reference counting (the render path still names it), so no tool will flag it: it must be removed
deliberately, in the same change, or it becomes a record claiming legacy pages still exist.
`LEGACY_WINDOW_LIMIT` is the exception the original sentence missed: beyond the fold it is also
the default for a canonical `{ offset }` window that names no `limit`, so it stays — renamed to
`DEFAULT_WINDOW_LIMIT` so no `LEGACY_` name survives the collapse.

> Correction note (#142): the accepted version of D6 claimed both symbols were undetectable as
> dead. That is true of `legacyPage` and false of the window-limit constant, whose canonical
> uses (the window schema description and `admitWindow`'s omitted-limit default) outlive the
> fold. Corrected in the PR that implemented the removal.

**D7 — Versioning: `feat`-class, MINOR, with a ledger entry.**
"Cheap to change" is a statement about compatibility risk, not visibility: the model-visible
contract does change shape, and the changelog is where that moment should be findable. No breaking
marker.

## Consequences

- The model sees one shape; downstream code has one shape to cap, resolve and serve.
- Old transcripts keep rendering their targets (D3); new calls cannot produce a legacy shape (D1).
- Migrating the repo's own call sites is mechanical but large — 336 of 512 `readTool.execute` calls
  across 88 test files. Completeness is proven by the suite (a missed site fails loudly once the
  fold is gone) plus a one-shot zero-hit grep at acceptance; no permanent CI gate, because the
  schema already prevents the shape from returning.
- `docs/spec/search-and-read-evolution.md` §4.2 ("Tolerant Runtime Admission & Limits") defines the
  deleted fold and must be amended in the same change — the same defect class as a spec paragraph
  describing behaviour the code no longer has.
- Render tests must exercise the **canonical** payload; legacy-shape cases remain as additive
  coverage and may never be the only coverage of a render path.
