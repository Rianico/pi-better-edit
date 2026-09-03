# ADR-0014 — User/Model audience split and glossary-aligned error codes

Date: 2026-09-02

## Status

accepted

## Context

`E_*` codes were split across `content` throw vs `details.warnings`/`driftNotice` collapsed without an audience taxonomy. Humans could not distinguish informational `drift:` outside the `range` from `anchor`/`served range` staleness that the model must retry. Codes mixed `noun+adj` (`E_RANGE_STALE`) with `adj+noun` (`E_STALE_ANCHOR`), overloaded `stale anchor` for both one-line and span, retained dead `E_AMBIGUOUS_ANCHOR` (hash probing + `tombstone` `used = bitset(oldHashes) ∪ tombstone` makes file duplicates impossible except synthetic `test: synthetic collision`), and split `E_RANGE_UNVERIFIED`/`E_RANGE_UNSERVED` for the same `never-served` concept. `E_NOT_TEXT` leaked an affordance (`Use ls…`), and `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH`/`E_BAD_REF` triplicated anchor-syntax with auto-heal warnings that violated `model–tool boundary` (“tool never silently rewrites `replacement_text`”). `ADR-0013` (tombstone epoch, `canon`+`snapshotId`, position-free `verifyOrThrow` with `strict` fallback) made the staleness model `tombstone∉ && canon==` + `snapshotId` epoch, but the surface was not realigned to `CONTEXT.md` glossary (`anchor`, `served range`/`served span`, `anchor staleness` vs `served-range staleness`, `drift`/`drift notice`, `payload contract`, `inclusive anchor range`).

