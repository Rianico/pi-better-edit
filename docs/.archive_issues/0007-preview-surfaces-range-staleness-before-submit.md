# Preview surfaces range staleness before submit

> **Archived from pre-migration issue #7.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:23Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

The `replace` edit preview — computed before submission — surfaces range staleness when it is detectable, so the model can correct the edit without an error roundtrip. The preview runs the span check read-only (`noPersist`) and never writes served state: previewing must not make lines "served".

See `docs/spec/served-state-range-verification.md` (user story 20; Implementation Decision 2 — preview computation never persists; ADR consequence — previews run the check read-only).

## Acceptance criteria

- [ ] A preview for a range whose interior drifted shows staleness in the preview output, not only at execute time.
- [ ] A preview for a range with a never-served interior shows that condition.
- [ ] Previewing alone never records serves — after a preview, the checked lines are still not served (verifiable via subsequent behavior).
- [ ] Successful previews render exactly as before.

## Blocked by

- #3, #4

## Blocked by

- #3, #4


## Comments

### @Rianico — 2026-08-11T10:31:26Z

Implemented in commit `cffeac8`. The preview already ran the check read-only via `compPreview`+noPersist (rejection-echo, drift serving, and snapshot persistence all gated on `noPersist !== true`); this ticket pinned it: 7 new tests (drifted interior → `[E_RANGE_STALE]` in preview; never-served interior → `[E_RANGE_UNSERVED]`; unserved boundary → `[E_RANGE_UNVERIFIED]`; successful previews unchanged; renderCall surfaces the rejection; preview-then-execute still rejects — previewing never serves). Full suite 917/917, typecheck+lint clean.

### @Rianico — 2026-08-11T10:31:28Z

Closing: preview staleness surfacing verified.
