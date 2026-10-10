# ADR-0032 — Flat wire item contract for the edit tool

Date: 2026-10-02

## Status

accepted — required by ticket-06 v2 (`edit-op` lane). Records the SHIPPED contract
at base `9c9da08`; supersedes the payload **shape** decisions of ADR-0015; continues
ADR-0007's hoisted-root/arity semantics unchanged; ADR-0021 d4 supersedes §D6's
payload-shape phrasing in part (the code alone selects the remedy; row presence
is a payload detail). Ordering note: this record was authored as `0027` to fill the gap
before `0028`, but ADR-0027 (prebuilt bundle) reached the trunk first and already
held `0027`, so this record moved to `0032` rather than share a number.

Amended by [ADR-0036 — Optional wire fields are declared nullable](0036-optional-wire-fields-declared-nullable.md)
(the five optional properties now admit `null` as a legal spelling of absent; the flat item, the
XOR, and every required field are unchanged)

## Context

The pre-04 contract text (including the superseded `ticket-06-decision-record.md`,
whose sentences about a required `op`, `copy_from`, `delete_source`, or a
`DesiredText` union are FALSE) described a wire that was never shipped. This ADR
replaces it with the artifact. Conventions: every artifact claim carries the
command that re-derives it (E29); frozen strings are pinned by literal, never by
line number; hashes carry commit + command.

## Decision

1. **The item is FLAT, has NO discriminator, and ZERO `op`.**
   Command: `grep -cn '\bop\b *:' src/payload-contract.ts` → `0`.
   The payload variant is carried implicitly by which field is present:
   `text` = hand-written bytes; `text_ref` = a served span's bytes;
   neither = refuse. The internal union `DesiredContent` = `literal` |
   `reference` | `empty` (`grep -n 'export type DesiredContent'` →
   `src/payload-contract.ts:56`; `NormalizedEditItem` at `:61`) is the ONLY
   place the variant tag exists explicitly; it is normalized at the single
   admission boundary and switched over exhaustively with `assertNever`.

2. **Exactly one payload per item: `text` XOR `text_ref`.** Both present is
   refused; neither present is refused. Command:
   `sed -n '/const ITEM_SHAPE/,+1p' src/payload-contract.ts` →
   `const ITEM_SHAPE =` + `"an item is exactly { anchor_from, anchor_to,
   text[, at] } or { anchor_from, anchor_to, text_ref[, at] }"`.

3. **`text_ref` = `{ anchor_from, anchor_to, file?, mode: "copy" | "cut" }` --
   `mode` strictly REQUIRED (never inferred).** A foreign `file` names another
   served file -- a foreign-source copy (never "cross-file" here; that word
   named a dropped multi-file batching idea -- see Glossary). `copy` re-inserts
   the span and keeps the source; `cut` additionally retires it. Both modes
   apply to a foreign file, and a foreign `cut` commits insert and retirement
   as one correlated transaction (ADR-0028).

4. **`at?: "in-place" | "before" | "after"` -- OPTIONAL, defaults to
   `"in-place"` when omitted; `"in_place"` is REFUSED.** Command:
   `sed -n '/const AT_SPELLINGS/p' src/payload-contract.ts` →
   `const AT_SPELLINGS = ["in-place", "before", "after"] as const satisfies
   readonly Placement[]`. Placement is decoupled from payload semantics: `at`
   never changes what is written, only where. (README:253; CONTEXT.md.)

5. **Delete = `text: ""` IN PLACE.** A bare anchor pair with no payload field is
   refused rather than silently deleting. `text: ""` with `at: "before"` or
   `"after"` yields `[W_NOOP_INSERT]` and NO-OPs (not a delete, not an error).
   (README:254; `rg -c '^\s*\| "W_[A-Z_]+"' src/domain-errors.ts` → `7`.)

6. **A foreign-source anchor that was never served is REJECTED, not warned.**
   Reason: `[W_*]` denotes an applied mutation and nothing was applied. The
   deviation from the original ticket text is deliberate and reasoned, not
   accidental. (Routed from ticket-04; refusal witness:
   `test/tools/edit.foreign-cut.test.ts`.)

