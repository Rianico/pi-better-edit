# Spec: User/Model audience split and glossary-aligned error codes (adj+noun)

> **Archived from pre-migration issue #65.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-03T10:36:27Z · state CLOSED · labels: ready-for-agent, released

## Body

## Problem Statement

`pi-better-edit` exposes ~15 `E_*` codes via two channels (`content` throw vs `details.warnings`/`driftNotice` collapsed) without a consistent mental model. Users (human) cannot distinguish what requires their attention (informational drift outside the edited `range`) from what requires the model to retry (anchor or `served range` staleness, shape, echo). Codes mix `noun+adj` (`E_RANGE_STALE`) and `adj+noun` (`E_STALE_ANCHOR`), overload `stale anchor` for both boundary and `served range`, retain dead `E_AMBIGUOUS_ANCHOR` (hash probing + `tombstone` `used = bitset(oldHashes) ∪ tombstone` makes file duplicates impossible), and split `E_RANGE_UNVERIFIED`/`E_RANGE_UNSERVED` for the same `never-served` concept. `E_NOT_TEXT` leaks an affordance (`Use ls…`), and `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH`/`E_BAD_REF` triplicate anchor-syntax. Visuals lack a copy-pasteable cue: `driftNotice` is dimmed but `warnings` are not, and no prefix distinguishes `model-facing signal` from `user-facing signal` in logs.

Recent `79b4931` (tombstone per-session epoch, `canon`+`snapshotId`, position-free `verifyOrThrow` with `strict` fallback, `ADR-0013`) made the staleness model `tombstone∉ && canon==` plus `snapshotId` epoch, but the error surface was not realigned to `CONTEXT.md` glossary (`anchor`, `served range`/`served span`, `anchor staleness` vs `served-range staleness`, `drift`/`drift notice`, `payload contract`, `inclusive anchor range`, `tombstone`/`canon`/`epoch`).

## Solution

Keep `E_*` as the stable machine `errCode` contract, but make audience the display-layer taxonomy: fail-loud `throw` → `content` renders as `[MODEL] [E_*] …` normal; `details.warnings`/`driftNotice` render as `[USER] …` `theme.fg(dim)` collapsed. Raw JSON stays prefix-free. `E_NOT_TEXT` message trimmed. Remaining codes collapsed to an `adj+noun` family: retire `E_AMBIGUOUS_ANCHOR` (alias `E_STALE_ANCHOR`), merge `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH` → `E_BAD_ANCHOR`, merge `E_RANGE_UNVERIFIED` → `E_RANGE_UNSERVED` → rename `adj+noun` to `E_STALE_ANCHOR`/`E_STALE_RANGE`/`E_UNSERVED_RANGE`, and rename `E_BAD_SHAPE→E_BAD_PAYLOAD`, `E_NOT_TEXT→E_UNSUPPORTED_FILE`, `E_FILE_TOO_LARGE→E_LARGE_FILE`, `E_WOULD_EMPTY→E_EMPTY_RANGE`, `E_EDIT_HASH_ECHO→E_SERVED_ECHO`, `E_BAD_OP→E_REVERSED_ANCHORS`. `drift:` stays `[USER]` dimmed collapsed; `Batch drift note` retires from user surface. `CONTEXT.md` Language updated to define `anchor` (one line) vs `served range` (span between anchors) and their stalenesses, and a new `ADR-0014` records the audience split.

## User Stories

