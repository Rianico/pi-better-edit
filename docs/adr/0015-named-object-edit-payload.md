# ADR-0015 — Named-object edit payload with `file` and `anchor_*` fields

Date: 2026-09-05

## Status

accepted

Supersedes the tuple shape of [ADR-0007](0007-merged-edit-payload-hoisted-path.md) (hoisted root and arity semantics stay).

## Context

The taught payload was `{ "path": …, "edits": [[remove_from, remove_to, replacement_text], …] }`. Three problems surfaced: models passed directories to `path` (the name invites any filesystem path); `remove_*` verbs imply deletion rather than addressing; and positional tuples (`Type.Tuple`) are rejected by some LLM provider APIs — the same class of breakage that forced `StringEnum` over `Type.Union` for Google. Grill rounds (R1 Q1–Q5, R2 Q6–Q10) settled: rename to `file`, `anchor_from`/`anchor_to`, `replace_with`; named objects over tuples; `file` required; prose teaches concepts (anchor / separator / content / how-to-edit) with no error-code catalog.

## Decision

- **Taught contract:** `{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "replace_with": text }, …] }`. `file` is a required non-empty string (a text file, never a directory). Items are named objects with `additionalProperties: false`. `anchor_from`/`anchor_to` keep `from`/`to` ordering (not `start`/`end` — positions contradict `anchor philosophy`) while swapping the deletion verb for the glossary's leading word `anchor`. `replace_with` reads as an instruction; `content` stays reserved for served-row right-of-`│`.
- **Compat shim, strict schema:** the public `editToolSchema` declares objects only; `prepareEditArguments`/`editRequestFrom` fold legacy pre-validation — tuples → objects, `path`/`file_path` → `file`, legacy item keys → new keys, `file_path` keeps its deprecation warning. Legacy `null` file still resolves via anchor inference, undocumented. `assertReq` rejects unknown fields with new names.
- **Prose without codes:** description covers what/when/when-NOT/params/returns/limits plus one object example; snippet is the one-liner plus tiniest example; every guideline bullet names `edit` explicitly (Pi flat-append rule), written positive second-person imperative. Exactly one channel line survives (`[MODEL]` in content = you retry from the message alone; `[USER]` dimmed = human info). Six error strings were fixed at the source instead (`E_NOT_FOUND`/`E_ACCESS`/null-byte/non-absolute retry verbs, `E_STALE_ANCHOR` re-read wording, jargon-free `E_STALE_RANGE` variants with echo + retry hint, disambiguated `E_REVERSED_ANCHORS`, explicit healed-vs-refused strip messages).
- **Glossary:** `payload contract`, `edits`, `inclusive anchor range`, `pure edit`, `E_SERVED_ECHO` renamed; `nullable path` → `file`; `compact JSON tuple` → `edit item`; new `separator` entry.

## Considered Options

- **Keep `path`, sharpen description only** — rejected per R1 Q1: the token itself primes directory-passing; `file` recruits file-only priors at zero schema cost.
- **`anchor_start`/`anchor_end`** — rejected: `start`/`end` imply positions, contradicting position-independent anchors.
- **Keep tuples, document around provider rejections** — rejected per R1 Q2–Q3: provider-side tuple rejection is unfixable from prose; objects cost ~30% more tokens per call but validate everywhere.
- **Hard break (no shim)** — rejected per R2 Q6: Pi's `prepareArguments`-as-shim keeps resumed sessions alive while the taught contract stays strict.
- **Keep teaching `E_*` codes in guidelines** — rejected per R2 Q9: recovery belongs in the error text (now self-sufficient), concepts belong in prose; one channel line bridges them.

## Consequences

- `src/payload-contract.ts` is the single source (`editFileSchema`, `editItemSchema`, `editToolSchema`, `EDIT_*` prose); `prompts/edit*.md` mirror it byte-for-byte (sync test); `src/edit.ts` re-exports the new schema names; `HTEdit`/`EditItem`/`EditParams` use new keys; tests teach the object shape plus a legacy-fold battery.
- `README.md` Tools table, payload paragraph, and error table use the new names.
- Drift notice stays `[USER]`-only per ADR-0014; `[E_BAD_PAYLOAD]` channel behavior unchanged.
