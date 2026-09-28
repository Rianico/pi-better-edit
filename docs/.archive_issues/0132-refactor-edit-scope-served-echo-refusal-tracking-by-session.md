# refactor(edit): scope served-echo refusal tracking by session with bounded eviction

> **Archived from pre-migration issue #132.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T07:42:40Z · state CLOSED · labels: released

## Body

## Deferred from the #128-#131 review round

Raised as review finding P2-1 and deferred by the operator: the fix adds a session lifecycle obligation, so it belongs in its own ticket rather than with the behavioural fixes.

## Current state

`servedRefusalTracker` (`src/hashline/served-guard.ts`) is a module-global `Map<string, RefusalEntry>` keyed by absolute path alone; `clearServedRefusals(path)` deletes a single entry. There is no `sessionKey` component and no bound:

- two sessions that touch the same path share one counter, so the sharpened `(submission N×)` tally can be inherited from another session;
- a long-running process accumulates one entry per refused path, forever.

## Required work

1. Key entries by `${sessionKey}:${absolutePath}` (the session key is available at every call site: `deps.sessionKeyFor(ctx)` in `src/lifecycle-hooks/index.ts`, `sessionKey` in the pipeline and write hook).
2. Bound the map — LRU cap, TTL, or an explicit clear on session end. Prefer the seam `noopLoopTracker` (`src/noop-guard.ts`) already uses if it offers one.
3. Tests: two sessions refusing the same path must not share a count; a sequence must still sharpen within one session; many refused paths across sessions must not grow the map without bound.

## Constraints and the open decision

- The settled design keeps this state in-process only: no persistence, no suppression registry, no cross-turn obligation. Do not introduce either.
- **Open question for the operator**: which lifecycle seam owns eviction (session-end hook vs TTL vs LRU cap)? Resolve that before implementing.


## Comments

### @Rianico — 2026-09-21T03:35:47Z

# Resolution & Code-Review Handoff: Three Justified Judgement Calls (#132)

Following the final code review under Standards, Keel, and Programming Expert guidelines for the completed implementation on `fix/132-served-echo-session-scope` (commits `fd18fe0`, `57f10d5`, `156f5db`), all three baseline judgement calls have been reviewed and accepted:

### 1. Data Clumps / Parameter Bundling (Suppressed / Approved)
- **Review Finding**: `(sessionKey: string, absolutePath: string)` travels together across `refusalKey`, `trackRefusal`, `clearServedRefusals`, and the public tracking seams.
- **Resolution & Rationale**: Retained as direct positional primitives (Option A). The inline `// WHY:` documentation justifies zero object allocation churn on the error path and consistency with established conventions across the codebase (`createSessionHandle`, `loadServed`, `clearNoopLoop`). Adding a `RefusalScope` wrapper would introduce unnecessary allocations without preventing argument-order slips.

### 2. Primitive Obsession / Delimited Keying (Enforced / Approved)
- **Review Finding**: Serializing composite keys as `${sessionKey}\0${absolutePath}` risks delimiter collision if an input contains `\0`.
- **Resolution & Rationale**: The delimiter invariant is now actively enforced rather than assumed: `refusalKey` throws a fail-closed `TypeError` (`Invalid refusal scope: NUL in session key or path`) if either part carries `\0`. Delimiter safety is validated by bidirectional unit tests and falsified when the guard is removed. This upholds the "Delimiters lie" principle while preserving $O(1)$ global LRU cache lookups and head-eviction without nested map traversal.

### 3. Speculative Generality / Defensive Bounding (Preserved / Approved)
- **Review Finding**: `trackRefusal` uses a `while (servedRefusalTracker.size > SERVED_REFUSAL_MAX_ENTRIES)` loop after insertion even though current callers insert one key at a time.
- **Resolution & Rationale**: The post-insert `while` loop cleanly eliminates unreachable `undefined` branch checks present in previous `keys().next().value` guards, raising branch coverage in `src/hashline/served-guard.ts` to 98.18%. It defensively guarantees that the 256-entry total cap holds under any future multi-key insertion pattern without expanding the public API surface.

---

### Verification Summary
- **Tests**: 154 files, 1,521 passed, 1 skipped.
- **Coverage**: Statements 90.99%, Branches 85.20%, Functions 90.95%, Lines 92.11%; `served-guard.ts` at 98.18% branch coverage.
- **Linters**: OxLint (0 errors), OxFmt clean, `tsc --noEmit` clean, `changelog-unreleased.py check` in sync.
- **Keel Architectural Judgment**: **Closed** (0 open items).


### @github-actions — 2026-09-21T16:47:33Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