1. As a human reviewing a `pi` TUI session, I want drift outside my edit (`drift: 1 line … outside the range`) dimmed and collapsed with a `[USER]` prefix, so that I can ignore it and know the edit still succeeded.
2. As a human reading `details.warnings`, I want a single healed warning `[USER] [E_REVERSED_ANCHORS] reversed … swapped (healed)` dimmed, so that I know no retry is needed.
3. As a model parsing `content`, I want every fail-loud header to start with `[MODEL] [E_*]`, so that I can branch on `errCode` without parsing human dim codes.
4. As a model receiving `[MODEL] [E_STALE_ANCHOR] … Re-read for fresh anchors`, I want the message to name the one stale `anchor` (boundary line), so that I know to `read` that line rather than retry with echo.
5. As a model receiving `[MODEL] [E_STALE_RANGE] line 15 differs …` plus a second dimmed `[USER] Current range below is fresh — retry with these anchors, no read needed`, I want the second line visually distinct, so that I use the echoed `HASH│` instead of re-`read`.
6. As a model receiving `[MODEL] [E_UNSERVED_RANGE] boundary anchor "aB3" was never served` or `line 24 was never served`, I want one `UNSERVED` code for both boundary and interior never-served, with `details.unservedKind`, so that I retry with echo without learning two codes.
7. As a model sending a malformed `payload contract` (`{path, edits:[[remove_from,remove_to,replacement_text]]}` shape wrong, unknown field, empty `edits`), I want `[MODEL] [E_BAD_PAYLOAD] …`, so that I fix shape before anchor logic.
8. As a model pasting `HASH│` in `remove_from` or in `replacement_text`, I want one `[MODEL] [E_BAD_ANCHOR] Invalid anchor … remove "│" …` instead of three codes, so that I learn the single anchor-syntax rule.
9. As a model hitting a path that is a directory / binary / image / UTF-16, I want `[MODEL] [E_UNSUPPORTED_FILE] Path is a directory: …` (no `Use ls…`), so that the error is short and I choose `ls`/`read_skill` myself.
10. As a model hitting `E_LARGE_FILE` / `E_EMPTY_RANGE` / `E_SERVED_ECHO`, I want `adj+noun` names that match the glossary (`payload contract`, `inclusive anchor range`, `served hash echo`), so that I can map code to doc.
11. As a human searching logs with `rg "\[E_"`, I want every code to remain `E_*` `adj+noun` (`E_STALE_ANCHOR`/`E_STALE_RANGE`/`E_UNSERVED_RANGE`), so that `rg` still finds them after renames.
12. As a maintainer reading `CONTEXT.md`, I want `anchor` = one line, `served range` = span between anchors, `anchor staleness` vs `served-range staleness` defined without `Avoid: stale anchor`, so that `E_STALE_ANCHOR` no longer violates its own glossary.
13. As a maintainer reviewing `E_AMBIGUOUS_ANCHOR` history, I want it retired to `E_STALE_ANCHOR` alias with `hash probing + tombstone` rationale, so that the test `"synthetic collision"` is the only reference and production never emits it.
14. As a model whose `remove_from`/`remove_to` are reversed, I want the healed `[USER] [E_REVERSED_ANCHORS] reversed … swapped (healed)` warning dimmed, and the unhealed `Range start 47 > end 12` as `[MODEL] [E_REVERSED_ANCHORS] …` throw, so that I know which needs a retry.
15. As a model re-sending identical no-op 3×, I want `[MODEL] [E_NOOP_LOOP] … Range already contains this text` with echo, so that I stop looping.
16. As a human invoking `undo_last_edit` after external `write`, I want `[MODEL] [E_UNDO_STALE] …` normal, so that I know undo is file-global and blocked.
17. As a TUI user copying a log to an issue, I want `[USER]` dimmed and `[MODEL]` normal to survive as text prefixes when color is lost.

## Implementation Decisions

