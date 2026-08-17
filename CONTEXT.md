# Hashline Edit

A hash-anchored file-editing extension for the pi-coding-agent: every line of a file carries a stable, content-derived 3-char hash, and replace operations anchor on hashes, failing closed rather than relocating silently.

## Language

**serve**:
To deliver a line's `HASH│content` row into the model's context through tool output. Reading serves the rows it shows; a post-edit diff serves its rows; an error's fresh-anchor feedback serves its rows.
_Avoid_: display, show, echo

**served state**:
The tool's per-file, per-line record of the hash last delivered to the model for each line — a mirror of the model's knowledge of the file, maintained by the tool and cleared at session start.
_Avoid_: expectation, last read, snapshot

**model–tool boundary**:
The separation of responsibilities: the tool owns verification of what the model submits; the model owns intent. The tool never relies on the model to supply verification data or to perform pre-edit rituals (re-reading) to keep its own checks honest.
_Avoid_: —

**anchor philosophy**:
The project's core contract: per-line anchors are content-derived with ASCII whitespace (`[ \t\r\n]`) stripped, stable for unchanged lines and across whitespace-only formatting, and position-independent; an anchor that cannot be resolved is rejected, never fuzzy-matched or silently relocated. Byte-level detection of non-whitespace changes is unchanged — token-level edits still rotate the anchor (ADR-0005).

**boundary staleness**:
An anchor that no longer resolves against the current file because the line's content changed since it was served.
_Avoid_: stale anchor (ambiguous between boundary and range staleness)

**interior**:
The lines of a resolved range strictly between `remove_from` and `remove_to`.

**range**:
The resolved contiguous run of lines between `remove_from` and `remove_to` in the current file — the model-facing word for what a replace touches.
_Avoid_: hunk, region

**span**:
A contiguous interval of lines; the technical word used when verification compares two such intervals. The check compares the served span against the current span.
_Avoid_: hunk

**served span**:
The contiguous run of served hashes between the two boundary anchors' served positions — the served-state reconstruction of the model's view of a range.

**range staleness**:
The condition where a resolved range's interior cannot be reconciled with served state: a served line's content changed since it was served, or the line was never served.

**never-served**:
An interior line with no entry in the served record — the model was never shown that line. Reported as `[E_RANGE_UNSERVED]`; the response serves the current range so the model can retry.

**reject-and-serve**:
The staleness policy: reject the edit and return the current range as fresh `HASH│content` rows, which themselves count as serves, so the retry needs no read.
_Avoid_: reject-then-reread (the retry must not require a read)

**drift**:
The divergence between the served state and the current file: lines the model was shown whose content has changed on disk since they were served. Detected by comparing served hashes against current hashes.
_Avoid_: modification, external change (the tool cannot know the source)

**drift notice**:
The informational section appended to a replace result (applied or noop, not undo) when drift lies in served territory outside the replacement range: the current content of the drifted lines, capped, with rows counting as serves. Fires once per drift episode — already-reported drift shrinks to a one-line pointer until a read re-serves the lines.
_Avoid_: warning (the operation succeeded; it is information, not a warning)

**read_skill**:
To read a file's content as plain text — no hash prefixes, no served rows. The model's tool for loading skill content (SKILL.md or any file in its directory) to invoke and consume; `read` remains the hashed read for edit targets.
_Avoid_: plain read, skill tool

**reference read**:
A read that serves no hashes and records no served state — the model consumes the content rather than editing it. `read_skill` is the only reference read.
_Avoid_: unmanaged read

**tool-name-as-intent**:
The principle that a tool's name encodes the model's intent — `read` (hashed, editable) vs `read_skill` (plain, consumable) — so the model always knows what it's getting.
_Avoid_: —

**payload contract**:
The model-facing JSON shape used to state a file edit; it carries a path, an inclusive anchor range, and replacement text without changing the verified edit semantics.
_Avoid_: patch language, command language

**inclusive anchor range**:
A pair of boundary anchors identifying the first and last lines of a model-facing range; both boundaries are included.
_Avoid_: hunk, region

**nullable path**:
A path position that may be `null` when the tool can resolve a unique target from the anchor range. The position remains present in a fixed tuple.
_Avoid_: optional path

**compact JSON tuple**:
A fixed three-position JSON array representing path, inclusive anchor range, and replacement text.
_Avoid_: patch language, array shorthand