Grill rounds (Q1-5) agreed: audience is the primary axis (`[USER]` dimmed collapsed vs `[MODEL]` normal, prefix survives monochrome logs), codes must be `adj+noun` like `E_STALE_ANCHOR`/`E_STALE_RANGE`, and dead/duplicate codes should be retired without alias (per decision #1 `no need to keep E_BAD_SHAPE as alias`).

## Decision

**Display-layer audience, glossary `adj+noun` family, no alias.**

- **Audience is display-layer only.** Raw `details.errCode` stays `E_*` without `[USER]/[MODEL]`; `src/edit-render.ts:buildAppliedText` wraps `warnings`/`driftNotice` with `theme.fg(dim, "[USER] …")` and error `content` headers are emitted as `[MODEL] [E_*] …` normal. `src/drift.ts:DRIFT_NOTICE_HEADING` becomes `[USER] drift:` and `Batch drift note` retires from user surface (kept as debug, filtered from `edit-response.ts` `modelWarnings`). Dim is primary cue, prefix secondary for copy-paste.

- **`adj+noun` renames (no alias):** `E_BAD_SHAPE→E_BAD_PAYLOAD`, `E_NOT_TEXT→E_UNSUPPORTED_FILE` (trim `Use ls…` in `src/validation.ts`/`src/read.ts`/`src/fs-write.ts`), `E_FILE_TOO_LARGE→E_LARGE_FILE`, `E_WOULD_EMPTY→E_EMPTY_RANGE`, `E_EDIT_HASH_ECHO`/`E_WRITE_HASH_ECHO→E_SERVED_ECHO`, `E_BAD_OP→E_REVERSED_ANCHORS` (healed `[USER] [E_REVERSED_ANCHORS] reversed … swapped (healed)` dimmed vs throw `[MODEL] [E_REVERSED_ANCHORS] Range start …`), `E_RANGE_STALE→E_STALE_RANGE`, `E_RANGE_UNSERVED`+`E_RANGE_UNVERIFIED`→`E_UNSERVED_RANGE` (with `details.unservedKind="boundary"|"interior"`), `E_AMBIGUOUS_ANCHOR` retired → `E_STALE_ANCHOR` alias (collision now `E_STALE_ANCHOR` with line list), `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH`/`E_BAD_REF`→`E_BAD_ANCHOR` (single anchor-syntax, now `throw` not heal). `src/hashline/served-verification.ts:ServedCode` becomes `"E_STALE_RANGE"|"E_UNSERVED_RANGE"`.

- **Glossary realignment (`CONTEXT.md`):** `boundary staleness` → `anchor staleness` (one line `hash`/`canon`/`tombstone` miss, `remove_from`/`remove_to` each is one `anchor`), `range staleness` → `served-range staleness` (interior `served span` vs `current span` mismatch, reported as `E_STALE_RANGE`/`E_UNSERVED_RANGE` with `reject-and-serve`), add `served range` alias to `served span` (model-facing word for span), drop `Avoid: stale anchor` note, merge `E_SERVED_ECHO` write+edit entries, trim `E_UNSUPPORTED_FILE` entry. `model-facing signal` vs `user-facing signal` already defined (ADR-0010) now governs routing.

- **Message pairing:** `E_STALE_RANGE`/`E_UNSERVED_RANGE` throws emit `[MODEL] [E_*] …` + second line `[USER] Current range below is fresh — retry with these anchors, no read needed` (dimmed in TUI) + `Current range:` echo with `servedRows` (`reject-and-serve`). `E_STALE_ANCHOR` includes `Current context around resolved anchor`.

## Considered Options

- **Keep `E_BAD_SHAPE` alias for one minor** — rejected per decision #1 (`no need to keep alias`), `rg` codemod is single `grep` across `test`/`docs`/`README`, and alias would keep the `shape` vs `payload contract` glossary mismatch alive.
- **Keep `E_NOT_TEXT` with `Use ls…`** — rejected; affordance belongs in model prompt, not error; trimmed message is shorter and matches `E_UNSUPPORTED_FILE` noun.
- **Rename `E_STALE_ANCHOR→E_BOUNDARY_STALE`** — rejected per decision #3 keep `E_STALE_ANCHOR`; `anchor` (one line) vs `served range` (span) is clearer than `boundary` (abstract) and `E_STALE_ANCHOR` already matches `adj+noun` and tests.
- **Keep `E_AMBIGUOUS_ANCHOR` as separate code** — rejected; `tombstone` probing makes production duplicates impossible, only synthetic collision test remains, and `E_STALE_ANCHOR` already covers “hash appears at 2 lines” with same retry (`re-read`).
- **Keep `E_RANGE_UNVERIFIED` as third `RANGE` code** — rejected; `UNVERIFIED` (no served span) and `UNSERVED` (interior hole) both mean `never-served` and both `reject-and-serve` with echo; merging to `E_UNSERVED_RANGE` with `unservedKind` keeps model retry identical and cuts one bucket.
- **Keep `E_BARE_HASH_PREFIX`/`E_INVALID_PATCH` as warnings (heal)** — rejected per `model–tool boundary` and grill Q4: tool shouldered model’s `HASH│` copy-paste; now `throw [MODEL] [E_BAD_ANCHOR]` fail-loud, compensable.

## Consequences

- `CONTEXT.md` Language: `anchor staleness`, `served-range staleness`, `served range` alias, `drift notice` stays `user-facing signal`, `model-facing signal` for `E_STALE_*`/`E_UNSERVED_*`/`E_SERVED_ECHO`.
- `src/hashline/resolve.ts` — `resEdit` `extracted first hash` and `stripped … HASH│` heal paths become `throw [MODEL] [E_BAD_ANCHOR]`; `stripBarePrefixes`/`stripDiffPrefixes` both `throw` (no `warnings`); only `swapReversedRanges` keeps healed `[USER] [E_REVERSED_ANCHORS] swapped (healed)` dimmed.
- `src/hashline/parse.ts`, `src/payload-contract.ts`, `src/validation.ts`, `src/file-content/*`, `src/hash-store.ts`, `src/hashline/hash-identity.ts`, `src/hashline/apply.ts`, `src/mutation-engine/types.ts`, `src/edit-render.ts`, `src/drift.ts`, `README.md:183` table, `docs/adr/0001,0013`, `benchmarks/results`, all `rg E_*` tests updated to new `adj+noun` names and `[MODEL]/[USER]` prefixes; `details.errCode` stays without prefix, `content`/`warnings`/`driftNotice` carry prefix.
- `test` migration: `rg`-based asserts update from old `E_*` to new; healed `E_REVERSED_ANCHORS` test expects `[USER]` dimmed success, `E_BAD_ANCHOR` tests expect `throw` not `warnings`.
