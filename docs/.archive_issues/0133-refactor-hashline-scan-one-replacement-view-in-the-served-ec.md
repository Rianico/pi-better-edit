# refactor(hashline): scan one replacement view in the served echo gate

> **Archived from pre-migration issue #133.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-16T09:31:01Z · state CLOSED · labels: ready-for-agent, released

## Body

## Finding (follow-up review, benign redundancy in `applyEdit`)

`src/hashline/apply.ts:276-280` builds three replacement views and scans each for a served hash echo:

```ts
const views: Array<{ lines: string[]; offending: string[] }> = [
  { lines: rawReplacementLines, offending: rawReplacementLines },
  { lines: resolved.content_lines, offending: resolved.content_lines },
  { lines: prefixFixed.content_lines, offending: prefixFixed.content_lines },
];
```

The three-view shape is a remnant of the retired shape-based stripping (#126): each pipeline stage used to rewrite `content_lines`, so every stage needed its own scan. Nothing rewrites them any more.

## Verification (do this yourself, it is cheap)

- `apply.ts:248` `rawReplacementLines = [...edit.content_lines]` — a shallow copy, same values.
- `apply.ts:251` `prefixFixed = prepareEdit(...).fixed` = `swapReversedRanges(edit, …)`; `resolve.ts` returns `edit` unchanged when the range is not reversed, and `{ ...edit, hash_bounds: [endRef, startRef] }` when it is — `content_lines` is carried by reference in both branches, and only the bounds are swapped.
- `src/hashline/lease-resolve.ts:64` returns `content_lines: edit.content_lines` — the same array by reference.

So all three views hold one and the same array; the second and third are the same object. The `offending` field is likewise always identical to `lines`.

## Required behaviour

1. Scan one view only: `resolved.content_lines` — the lines that will be written, and already the view the middle-tier `findServedPrefixMismatches` scan uses (see the mismatch scan later in the same function).
2. Delete the now-unused `rawReplacementLines` declaration and the `views` array; drop the `offending` field and read the offending line directly (`resolved.content_lines[hit.k - 1] ?? ""`).
3. Keep `prefixFixed` — it is still needed for `resolveEdit` and `warnUnicodeEsc`.
4. Rewrite the WHY comment above the scan: it currently justifies scanning "each replacement view"; replace it with the reason one view suffices now (nothing rewrites `content_lines` between `prepareEdit`/`resolveEdit` and the write).

## Tests (test-first where practical)

- Existing served-echo coverage plus the downstream issue #63 pin must stay green unchanged — they are the oracle that detection behaviour is identical.
- Add one regression test: a served echo submitted with **reversed anchors** (the `[E_REVERSED_ANCHORS]` healed path) is still refused, pinning that the healed path cannot bypass the gate.

## Invariants

- No behaviour change: same refusals, same reported `k`, `hash`, `servedLine`, and the same written bytes.
- Detection stays evidence-only, never shape-based (ADR-0009 revision); the `mode: "literal"` escape is untouched.


## Comments

### @github-actions — 2026-09-21T16:47:39Z

:tada: This issue has been resolved in version 2.0.0 :tada:

The release is available on [GitHub release](https://github.com/Rianico/pi-better-edit/releases/tag/v2.0.0)

Your **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:
