# refactor(domain): replace forbidden synonyms in the resolution seams

> **Archived from pre-migration issue #101.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:39Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Three documented-standards violations: identifiers that use synonyms `CONTEXT.md` explicitly forbids. Pure renaming - no behaviour change.

## 1. `anchor identity` (forbidden)
`CONTEXT.md` **line identity** commands `_Avoid_: anchor identity, hash identity, epoch`. Identity belongs to lines (`line_id`), never to a presentation anchor.

- `src/hashline/resolve.ts` L70 declares `AnchorIdentityDecision`.
- `src/hashline/resolve.ts` L83 declares `resolveAnchorIdentity`.

**Remedy**: rename to line-identity vocabulary (for example `LineIdentityDecision` / `resolveLineIdentity`), updating every import and call site. The name must not contain the phrase `anchor identity`.

## 2. `range staleness` (forbidden)
`CONTEXT.md` **served-range staleness** commands `_Avoid_: range staleness (use served range for span)`.

- `src/hashline/served-verification.ts` L18 module docstring lists `"CONTEXT.md terms preserved: ... range staleness"`, endorsing the avoided synonym.

**Remedy**: correct the docstring to the canonical `served-range staleness`, and fix any other occurrence inside that module.

## 3. `echo` used for served feedback rows (forbidden)
`CONTEXT.md` **serve** commands `_Avoid_: display, show, echo` and defines `serve` as delivering `HASH|content` rows through tool output or error feedback. `echo` is canonical **only** in `served hash echo`.

- `src/mutation-engine/pipeline.ts` L469 `recordRejectionEcho`, L490 `batchAbortEchoBlock`.
- `src/hashline/lease-resolve.ts` L69 and L101 (comment/identifier naming the served feedback rows as an echo).

**Remedy**: rename these identifiers to `serve` vocabulary (for example `recordRejectionServe`, `batchAbortServeBlock`).

**Do NOT rename** the canonical `served hash echo` family - `E_SERVED_ECHO`, `EditHashEchoError`, `findEditHashEcho`, `served hash echo` tests or docs - those names are correct.

## Acceptance criteria
- No identifier or comment in `src/` uses `anchor identity` or `range staleness`.
- The named `echo` identifiers are renamed; a repo-wide audit of `echo` in `src/` shows only the canonical `served hash echo` family.
- Behaviour is unchanged: rename only, no logic, message or error-code change; every existing test passes unmodified.
- All 15 Stage-0 probes stay green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:03Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
