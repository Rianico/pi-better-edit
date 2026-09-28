# docs(spec): move the architecture spec out of .scratch and publish Revision 24

> **Archived from pre-migration issue #118.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:49Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, Standards finding 2 + spec findings (c)1 and (c)2.

**Operator decision (review 5 Q1):** the MVCC spec is an *architecture redesign document* in essence and must not live in `.scratch/`; it moves to a dedicated permanent doc.

## 1. Relocate the spec out of `.scratch/`

`git mv .scratch/mvcc-sparse-dense-anchors/spec.md docs/spec/content-addressed-line-identity-mvcc.md` (the repo already uses `docs/spec/`, e.g. `session-keyed-served-state.md`).

Then remove the carve-outs the file required:
- `.oxlintrc.json:3` — drop `".scratch/**"` from `ignorePatterns` (remove the key if the array empties)
- `.prettierignore:1` — drop the `.scratch/` line
- remove the now-empty `.scratch/` directory

Measured before removing: `oxfmt` does not target `.md` at all (README behaves identically) and the spec itself reports `✓ Markdown clean`, so both carve-outs are inert — removal is safe. `rg -n '\.scratch' --glob '!node_modules' .` returns only `scripts/practical-token-benchmark.mjs` (an unrelated runtime scratch variable) — leave it.

**Add a discovery pointer**: one line in `AGENTS.md` § Domain docs naming where the permanent architecture-revision spec lives, so the document is discoverable from the repo's own entry point instead of from a scratch path.

## 2. Revision 24 wording — align the normative text with the delivered code

Bump `Revision: 23` → `24` (title line 1 and the `Revision:` line) with the blurb extended to record these clarifications. Leave the `Supersedes:` line untouched.

**(c)1 — seam attribution, §5.3 decision table (line 638).** The rows for a missing lease / stale anchor (`[MODEL] [E_STALE_ANCHOR]`, `[MODEL] [E_STALE_RANGE]`) name `resolve.ts` (`valEdit`). Delivered code isolates leased-anchor resolution in `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`, `:155-185`) while `valEdit` (`src/hashline/resolve.ts:448-497`) performs pure content resolution. Correct the seam cell to name `src/hashline/lease-resolve.ts` (`resolveLeasedEdit`) and state that `valEdit` is the pure content-resolution seam. Change only the seam attribution — every error code and expectation stays exactly as it is.

**(c)2 — preceding-delta semantics, §3.2 step 2 (lines 175-180).** The closed form defines *what* the shift is:

> Only strictly preceding edits contribute: $\Delta_k = \sum_{j<k, s'_{end,j} < s'_{start,k}} (|R_j| - (s'_{end,j} - s'_{start,j} + 1))$, and $p_{buffer} = s' + \Delta_k$.

State explicitly that this is the normative *semantics*, and that an implementation may materialize the equivalent shift by sequentially rebasing the working buffer over the preceding items (`src/mutation-engine/pipeline.ts:728-733`, `:851-857`) — the coordinate reached must be identical, and Probes `I` and `M` are the conformance evidence. Do not change the equation itself.

**(a) soft overflow, §3.6.1 (line 320).** The sentence *"If all snapshots are pinned and budget is exceeded, eviction is deferred until lease expiration, allowing a temporary soft overflow up to 100 MB"* reads as if something must happen at 100 MB. Make the semantics explicit and consistent with ADR-0017:
- pinned snapshots are **never** evicted (spec L318) — a pin is the only copy of the lineage a live anchor resolves through;
- while every candidate is pinned the vacuum defers and the store soft-overflows; the deferred state is **reported** (`VacuumResult.deferredBytes` / `overSoftOverflow`, surfaced as an operator warning per the sibling ticket) and is expected to lapse as leases expire;
- the 100 MB figure is the tolerated soft-overflow window, not a threshold that unlocks eviction of pinned rows; a hard cap that evicts pins is a **rejected** option (ADR-0017, Considered Options).

## Acceptance criteria

- The spec lives at `docs/spec/content-addressed-line-identity-mvcc.md`; `.scratch/` is gone; the two carve-outs are gone; `AGENTS.md` names the new home.
- **Content preserved**: `git show`/`git diff` on the moved file shows only the revision bump and the three wording amendments — no mass reformatting, no reflowed tables, no altered probe expectations, equations (other than the added prose in (c)2), error-code rows or Stage-0 statements.
- `rg -n 'resolve\.ts` \(`valEdit`\)' ` returns nothing for the lease-failure rows; no `src/snapshot-store.ts` seam entry reappears (revision 23's fix stays).
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green — a red here means the change leaked out of docs/config.
- Commit type `docs`; the relocation and the amendments may be separate commits, but every body line must stay ≤ 100 characters.


## Comments

### @Rianico — 2026-09-15T07:41:02Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
