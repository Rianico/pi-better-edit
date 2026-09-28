# Read/replace guidelines: rereading as on-demand recovery

> **Archived from pre-migration issue #8.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-11T07:41:26Z · state CLOSED · labels: ready-for-agent

## Body



## Blocked by

- #3

## Blocked by

- #3


## Comments

### @Rianico — 2026-08-11T10:36:23Z

Implemented in commit `c618e22`: read-guidelines now frame reading as on-demand recovery (no re-read ritual; reject-and-serve retry documented); replace-guidelines add the verification rule with `[E_RANGE_STALE]`/`[E_RANGE_UNSERVED]` echo-retry. 2 prompt tests updated; full suite 917/917, typecheck clean.

### @Rianico — 2026-08-11T10:36:25Z

Closing: guidelines complete. All 7 tickets (#2–#8) closed.
