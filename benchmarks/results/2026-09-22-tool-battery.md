# Tool battery results — 2026-09-22

Ran with `node scripts/eval-compare.mjs` on Node 26 (macOS arm64). Targets: this repo
(`local`, 2.0.0) vs `pi-hashline-edit-pro@2.4.1` (fork base) and
`pi-hashline-edit-pro@2.5.3` (latest published). All three targets run the
expanded 27 scenarios through the same tool seam; a `WRONG` cell means the
scenario's expected verdict (outcome + preserved content) did not hold.

## Correctness

| scenario | local (2.0.0) | pro 2.4.1 | pro 2.5.3 |
| --- | :--: | :--: | :--: |
| B1 single-line replace | success | success | success |
| B2 range replace | success | success | success |
| B3 interior drift must-not-silently-overwrite | rejected `E_STALE_RANGE` | **WRONG** | rejected `E_RANGE_STALE` |
| B4 out-of-range in-place change | success | success | success |
| B5 deletion-above-range positional-shift | success | success | success |
| B6 change-then-revert interior | success | success | success |
| B7 never-served interior paged-read-gap | rejected `E_STALE_RANGE` | **WRONG** | rejected `E_RANGE_STALE` |
| B8 blind-edit no-read never-served-boundary | rejected `E_UNKNOWN_ANCHOR` | **WRONG** | **WRONG** |
| B9 boundary-changed stale-anchor | rejected `E_TARGET_LOST` | rejected `E_STALE_ANCHOR` | rejected `E_STALE_ANCHOR` |
| B10 duplicate-content drift must-still-reject | rejected `E_STALE_RANGE` | **WRONG** | rejected `E_RANGE_STALE` |
| B11 noop replace | success | success | success |
| B12 noop-with-out-of-range-drift | success | success | success |
| B13 chained-edit-from-diff-rows-no-reread | success | success | success |
| B14 empty-file insert | success | success | success |
| B15 large-range drift capped-feedback | rejected `E_STALE_RANGE` | **WRONG** | rejected `E_RANGE_STALE` |
| B16a undo after replace | success | success | success |
| B16b undo after external change | rejected `E_UNDO_STALE` | rejected `E_UNDO_STALE` | rejected `E_UNDO_STALE` |
| B17 reversed-range autocorrect | success | success | success |
| B18 boundary-dup autocorrect | success | success | success |
| B19 sub-agent-session-does-not-wipe-main | success | success | success |
| B20 main-and-sub-agent-both-edit | success | success | success |
| B21 same-session-restart-keeps-served-state | success | success | success |
| B22 sub-agent-serves-not-visible-to-main | rejected `E_UNKNOWN_ANCHOR` | **WRONG** | **WRONG** |
| B23 duplicate-canon silent-miswrite prevention (Probe E / #61) | rejected `E_TARGET_LOST` | **WRONG** | **WRONG** |
| B24 symmetric contested-swap fail-closed (Probe K) | rejected `E_TARGET_LOST` | **WRONG** | **WRONG** |
| B25 foreign-anchor cross-file isolation (#145) | rejected `E_FOREIGN_ANCHOR` | rejected `E_STALE_ANCHOR` | rejected `E_STALE_ANCHOR` |
| B26 UTF-8 BOM preservation across edit (#23/#60) | success | success | success |
| **correct** | **27/27** | **19/27** | **23/27** |

## What the WRONG cells are

- **B3 / B7 / B10 / B15 (2.4.1 only):** the file changed inside the edit
  range after it was read, and upstream `replace` applied anyway,
  silently overwriting the drifted lines. These are the data-loss cases the
  served-range verification exists to prevent.
- **B8 (both upstream versions):** an edit anchored on a boundary line the model was
  never served (blind edit, no prior `read`) landed instead of being
  rejected — the never-served unverified-boundary hole.
- **B22 (both upstream versions):** a serve recorded in a sub-agent session is visible
  to the main session, so an anchor the main session never saw passes the
  served-state check — a cross-session serve leak.
- **B23 (both upstream versions):** duplicate identical lines in a file (Probe E / #61)
  caused upstream to resolve to the wrong target and mutate an unintended function block.
  In `pi-better-edit` v2, content-addressed line-identity MVCC tracks disambiguated
  `line_id` lineage, detecting the collision and failing closed (`[E_TARGET_LOST]`).
- **B24 (both upstream versions):** symmetric function swap (Probe K) where equal-length
  functions swap positions. Upstream matches the line text at the original position and applies
  the edit to the wrong block. In `pi-better-edit` v2, the contested reorder is detected
  and safely aborted (`[E_TARGET_LOST]`).

## Aggregates

| target | correct | success | rejected | calls | chars |
| --- | --: | --: | --: | --: | --: |
| local (2.0.0) | 27/27 | 16 | 11 | 59 | 9,134 |
| pi-hashline-edit-pro@2.4.1 | 19/27 | 24 | 3 | 59 | 6,486 |
| pi-hashline-edit-pro@2.5.3 | 23/27 | 20 | 7 | 59 | 8,601 |

`calls` is the total number of tool invocations the battery made (59 calls across all targets);
`chars` is the total output characters received. The char deltas reflect the rich reject-and-serve
diagnostics and diff-reconstructed recovery feedback emitted upon rejection.

## Limitations

- Deterministic fixture battery: gates exact concurrency, collision, isolation, and drift scenarios,
  not model behavior or throughput.
- 2.4.1/2.5.3 are pinned by `scripts/eval-compare.mjs` defaults; future upstream releases may differ.
- Run environment: Node 26 (macOS arm64); outcomes are content-deterministic and hold across platforms.
