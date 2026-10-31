# Bounded served hash echo guard for write and edit

Date: 2026-08-27

## Status

accepted

## Context

Downstream `dsh-better-edit#29` — after N `write` calls the file contained `lGp│nT2│CCd│UIA│## 1. H1` — the model copied the entire `HASH│content` preview chain into file content. `pi-better-edit` heals `remove_from`/`remove_to` via `stripBarePrefixes` (`E_BAD_ANCHOR` → 50% `WARN_HEALED` in separator shootout), but `replacement_text` and built-in `write` `content` had no guard — hashes would enter disk. Grill with `keel` + `domain-modeling` agreed: keep `HASH│content` presentation, don't hide hashes; add a bounded, fail-loud guard.

## Decision

We add a pre-dispatch/write guard for both surfaces, same bounded rule:

- **Same-session / same-canonical-path / same-line exact match** — a candidate line `k` that begins with `${hash}│` where `hash === served[pos]`. For `write` `pos = k` (absolute line `i` vs `served[i]`); for `edit` `pos = startLine + k` (range-relative `E1` alignment). Ported from `dsh@0.4.1` `findServedHashEcho`.
- **Deny, not strip (AA: A)** — `[E_SERVED_ECHO]` / `[E_SERVED_ECHO]`, file byte-identical, retry with bare content. Never generically strip `^[A-Za-z0-9]{3}│` — `Zz9│literal` stays valid.
- `write` guard lives as `tools/pre-execute` (pi) / `write-hook.ts` (dsh); `edit` guard lives at `valEdit` admission before `verifyServedRange`.

## Considered Options

- **E2 any-served-at-file** — any hash in served set at any line → catches reordered copies but false-positives on docs containing `Ab3│` where `Ab3` happens to be served elsewhere. Deferred.
- **E3 generic strip** — `replace(/^[A-Za-z0-9]{3}│/, "")` on every `replacement_text` line — rejected, hides bug and corrupts legitimate `HASH│` literals in docs.
- **Silent strip+warn (B)** — `boundaryDups` precedent (one duplicated boundary line, intent clear) — rejected for `N`-line chains; stripping `aB3│bC4│cD5│text` one layer leaves `bC4│cD5│text` still polluted; file write is irreversible, better to fail-loud.
- **Hide hashes (plain-text read + content anchors)** — rejected, deletes `served state` fact authority (ADR-0001), worsens duplicate `}` disambiguation and token cost (hash 3 vs line 30-60).

## Consequences

- `CONTEXT.md` adds `[[served hash echo]]`, `[[E_SERVED_ECHO]]`, `[[E_SERVED_ECHO]]` — deny semantics, range-relative `E1`.
- Prompt stays `replacement_text is bare content without HASH│`; error hint says `remove the entire copied anchor chain`.
- Tests port `dsh/test/core/write-hook` guard for `write` plus new `edit` cases (`S1` `Ab3│` at `s+k` → deny, clean retry → allow).
- Separator stays `│` — strong delimiter, weak-space shootout irrelevant; guard is delimiter-agnostic (uses `HASH_SEP`).

## Revision 2026-09-15 — served-row evidence and the literal declaration

Supersedes the Decision clause "Same-session / same-canonical-path / same-line exact match" and the Considered Options deferral of E2.

- **Refined `served hash echo` condition (position-agnostic, content-matched)** — a candidate line triggers `E_SERVED_ECHO` only when it begins with a served anchor and reproduces the served content that anchor was served with. One such row suffices, at any position; an optional leading `+`/`-`/space git diff marker is tolerated. Detection is evidence-only — the tool never gates on the shape of a line. Where no canon data is retained for the anchor there is no evidence, so the candidate stays silent. Detected before dispatch/write, file stays byte-identical. Not a generic `^[A-Za-z0-9]{3}│` strip.
- **E2 closed in evidence-based form** — the deferred "any-served-at-file" option is closed: the deferral reason was false-positive cost on docs containing a served anchor by coincidence, which content matching removes. A bare anchor without its served content no longer triggers.
- **`literal declaration` is the sole escape** — the caller asserts via `mode: "literal"` that bytes reproducing served rows are intended file content. The guarantee therefore reads "never unwittingly": reproduced served rows reach disk only under an explicit declaration.
- **Shape-based refusal on the content surface is removed** — the shipped code had drifted (code drift) from this ADR's own "never generically strip / `Zz9│literal` stays valid" decision by refusing bare `HASH│` shapes; that refusal is removed. Only evidence-backed `E_SERVED_ECHO` remains.
- **#108 freeze is served-qualified only** — the "MUST NOT rename" freeze now covers served-qualified names only (`findServedHashEcho`, `E_SERVED_ECHO`, the `served hash echo` condition name); the surface-qualified `findEditHashEcho` is not frozen.
- **Auditable declaration** — each `mode: "literal"` write leaves a dimmed `[USER]` line and increments a `literalDeclarations` metric.