- Audience is display-layer only: raw `content`/`details.warnings`/`details.driftNotice`/`details.errCode` store `E_*` without `[USER]/[MODEL]`; `src/edit-render.ts` wraps `content` header with `theme.fg(normal, "[MODEL] [E_*] …")` and `warnings`/`driftNotice` with `theme.fg(dim, "[USER] …")`. `src/edit-response.ts` keeps `modelWarnings` filter but `Batch drift note` moves out of `warnings` into `driftNotice` (or dropped to debug).
- Trim `E_NOT_TEXT`: `src/validation.ts`, `src/fs-write.ts`, `src/hash-store.ts` messages drop `Use ls…` suffix; code renames `E_NOT_TEXT` → `E_UNSUPPORTED_FILE` (all throw sites, tests, `README.md` error table). No alias (`no need to keep E_BAD_SHAPE as alias` per decision #1).
- Parse/resolve re-harden: `src/hashline/parse.ts`, `src/hashline/resolve.ts` remove auto-heal `warnings?.push` for `E_BAD_ANCHOR` family (`extracted first hash`, `stripped diff-preview/-/"HASH│"`, `stripBarePrefixes` `HL_BARE_PREFIX_RE`, `stripDiffPrefixes` `HL_PREFIX_PLUS_RE`) → `throw [MODEL] [E_BAD_ANCHOR] …` (payload admission). Only `swapReversedRanges` keeps healed `[USER] [E_REVERSED_ANCHORS] swapped (healed)` warning.
- `E_AMBIGUOUS_ANCHOR` retired: `src/hashline/resolve.ts: formatAmbiguous` deleted, `resAnchorFromMap` `ambiguous` branch maps to `[E_STALE_ANCHOR]` throw with collision line list; `test/core/hashline.hash.test.ts` synthetic collision test expects `E_STALE_ANCHOR`.
- `adj+noun` renames (all throw sites + `src/hashline/served-verification.ts` `ServedCode` type + `src/mutation-engine/types.ts` SAFETY comment + `src/hashline/hash-identity.ts` `E_FILE_TOO_LARGE`): `E_BAD_SHAPE→E_BAD_PAYLOAD`, `E_NOT_TEXT→E_UNSUPPORTED_FILE`, `E_FILE_TOO_LARGE→E_LARGE_FILE`, `E_WOULD_EMPTY→E_EMPTY_RANGE`, `E_EDIT_HASH_ECHO/E_WRITE_HASH_ECHO→E_SERVED_ECHO`, `E_BAD_OP→E_REVERSED_ANCHORS`, `E_RANGE_STALE→E_STALE_RANGE`, `E_RANGE_UNSERVED(+UNVERIFIED)→E_UNSERVED_RANGE`. Old `E_RANGE_UNVERIFIED` type member removed; `verifyOrThrow` entry `1: no span → E_RANGE_UNVERIFIED` now throws `E_UNSERVED_RANGE` with `details.unservedKind="boundary"` vs `"interior"`.
- `E_STALE_ANCHOR` kept (reject rename to `E_BOUNDARY_STALE` per #3 decision); `CONTEXT.md` Language patches `boundary staleness` → `anchor staleness` (one line’s `hash`/`canon`/`tombstone` miss) and redefines `range staleness` → `served-range staleness` (interior `served span` vs `current span` mismatch), adding `served range` alias to `served span`. `README.md:183` error table, `docs/adr/0001`, `0013`, `benchmarks/results` updated.
- New `docs/adr/0014-user-model-audience.md` records audience split, `adj+noun` family, merge rationale (`hash probing + tombstone` makes `AMBIGUOUS` dead; `UNVERIFIED` duplicates `UNSERVED`), visual `[USER] dim + [MODEL] normal` and why prefix survives monochrome logs.
- Message pairing: `E_STALE_RANGE`/`E_UNSERVED_RANGE` throws emit `content` = `[MODEL] [E_*] …` + second line `[USER] Current range below is fresh — retry with these anchors, no read needed` (dimmed in TUI) + `Current range:` echo with `servedRows` (fresh serves, `reject-and-serve`). `E_STALE_ANCHOR` does not include range echo, includes `Current context around resolved anchor`.

## Testing Decisions

- Good tests assert external behavior only (tool output channels), not internal `warnings` array shape or `theme.fg` ANSI codes. Assert `content` starts with `[MODEL] [E_*]` and `details.errCode` equals `E_*`; assert `details.warnings[0]` starts with `[USER]` and is dimmed only in rendered TUI snapshot, and `details.driftNotice` starts with `[USER] drift:` when present.
- Modules tested: highest seam is the `edit` tool handler (`src/edit.ts` via `src/mutation-engine/pipeline.ts` → `src/mutation-engine/engine.ts`) — single integration seam covering payload-contract admission, `hashline/resolve` parse, `served-verification` (`position-free` vs `strict` epoch `snapshotId`), `hash-identity` allocation with `tombstone`/`canon`, `drift` `scanDrift`, `noop-guard`, `edit-render`. Existing suites `test/integration/edit-tool.test.ts`, `test/core/hashline.*`, `test/core/served-*.test.ts`, `test/core/drift.test.ts` are prior art. Second seam only if needed: unit `src/hashline/parse.ts` and `src/payload-contract.ts` for `E_BAD_ANCHOR`/`E_BAD_PAYLOAD` throws.
- Coverage: one test per `MODEL` code via the `edit` seam (feed malformed payload, bad anchor, unsupported file, large file, empty range, served echo, stale anchor, stale range, unserved range boundary+interior, reversed anchors throw, noop loop, undo stale), plus healed `E_REVERSED_ANCHORS swapped` → success with `[USER]` warning, plus `drift:` outside range → success with `[USER] drift:` and `Batch drift note` no longer in `warnings`. Update `rg`-based tests from old `E_*` strings to new names.

## Out of Scope

- `npmPublish` or version bump — `E_*` renames are tool-output only, not `package.json` version logic.
- Changing `ServedCode` persistence (`hash_store` SQLite `retired`/`canons`/`snapshotId`) or `tombstone` allocation logic beyond error-message renames.
- New `edit` payload fields or `read` changes.
- Localization of messages beyond English.

## Further Notes

- `E_NOT_FOUND`/`E_ACCESS` kept verbatim for Node `ENOENT` parity despite not being `adj+noun`; `E_UNDO_*`/`E_NOOP_LOOP` kept as verb-family (undo/loop are actions).
- `rm` of old codes is intentional with no alias (per #1 decision `no need to keep E_BAD_SHAPE as alias`); a single `grep` codemod updates `test`/`docs`/`README`.


## Comments

### @github-actions — 2026-09-05T08:01:06Z

:tada: This issue has been resolved in version 1.6.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v1.6.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
