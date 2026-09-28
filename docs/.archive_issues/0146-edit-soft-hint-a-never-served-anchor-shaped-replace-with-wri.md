# edit: soft-hint a never-served anchor-shaped replace_with (write verbatim, then warn)

> **Archived from pre-migration issue #146.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-18T09:21:11Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

## Decision (2026-09-15)

A `replace_with` line that looks like a served row (`HASH│content`) but whose anchor/canon was **never served** must be written as-is, with a non-blocking soft hint. The served-row case keeps its refusal (`[E_SERVED_ECHO]`, escapable with `mode: "literal"`).

## Current behavior on `ba7c8d2`

- The content surface no longer gates on shape (ADR-0009 revision 2026-09-15: "the tool never gates on the shape of a line").
- Served echo → refused with `[E_SERVED_ECHO]` (`src/hashline/served-guard.ts:258-264`).
- Never-served anchor-shaped content → written verbatim with **no signal** (measured: `ZZZ│alpha` reached disk, reported "Successfully edited 1 file(s)").

## Open points for review

1. **Channel — corrected framing.** `[MODEL]` is not "retry instruction". `docs/adr/0014-user-model-audience.md:19` defines the prefix as an audience/display marker: *"Audience is display-layer only… `[MODEL]` normal vs `[USER]` dimmed collapsed; prefix survives monochrome logs."* The retry reading comes only from `prompts/edit-guidelines.md` / `EDIT_GUIDELINES` (`src/payload-contract.ts:95`), and that sentence is scoped to a `[MODEL]` line **in `content`**.
   Precedent for a non-blocking `[MODEL]` line that requires no action: `src/edit-tool.ts:53` emits `[MODEL] [E_BAD_PAYLOAD] Autocorrected: missing "file" resolved to …` as a **warning**, prepended to `warnings` at `src/edit-tool.ts:153-158`, and `src/edit-response.ts:139-141` appends `warnings` to the model-visible content (`warnBlock`). So both channels reach the model:
   - (i) `content` + `[MODEL]` — loudest and unambiguous; but the guideline sentence needs a qualifier, otherwise the model reads a soft hint as a retry demand.
   - (ii) `warnings` — appended to content by `warnBlock`, dimmed in the TUI, non-blocking by construction; however the editorial convention for that channel is `[USER]` (the autocorrect precedent puts `[MODEL]` inside it).
   Recommendation: (i), with the guideline sentence adjusted, because "soft hint **to the model**" is the point of the decision.
2. Granularity: once per call, once per offending line, or deduped per file?
3. Wording: name the anchor; state that nothing was rewritten and that no action is required unless the bytes are accidental.
4. Should `mode: "literal"` suppress the hint?

## Acceptance

- The write still happens verbatim: no new refusal, no rewrite.
- The hint is non-blocking: the edit reports success and the file bytes equal the submitted content.
- A served-row echo still refuses with `[E_SERVED_ECHO]`; existing pins stay green.
- Tests: never-served anchor-shaped content → success + hint; served echo → refusal; literal declaration → success without refusal.

## Related

- #132 (served-echo refusal tracking), #136 (rejection contract).


## Comments

### @Rianico — 2026-09-18T10:23:05Z

## Maintainer decisions on the open points (2026-09-15)

- **Point 1 — channel:** (i) `content` + `[MODEL]`, **with the guideline sentence adjusted.** `prompts/edit-guidelines.md` / `EDIT_GUIDELINES` (`src/payload-contract.ts:95`) currently says a `[MODEL]` line in `content` "is your retry instruction"; it must allow a non-blocking `[MODEL]` note that requires no action. That is why the guideline edit belongs to this ticket, and it is the same adjustment ADR-0014's audience rule implies (see the `E_UNDO_STALE` row in #147).
- **Point 2 — granularity:** once per call — one hint per `edit` call, however many offending lines it contains.
- **Point 3 — wording:** tell the model that the anchor-shaped content matches the tool's own row shape, so it realizes what it is about to write. No instruction and no remedy demand.
- **Point 4 — `mode: "literal"`:** does not suppress the hint.

### Citation correction

The quoted clause "`[MODEL]` normal vs `[USER]` dimmed collapsed, prefix survives monochrome logs" is at `docs/adr/0014-user-model-audience.md:13` (the grill-round summary), not `:19`; `:19` is the line stating the rule ("error `content` headers are emitted as `[MODEL] [E_*] …` normal"). Fixed in `docs/spec/error-code-consistency-audit.md`.


### @Rianico — 2026-09-20T14:33:00Z

Verified on `main` @ `3b22008` (landed as `59b8454`, hardened by the `W_*` tier round).

An anchor-shaped `replace_with` never served for this session and file is written verbatim and narrated, not refused: `W_NEVER_SERVED_SHAPE` carries the count and is capped at one hint per call (`src/hashline/served-guard.ts:275`, registry entry at `src/domain-errors.ts:466`). The served-echo case still refuses with `[E_SUSPICIOUS_TEXT]`, so the decision in this issue holds exactly as written.

Closing as resolved.