7. **Compat-free removals, each with its reason (a removed guard's reason must
   survive its removal):**
   - `replace_with`: REMOVED, not aliased. Safe because nothing live produces
     or consumes it (only the removal-documenting comment at `src/edit.ts:32`
     names it); the schema refuses it with a teaching message
     (`unsupported field(s) "replace_with"` --
     `test/tools/edit.wire-contract.test.ts:126`); the retired-spelling ban
     (`test/arch/terminology-synonyms.test.ts`) keeps the deletion falsifiable.
   - Positional tuple fold (`itemFromTuple`): REMOVED. Safe because no caller
     remains (command `grep -rn 'itemFromTuple' src/` → no matches); the
     canonical spelling is the named-key item of Decision 2.
   - `LEGACY_ITEM_KS`: REMOVED. Safe because no reference remains (command
     `grep -rn 'LEGACY_ITEM_KS' src/` → no matches).
   - `file_path`/`path`: NOT removed -- CORRECTION to the ticket text, with
     command: `sed -n '8,20p' src/utils.ts` shows `normalizeFilePath` still
     ACCEPTS `file_path` with a `[DEPRECATED]` warning, maps it to `path`,
     and deletes the alias before admission ("will be removed in a future
     version"). Stating a removal here would be false. Safe to keep pending
     that removal because the warning teaches `path`, the alias is deleted
     before admission (never reaches the wire), and the retired-spelling ban
     deliberately excludes it. A reader who sees this absence of a removal
     now knows it was deliberate.

8. **Two assembly paths remain separate; the unification question is CLOSED
   for this lane.** Reason: collapsing the span-ref path into the byte fold
   reinstates the clamp that corrupted 51/154 legal adjacent moves; the
   line-coordinate assembly is not byte-neutral because `resToSpan`'s
   EOF-deletion arms are not reproducible from a line list. General rule: when
   two representations must agree and one is a shipped, pinned, byte-asserted
   contract, that side wins by default.

9. **Transport citation (auditable form of record).** The wire is flat because
   the transport refuses structured unions: an `anyOf` whose variants are
   objects or arrays throws (`makeJsonSchemaNodeStrict`; upstream-only:
   `@earendil-works/pi-ai` is not an installed package here -- the function is
   vendored inside the `@earendil-works/pi-coding-agent` bundle), and the
   strict-key array `UNSUPPORTED_STRICT_SCHEMA_KEYS` (16 entries) rejects
   `$ref`/`$defs`/`definitions` (schema reuse) and `patternProperties`
   (property-keyed maps) -- the three techniques a contract author reaches for
   first when expressing a uniform edit item. Mechanics: package + version
   `@earendil-works/pi-ai@0.84.4`; the lock key pair
   `pnpm-lock.yaml:443` (`'@earendil-works/pi-ai@0.84.4':`, the declared spec)
   + `:3345` (`'@earendil-works/pi-ai@0.84.4(supports-color@7.2.0)(ws@8.21.3)':`,
   the resolved variant); the scope is linked but has no `pi-ai` entry -- the
   transitive package is reachable only through `.pnpm`; reproduction command
   `find node_modules/.pnpm -path '*pi-ai*' -name 'constrained-sampling.js'
   -exec grep -n 'UNSUPPORTED_STRICT_SCHEMA_KEYS' {} +`. Never a `/tmp` path,
   never a bare store path. Scalar `anyOf` is permitted (the library emits it
   itself); its shape guard and variant-iteration helpers sit beside the
   strict-key array in the same function.

10. **Glossary.** *foreign-source copy*: a `text_ref` whose `file` names
    another served file (README:255; never called "cross-file" here).
    *multi-file batching*: the DROPPED idea that word named -- there is no
    multi-target batch call; `EditRequest.file` stays singular per ADR-0007
    and the second file of a cut is a side effect of one item (ADR-0028).

11. **Frozen strings, pinned by literal (line numbers and hashes drift;
    strings do not).** `"in-place"`, `"before"`, `"after"` (placement);
    `"anchor_from"`, `"anchor_to"` (payload keys); the `E_*` census
    (`rg -c '^\s*\| "E_[A-Z_]+"' src/domain-errors.ts` → `21`) and the `W_*`
    census (`rg -c '^\s*\| "W_[A-Z_]+"' src/domain-errors.ts` → `7`),
    re-derived at `9c9da08`. If a hash is cited: `git show
    <commit>:src/domain-errors.ts | md5 -q` -- a hash without its commit and
    its command is a coordinate, not a fact (`7344b052125b1a2f9dfcf67130dc388f`
    at `9c9da08`; `f2d88e89894139e6193256fc2f1598cb` was true only at
    `e74875f`). Correction relayed: `resolve.ts:331` is NOT a wire string (it
    is `const notFound = mismatches.filter((m) => m.kind === "not_found");`);
    only `:349`/`:355` carry the `"anchor_from"`/`"anchor_to"` key checks.

12. **Routed doctrine (recorded, not re-decided).** Condition (b): the rendered
    message must not contradict any remedy it carries, and must not instruct
    an action wrong for its cause; it need not prescribe (authority:
    `domain-errors.ts:14-25`, not the original wording). Pre-existing:
    `pipeline.ts:255` contradiction (present at `7738746`; 04 extends the
    class rather than introducing it). Library surface verified clean at
    `baef230` (no removed wire symbol still re-exported; `replaceWithSchema`
    survives only in the `src/edit.ts:32` deprecation comment). Open item,
    owned by the operator (ADR-0021 question, do not action here): `remedy`
    is a per-code field (`domain-errors.ts:209-213`), so a code whose payload
    can express several causes can append advice false for one of them.

## Consequences

- Consumers (CHANGELOG `[Unreleased]`) break on: `replace_with`,
  `file_path`/`path` (deprecated alias, warn-taught), positional tuples, the
  legacy item keys; gain the flat item (`text` / `text_ref{mode}` / `at`)
  in which replace, insert-before, insert-after, delete, copy and move are
  each expressible; note the `resEdit` signature change (internal rename
  reaching the public barrel at `src/hashline/index.ts:34` -- consumer-visible
  even when no model sees it). Wording kept strictly additive in evidence.
- Witnesses: `edit.wire-contract.test.ts`, `edit.foreign-cut.test.ts`,
  `terminology-synonyms.test.ts` (ban + presence), `terminology-foreign-source.test.ts`.
- `W_REVERSED_ANCHORS` is not decided here (out of scope).
