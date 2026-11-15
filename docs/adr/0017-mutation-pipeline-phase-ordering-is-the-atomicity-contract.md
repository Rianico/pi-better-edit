# ADR-0017. Mutation Pipeline Phase Ordering Is the Atomicity Contract

Date: 2026-11-15

## Status

Accepted

Relates to [0001. Content-Addressed Line Identity (CAS/MVCC)](0001-content-addressed-line-identity-cas-mvcc.md) and [0004. Model-Tool Boundary and Error Protocol](0004-model-tool-boundary-and-error-protocol.md)

## Context

`src/mutation-engine/pipeline.ts` carried a 59-line `SAFETY:` file header that documented a symbol named `EditPipeline`. That symbol no longer exists in the file, so the header failed its own premise: a `SAFETY:` tag justifies a cast or an assertion the compiler cannot check, and this one guarded nothing. `rg -n 'EditPipeline' src/mutation-engine/pipeline.ts` matched the comment and nothing else.

The header was still the repository's only statement of mutation phase order. It recorded which phase owns which guarantee, why the order is load-bearing, and which invariants a reorder breaks. Deleting it to satisfy a comment cap would have deleted that contract. It was also the single longest comment block in `src/` — 59 lines against a 12-line cap — so it blocked the cap itself.

The measurements behind this conversion come from `.lane/replies/20261115T090259352078Z-reviewer-90941295.md` and `.lane/replies/20261115T090029584736Z-reviewer-cc505aac.md`: 1,106 `/** */` blocks in `src/`, of which 18 sit inside a function body, 67 exceed 12 lines, and exactly one is this header. The archived [ADR-0028](../.archive_adrs/0028-correlated-multifile-cut-transaction-durability.md) owns the multi-file cut durability rule the Persist phase names.

## Decision

We will hold the mutation pipeline's phase ordering in a decision record rather than in a file header, and cite it from the source with one `// Ref: docs/adr/0017-mutation-pipeline-phase-ordering-is-the-atomicity-contract.md` line.

1. **The ordering is the contract.** The phase list below is normative. A reorder is an architecture change, not a refactor: it must update the drift, undo and serve invariants in the same commit or it is wrong.
2. **The citation is a path, not a number.** A comment that names an ADR by bare number rots silently when the record moves; a path is resolvable by the reader and checkable by a test. `docs/.archive_adrs/` moves already rotted this repository's own tooling once.
3. **The record keeps its provenance.** Rationale lives here with its measurements; the source keeps one line. A `SAFETY:` tag is reserved for byte-level risk that only a human can verify, never for documentation prose.
4. **No phase gains filesystem atomicity.** The Persist phase is ordered and repairable, not atomic across files; the archived ADR-0028 record stands and nothing here claims otherwise.

### The phase ordering (preserved verbatim)

```text
Deepened pipeline that hoists the whole edit mutation behind one
seam: load → parse → span gate (batches) → mutate loop → finalize
hashes → drift → persist. Cohesive stage owners live beside the
orchestration: `edit-source.ts` (file load, lease identity source,
session-key boundary), `batch-span-gate.ts` (baseline span
resolution, batch disjointness, working-buffer identity), and
`edit-response.ts` (model-facing batch envelope: abort wrappers,
atomicity trailer, batch sections). `recordRejectionServe` and the
mutate loop stay here with the orchestration.

Phase ordering is load-bearing — do not reorder without updating
drift/undo/serve invariants:

  Admission (edit.ts: TypeBox + assertReq)
    → Foreign pre-pass (`materializeForeignReferences`: when any item names
      another served file, that SECOND file is read and lease-resolved here,
      memoized per resolved path — a read-only load ahead of Load whose
      refusal aborts the whole call before the target is even read)
    → Load (edit-source: readNorm + served state)
    → Parse & Validate (resEdit; warnings local, no servePolicy)
    → Span gate (batches only: baseline spans resolved through
      `resolveLeasedEdit`, disjointness asserted)
    → Mutate loop, for each HEdit: applyEdit → resolveLeasedEdit
        ├─ reject: recordRejectionServe (handle.recordServeFeedback)
        │          + batch-abort envelope
        ├─ noop:   runNoopPolicy
        └─ applied: lineHashes (in-memory) + per-edit intervals
    → Finalize: dense lineHashes when anything applied
      (`persist: false` — the working buffer commits only in `apply`)
    → Drift: scanDrift over the per-edit intervals (one statement
      below — interval-aware, no union-gap caveat)
    → Persist (live only, in `apply`): saveUndo → writeAtomic;
      on write failure: restore undo. A foreign-source `mode: "cut"` (ticket-04b) extends this
      to an ORDERED multi-file commit: undo rows for every file plus a durable intent record
      before the first rename, the target insert committed BEFORE the destructive source
      retirement, best-effort rollback otherwise, and next-run repair for anything in
      between (ADR-0028 — no filesystem atomicity is claimed anywhere).
    → Serve (live only, in `apply`): upsertSnapshotFor (snapshot +
      lineage + retirement + diff leases + dense serve mirror rows in
      ONE transaction — CAND-3); rejection serves were already
      recorded on the reject path

Atomic guarantee: if any mutate step throws (anchor/served/noop-loop)
persist is skipped and the file is unchanged. Warnings are owned
locally — not passed by ref across modules. servePolicy string is
internal (live vs preview) and not exposed.

Drift is interval-aware: the pipeline tracks per-edit ResolvedRange[]
(editedIntervals) and Drift scans per-interval (not union). Gaps
between disjoint edits are correctly reported as drift; no
Batch drift note warning is emitted. Per-interval deltaBefore
maps served positions to current positions.
```

Vocabulary is the glossary's: range, span, served span, drift, drift notice, reject-and-serve, payload contract — preserved as written.

### Considered Options

- **Keep the header and exempt it from the comment cap** — rejected. An exemption for the one block the rule exists to shrink is how a ratchet stops ratcheting, and the header's `SAFETY:` tag still guarded nothing.
- **Move the text into `GLOSSARY.md`** — rejected. The glossary defines terms; the phase order is a behavioural contract with an ordering failure mode, which is what the ADR log is for. Burying it in 42 KB of vocabulary makes it unlinkable from the file it governs.
- **Keep a prose summary in the source and the full text in the ADR** — rejected. Two statements of one contract drift, and the summary is the one a reader trusts because it sits beside the code. One citation line, one owner.
- **Cite `ADR-0017` by bare number** — rejected. 267 bare `ADR-\d{4}` refs already exist and only one uses a path; a number survives a move silently and points at the wrong record after a renumber. A path is what a liveness test can check.

## Consequences

- The repository keeps its phase-ordering statement at a stable, linkable address, and `src/mutation-engine/pipeline.ts` drops from a 59-line header to one citation line — so the 12-line comment cap has no exception to carve.
- A reader following the `// Ref:` line arrives at the record with its measurements attached; a reader who greps the source for the ordering finds a pointer, not the contract.
- **Load-bearing assumption:** that the comment gate accepts `// Ref: docs/...` as an allowed shape. It does, and the shape carries no liveness check yet — a path that rots stays green until the liveness stage lands.
- **Load-bearing assumption:** that phase order travels with the code that implements it. The ordering names modules by filename; a rename invalidates the names here while leaving the invariants true, so a rename should touch this record.
- The next ADR archived out of `docs/adr/` must fix this citation too. Archiving is a repo-wide codemod, not a file move.
