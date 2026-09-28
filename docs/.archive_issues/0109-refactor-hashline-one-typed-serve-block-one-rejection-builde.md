# refactor(hashline): one typed serve block, one rejection builder, one snapshot context

> **Archived from pre-migration issue #109.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:42:49Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC).

Three Standards findings (review 4) in the reject-and-serve seam. All three live in `src/hashline/served-verification.ts` (plus the callers of the data clump), so they ship as one round.

## 1. Untyped monkey-patching of the rendered block

`ServedRejectionError` (`served-verification.ts:37-54`) has no typed field for the rendered range block, so three throw sites attach it as an untyped property:

- `served-verification.ts:153-154` — `(err as unknown as { __echo: string }).__echo = echo;`
- `served-verification.ts:692-693` (same cast, later path)
- `served-verification.ts:709-710` — `(err as unknown as { __echo: string }).__echo = args.echo;`

and the reader casts back at `served-verification.ts:327-329`, with a "legacy fallback rebuild" when the property is absent (`// WHY: fallback rebuild if __echo not attached (legacy path)`).

**Remedy**: declare one typed optional field on the rejection error class(es) — `readonly servedBlock?: string` (name it once and use it everywhere) — populated at construction. Delete all three attach casts, the read cast, and their `SAFETY` comments. If the typed field is always set, the "legacy fallback rebuild" branch becomes dead: delete it too, and say so in the commit body. Note both error classes that receive the block: `ServedRejectionError` and whichever class the `:709-710` site constructs (`AnchorMismatchError`); put the field where both can carry it.

## 2. Duplicated rejection builders

`makeServedRejection` (`:139-156`) and `makeStaleAnchorRejection` (`:164-176`) duplicate identical logic: build the range block, assemble `[MODEL] [${code}] ${headline}\nCurrent range:\n${rendered}\n${retryHint()}`, attach the served rows.

**Remedy**: extract exactly one rejection builder parameterized by error code, headline, range, snapshot context, optional offending line, and an error-class factory. The two current entry points become thin delegations (or their call sites use the unified builder directly) — one implementation of the block build and one implementation of the payload assembly.

## 3. Data clumps

`fileHashes: string[]`, `fileLines: string[]` and `filePath?: string` travel together as positional/object parameters across `valEdit` (`src/hashline/resolve.ts:453`), `fmtMismatchWithServes` (`resolve.ts:268`), `throwStaleAnchor`, `resolveLeasedEdit` (`src/hashline/lease-resolve.ts:142`), `verifyRebasedSpan` (`served-verification.ts:194`) and both rejection builders.

**Remedy**: bundle them into one cohesive descriptor, e.g. `FileSnapshotContext { fileHashes: string[]; fileLines: string[]; filePath?: string }`, and thread that instead. Mechanical and behaviour-preserving.

## Acceptance criteria

- Zero `as unknown as { __echo }` casts and zero `__echo` references remain in `src/` (`rg -n '__echo' src/` empty).
- One implementation of the rejection formatting; both entry points share it.
- One `FileSnapshotContext` descriptor carries the snapshot triple through the listed signatures.
- Behaviour is identical: the three error codes keep their attribution (unleased boundary anchor → `E_STALE_ANCHOR`, never-served interior → `E_UNSERVED_RANGE`, retired/deleted leased line or torn span → `E_STALE_RANGE`), messages keep the `[MODEL] [CODE]` prefix and the `Current range:` echo contract, and served rows stay attached.
- All 15 Stage-0 probes stay green — the four fail-closed probes (A, E, J, K) keep rejecting **and** asserting byte-identical file content. No assertion weakened or deleted; if the deleted fallback branch had a dedicated test, keep a test that pins the new guaranteed-field behaviour instead of dropping the coverage.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:32Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
