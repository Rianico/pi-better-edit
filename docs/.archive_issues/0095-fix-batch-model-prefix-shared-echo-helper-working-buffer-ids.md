# fix(batch): MODEL prefix, shared echo helper, working-buffer ids and the deferred-sync warning

> **Archived from pre-migration issue #95.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T10:41:00Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Post-implementation review 2, cluster: the multi-edit batch pipeline. Four findings in `src/mutation-engine/pipeline.ts`.

## 1. Missing `[MODEL]` prefix on batch-abort signals (documented standard)
`CONTEXT.md` **model-facing signal**: "A model-visible signal the tool must include in `content` for correctness ... The model needs it to retry correctly", and the CHANGELOG announces this very error as "abort overlapping multi-edit batches with `[MODEL] [E_BATCH_ABORT]`".

- `batchAbortFor` (L486-489) throws a bare `[E_BATCH_ABORT]`.
- `parseEdits` (L631) throws a bare `[E_BATCH_ABORT]`.
- `assertBatchSpansDisjoint` (L599) already throws `[MODEL] [E_BATCH_ABORT]`.

**Remedy**: every batch-abort message carries the `[MODEL]` prefix, so all abort paths are consistent and the model can recognize the signal.

## 2. Duplicated batch-abort echo formatting (baseline smell)
`batchAbortFor` (L483-485) and `assertBatchSpansDisjoint` (L592-594) duplicate this block verbatim:

```ts
const echoBlock = echoRows
  ? ` Current on-disk range for edit[${index}] (unchanged - nothing was written):\n${fmtServedRows(echoRows, splitLines(args.originalNormalized))}`
  : " Call read() to get fresh anchors.";
```

**Remedy**: extract one shared helper for the batch-abort echo block and use it at both sites.

## 3. `leaseSpanSource` built without the working-buffer identities (feature envy)
`applyOneEdit` (L297-302) instantiates `leaseSpanSource` without passing the intermediate `currentIds`, so `positionsByIdentity` can fall back to diffing intermediate buffers instead of querying the in-memory working buffer's own identities.

**Remedy**: pass `currentIds` (the working buffer's line-identity map) directly, so a chained edit in the same batch resolves through in-memory identity rather than a re-diff.

## 4. Post-write desync warning omitted from the tool result (spec section 3.6.2)
Spec lines 322-323: "If `writeAtomic` succeeds on disk but SQLite post-write transaction fails (busy/disk-full): The tool reports **success** (the file was written to disk) along with a warning that store synchronization is deferred."

`pipeline.ts` L1029-1038 logs `console.error("Failed to commit post-write snapshot materialization:", error)` and swallows the error; no deferred-synchronization warning reaches the tool response.

**Remedy**: keep reporting success (the bytes are on disk) but surface the deferred store-synchronization warning through the normal warning channel of the tool result, so the model/human can see that store sync is pending and the next call will re-materialize from disk.

## Acceptance criteria
- Every batch-abort path emits `[MODEL] [E_BATCH_ABORT]`; no model-facing bare `[E_BATCH_ABORT]` remains in `src/`.
- One shared helper formats the echo block; both call sites use it, and the emitted message text is unchanged (existing message-assertion tests stay green).
- `currentIds` is passed to the lease span source; a test covers a chained batch whose second edit anchors on lines created by the first, asserting in-memory identity resolution.
- A test forces the post-write persistence failure and asserts the tool result still reports success while carrying the deferred-synchronization warning.
- The 15-test Stage-0 harness stays green, and `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` is green.


## Comments

### @Rianico — 2026-09-15T07:39:41Z

Delivered.

Merged into `dev/mvcc-line-identity` and squashed into `main` @ `bd3a8f2` (this remediation is included in that squash). Verified at delivery by the composite gate — `pnpm run lint` / `format` / `typecheck` / `test:coverage` (coverage ≥ 85% lines/statements/functions, ≥ 80% branches) — plus the 15-test Stage-0 harness with the four fail-closed probes keeping their byte-identity assertions.

Closing.
