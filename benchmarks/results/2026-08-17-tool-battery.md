# Tool battery results — 2026-08-17

Ran with `npm run eval:compare` on Node 22 (macOS arm64). Targets: this fork
(`local`, 1.1.3) vs `pi-hashline-edit-pro@2.4.1` (fork base) and
`pi-hashline-edit-pro@2.5.0` (latest published). All three targets run the
same 23 scenarios through the same tool seam; a `WRONG` cell means the
scenario's expected verdict (outcome + preserved content) did not hold.

## Correctness

| scenario | local | pro 2.4.1 | pro 2.5.0 |
| --- | :--: | :--: | :--: |
| B1 single-line replace | success | success | success |
| B2 range replace | success | success | success |
| B3 interior drift must-not-silently-overwrite | rejected `E_RANGE_STALE` | **WRONG** | rejected `E_RANGE_STALE` |
| B4 out-of-range in-place change | success | success | success |
| B5 deletion-above-range positional-shift | success | success | success |
| B6 change-then-revert interior | success | success | success |
| B7 never-served interior paged-read-gap | rejected `E_RANGE_UNSERVED` | **WRONG** | rejected `E_RANGE_STALE` |
| B8 blind-edit no-read never-served-boundary | rejected `E_RANGE_UNVERIFIED` | **WRONG** | **WRONG** |
| B9 boundary-changed stale-anchor | rejected `E_STALE_ANCHOR` | rejected | rejected |
| B10 duplicate-content drift must-still-reject | rejected `E_RANGE_STALE` | **WRONG** | rejected `E_RANGE_STALE` |
| B11 noop replace | success | success | success |
| B12 noop-with-out-of-range-drift | success | success | success |
| B13 chained-edit-from-diff-rows-no-reread | success | success | success |
| B14 empty-file insert | success | success | success |
| B15 large-range drift capped-feedback | rejected `E_RANGE_STALE` | **WRONG** | rejected `E_RANGE_STALE` |
| B16a undo after replace | success | success | success |
| B16b undo after external change | rejected `E_UNDO_STALE` | rejected | rejected |
| B17 reversed-range autocorrect | success | success | success |
| B18 boundary-dup autocorrect | success | success | success |
| B19 sub-agent-session-does-not-wipe-main | success | success | success |
| B20 main-and-sub-agent-both-edit | success | success | success |
| B21 same-session-restart-keeps-served-state | success | success | success |
| B22 sub-agent-serves-not-visible-to-main | rejected `E_RANGE_UNVERIFIED` | **WRONG** | **WRONG** |
| **correct** | **23/23** | **17/23** | **21/23** |

## What the WRONG cells are

- **B3 / B7 / B10 / B15 (2.4.1 only):** the file changed inside the edit
  range after it was read, and the upstream `replace` applied anyway,
  silently overwriting the drifted lines. These are the data-loss cases the
  served-state range verification exists to prevent.
- **B8 (both versions):** an edit anchored on a boundary line the model was
  never served (blind edit, no prior `read`) landed instead of being
  rejected — the never-served / unverified-boundary hole.
- **B22 (both versions):** a serve recorded in a sub-agent session is visible
  to the main session, so an anchor the main session never saw passes the
  served-state check — a cross-session serve leak.

## Aggregates

| target | correct | success | rejected | calls | chars |
| --- | --: | --: | --: | --: | --: |
| local (1.1.3) | 23/23 | 15 | 8 | 51 | 7,925 |
| pi-hashline-edit-pro@2.4.1 | 17/23 | 21 | 2 | 51 | 5,644 |
| pi-hashline-edit-pro@2.5.0 | 21/23 | 17 | 6 | 51 | 7,759 |

`calls` is the total number of tool invocations the battery made; `chars` is
the total output characters it received. Same 51 calls across targets (the
scenario scripts are identical); the char deltas are the rejected edits'
reject-and-serve feedback, which is precisely the surface area the fork
grows.

## Limitations

- Deterministic fixture battery: it gates the exact stale-serve scenarios,
  not model behavior or throughput.
- 2.4.1/2.5.0 are pinned by `scripts/eval-compare.mjs` defaults; a different
  upstream release may differ.
- Run environment: Node 22 (macOS arm64); outcomes are content-deterministic
  and should hold on any platform that runs the test suite.
