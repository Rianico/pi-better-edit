# refactor(store): drop the deprecated internal reServe alias

> **Archived from pre-migration issue #120.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T03:50:15Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Found while verifying #116 (review 5 round), not raised by the review itself.

## Finding

#116 generalized the in-transaction grant seam and correctly migrated every caller — `read.ts:131`, `mutation-engine/pipeline.ts:1049` and `edit-undo.ts:252` all pass `leases:`. But it left the old name behind as a **deprecated alias**:

- `src/snapshot-store/index.ts:329` — `export type ReServeGrant = LeaseGrant;`
- `src/snapshot-store/index.ts:336` — `reServe?: ReServeGrant;` option field
- `src/snapshot-store/index.ts:357-358` — the `options?.leases ?? options?.reServe` fallback
- doc comments at `:326`, `:333`, `:346` describing `reServe` as "the deprecated spelling"

**Nothing passes `reServe` any more** (`rg -n '\breServe\b' src test` → only these four lines in `index.ts`), so the alias is dead code.

## Why this must go, not stay

The rule sources the operator requires for every run (`rules/common/development-patterns.md` § 1, *Graded surfaces*) are explicit:

> **Deprecation** → internal-only: remove + update callers atomically (no deprecated mark). Public/cross-boundary: deprecate with shim + migration window, cutover plan before removal.

`LeaseGrant` / `reServe` is an **internal** seam — module-private to `src/snapshot-store/index.ts` and its three in-repo callers, not an exported product API. There is no migration window to honour, so a deprecation mark is exactly the pattern the rule forbids. Contrast `src/edit-normalize.ts`, which legitimately keeps an `@deprecated` shim because ADR-0007 makes it a cross-boundary compatibility surface with a MAJOR-version cutover — that one stays.

## Remedy

Remove the alias and the fallback atomically: delete `ReServeGrant`, the `reServe?` field, the `?? options?.reServe` branch, and the three doc lines that describe the deprecated spelling. Keep `LeaseGrant` / `leases` as the single name, and keep the WHY comments explaining that the grant is the whole restore transaction.

## Acceptance criteria

- `rg -n 'ReServeGrant|reServe' src/ test/` returns nothing.
- The undo restore path (`src/edit-undo.ts`) still grants its restored-line leases inside the materialization transaction — the behaviour #107 and #116 established is unchanged.
- `LeaseGrant` is the only grant type and `leases` the only option key; no behaviour change and no test weakened.
- All 15 Stage-0 probes stay green (four fail-closed probes keep byte-identical file assertions); `test/core/served-rejection-unification.test.ts`, the lease/undo suites and the batch tests keep their assertions.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:41:10Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
