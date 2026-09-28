# refactor(pairing): name pin coordinates prevLine and currLine

> **Archived from pre-migration issue #110.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:42:51Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC).

## Standards finding (review 4) — Mysterious Name

`src/hashline/patience-pairing.ts:29-32`:

```ts
export interface AnchorPin {
  pLine: number;
  cLine: number;
}
```

`pLine` / `cLine` abbreviate the coordinates, while `WeightedPin` in the same file (`:72-76`) names them explicitly `prevLine` / `currLine`. An earlier round removed single-letter pin coordinate keys but left these abbreviations.

## Remedy

Rename `AnchorPin.pLine` → `prevLine` and `AnchorPin.cLine` → `currLine`, updating every construction and read site plus tests, so both pin shapes in the module use the same vocabulary.

## Acceptance criteria

- `rg -n 'pLine|cLine' src/ test/` returns nothing.
- `AnchorPin` and `WeightedPin` name their coordinates identically.
- No behaviour change: the pairing unit battery, probes H/I/K/L/M/N (Probe N via the rigid block shift) and all 15 Stage-0 probes stay green; no assertion weakened or deleted.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:36Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
