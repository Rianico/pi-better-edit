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
The separation of responsibilities: the tool owns verification of what the model submits; the model owns intent. The tool never relies on the model to supply verification data or to perform pre-edit rituals (re-reading) to keep its own checks honest, and never silently rewrites `replace_with` to "fix" the model's intent (e.g. stripping lines that duplicate outside the range). `range = hash_bounds, replacement = replace_with` is pure — no surprise rewrite.
_Avoid_: —

**anchor philosophy**:
The project's core contract: per-line anchors are content-derived with ASCII whitespace (`[ \t\r\n]`) stripped, stable for unchanged lines and across whitespace-only formatting, and position-independent; an anchor that cannot be resolved is rejected, never fuzzy-matched or silently relocated. Byte-level detection of non-whitespace changes is unchanged — token-level edits still rotate the anchor (ADR-0005).

**anchor staleness**:
An anchor (one line, `anchor_from` or `anchor_to`) that no longer resolves against the current file because the line's content changed since it was served (`hash`/`canon`/`tombstone` miss). The model must re-`read` for fresh anchors.
_Avoid_: boundary staleness (use `anchor` for one line, `served range` for span)

**interior**:
The lines of a resolved range strictly between `anchor_from` and `anchor_to`.

**range**:
The resolved contiguous run of lines between `anchor_from` and `anchor_to` in the current file — the model-facing word for what a replace touches.
_Avoid_: hunk, region

**span**:
A contiguous interval of lines; the technical word used when verification compares two such intervals. The check compares the served span against the current span.
_Avoid_: hunk

**served span**:
The contiguous run of served hashes between the two boundary anchors' served positions — the served-state reconstruction of the model's view of a range.

**served range**:
The model-facing word for the `served span` — the span between `anchor_from` and `anchor_to` as the model saw it. Alias to `served span` for glossary search.
_Avoid_: range (use `served range` for verified span, `range` for current file run)

**served-range staleness**:
The condition where the `served range` (span between anchors) cannot be reconciled with served state: interior `served span` vs `current span` mismatch (`hash`/`canon`/`tombstone`/`len`). Reported as `[E_STALE_RANGE]` (changed) or `[E_UNSERVED_RANGE]` (never-served). Both do `reject-and-serve`.
_Avoid_: range staleness (use `served range` for span)

**never-served**:
An interior line with no entry in the served record — the model was never shown that line. Reported as `[E_UNSERVED_RANGE]`; the response serves the current range so the model can retry.

**reject-and-serve**:
The staleness policy: reject the edit and return the current range as fresh `HASH│content` rows, which themselves count as serves, so the retry needs no read.
_Avoid_: reject-then-reread (the retry must not require a read)

**drift**:
The divergence between the served state and the current file: lines the model was shown whose content has changed on disk since they were served. Detected by comparing served hashes against current hashes.
_Avoid_: modification, external change (the tool cannot know the source)

**drift notice**:
The informational section appended to a replace result (applied or noop, not undo) when drift lies in served territory outside the replacement range: the current content of the drifted lines, capped, with rows counting as serves. Fires once per drift episode — already-reported drift shrinks to a one-line pointer until a read re-serves the lines. Classified as a user-facing signal (details only, not model content).
_Avoid_: warning (the operation succeeded; it is information, not a warning)

**model-facing signal**:
A model-visible signal the tool must include in `content` for correctness (e.g. `anchor staleness`, `served-range staleness`, `E_STALE_*`/`E_UNSERVED_*`, `E_SERVED_ECHO`). The model needs it to retry correctly.

**user-facing signal**:
A model-visible signal informative for the human only, emitted in `details`/`warnings` and rendered collapsed in TUI (e.g. drift notice, Batch drift note). Not in model content.

**orphaned serve**:
An entry in served state whose hash no longer matches the current file at that position — the mirror retained a hash that the file has moved or removed elsewhere. Contrast with never-served. An orphan is drift, but at a single position rather than a range. Superseded by ADR-0016: an anchor with no lease now rejects fail-closed (`[E_UNSERVED_RANGE]`) and a retired `line_id` rejects `[E_STALE_RANGE]`, rather than being healed onto a twin.
_Avoid_: stale serve (ambiguous with boundary staleness)

**orphaning re-serve**:
The serve event that creates an orphan: re-serving the same hash at a new position without nulling its previous served position — typically a partial re-read (or a serve/diff that covers the new but not the old slot) after an external relocation that kept the hash. A full re-read heals by overwriting every position; an orphaning re-serve leaves the stale slot behind. Superseded by ADR-0016: every serve path atomically upserts the anchor's `served_leases` row, so a re-serve replaces the lease instead of leaving a stale slot behind.
_Avoid_: duplicate serve (conflates duplicated content with relocated-line-keeps-hash)

**relocated line keeps its hash**:
The file condition where a line's content survives an external write and, because no probe collision occurs at its new spot, the same hash is reproduced by a fresh hashing pass. Distinct from "duplicated content" (same text at two positions in one file gets two different hashes via probing). Superseded by ADR-0016: a relocated line keeps its immutable `line_id`, and coordinate realignment is owned solely by `pairSnapshots` + `line_lineage`; hash reproduction no longer decides identity.
_Avoid_: duplicate content (implies same hash, which perfect hashing prevents)

**line identity**:
A line's stable identity across the file's materialized versions: the immutable `line_id` allocated for its content, plus its ancestry in `line_lineage`. Identity follows content, not coordinate — an exterior insert or delete shifts line numbers without changing `line_id`, which is exactly what lets an edit rebase silently. Distinct from the 3-char `anchor`, which is a presentation token the model copies out of a served row.
_Avoid_: anchor identity, hash identity, epoch

**lease** (served lease):
The `served_leases` row that binds a served anchor to the immutable `line_id` it denotes for the snapshot actually served: `(session_id, file_path, anchor) -> line_id, served_snapshot_hash, retired_at`. `serve` is the only operation that may create one, and it upserts atomically — re-serving an anchor replaces the row (fresh `line_id`, `retired_at = NULL`) instead of failing closed or leaving a stale slot. An edit resolves its lease strictly read-only.
_Avoid_: reservation, lock, epoch

**retirement** (`retired_at`):
Marking a lease terminal: after a snapshot commits, every `served_leases` row whose `line_id` is absent from that snapshot's `line_lineage` gets `retired_at` set. A retired identity is gone until a re-read (or `reject-and-serve`'s served rows) grants a fresh lease, so a stale anchor rejects `[E_STALE_RANGE]` instead of silently rebinding.
_Avoid_: tombstone (the hash-allocation guard, not a lease state)

**lineage** (`line_lineage`):
The per-snapshot table `line_lineage(snapshot_id, line_number) -> (line_id, canon_hash, anchor)`, written inside `BEGIN IMMEDIATE` for every materialized version held in `file_snapshots`. It is the sole coordinate authority: an edit looks its leased `line_id` up here and either rebases to the new coordinate or fails closed. A batch's commit writes it directly from the in-memory working buffer — surviving lines keep the `line_id` they already carry and only lines the batch created take fresh ids from `line_id_counters` — so re-pairing `S_latest` against the new content (`pairSnapshots`) stays a read-path mechanism, used where there is content to align and no working buffer to consult.
_Avoid_: epoch snapshot, served hash map

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
The model-facing JSON shape used to state one or more file edits in a single `edit` call: `{ "file": …, "edits": [{ "anchor_from": …, "anchor_to": …, "replace_with": … }, …] }`. The file is hoisted to the payload root (see file), and the `edits` array expresses arity — length 1 is a single edit, longer is a batched edit applied atomically to one file. There is no separate batch tool.
_Avoid_: patch language, command language

**edits**:
The payload's array of edit items; its length is the call's arity. The tool name `edit` covers single and batched edits — intent is expressed by arity, not by a separate tool.
_Avoid_: batch_edit (removed tool)

**inclusive anchor range**:
A pair of boundary anchors (`anchor_from`, `anchor_to`) identifying the first and last lines of a model-facing range; both boundaries are included.
_Avoid_: hunk, region

**separator**:
The `│` character dividing a served row into `HASH│content`. The model copies only the 3 chars before it into `anchor_from`/`anchor_to` and never emits it — in `replace_with`, in anchors, or anywhere in the call.
_Avoid_: pipe, delimiter

**file**:
The top-level payload field naming the text file to edit — a non-empty string, never a directory. It sits above the `edits` array rather than inside each item, so every edit in one call targets the same file. A legacy `null` (anchor-based inference) is still folded in code but untaught.
_Avoid_: path, optional path

**edit item**:
A named object `{ "anchor_from": …, "anchor_to": …, "replace_with": … }` — one entry inside the payload's `edits` array, the model-facing unit of mutation. Named fields (not positional tuples) so every provider schema accepts them. The file is not part of the item; it is hoisted to the payload root.
_Avoid_: patch language, tuple

**served hash echo**:
A candidate line that begins with the exact `HASH│` anchor served for the same session, canonical path, and line — tool output mistaken for file content. For `write` the check is absolute line `i` vs `served[i]`; for `edit` it is range-relative line `k` vs `served[startLine + k]` (AA: E1), where `startLine` is the first row of the served window — the remapped served start under a lease rebase, not the rebased coordinate. Detected before dispatch/write, file stays byte-identical. Not a generic `^[A-Za-z0-9]{3}│` strip.
_Avoid_: hash echo (without served qualification), anchor echo

**E_SERVED_ECHO**:
Refusal that `replace_with` (for `edit`) copied a `served hash echo` — `[E_SERVED_ECHO] Refused write to ${path}: line ${n} begins with the exact ${hash}│ anchor served for this session, path, and line` or `Refused edit to ${path}: replacement line ${k} begins with the exact ${hash}│ anchor served for this session, path, and range-relative line`. Remove the copied anchors and retry. Nothing was written. Deny, not strip — fail-loud, compensable.
_Avoid_: E_HASH_ECHO (ambiguous)

**boundary duplication** (historical — removed):
Former auto-fix that silently stripped replacement lines duplicating lines outside the range (`trailingDups`/`leadingDups` with byte `===`, and `firstNewAfterDups`/`lastNewBeforeDups` with `canon()`+`sectionIsUnique`). Removed as a fix: the tool is now pure `range = hash_bounds, replacement = replace_with`. A true duplicate stays loud in the post-edit diff/drift signal for the model to fix next turn; silent removal is irreversible (brace-balance loss). No new error code — the duplicate is preserved verbatim.
_Avoid_: dedup, autofix, trimming

**pure edit**:
The invariant that an edit is exactly the resolved range replaced by the exact `replace_with` with no boundary-dedup rewrite. Verified by `valEdit → verifyServed → resToSpan` with no intermediate splice.
_Avoid_: smart edit, autocorrection

**tombstone**:
The per-session (`sessionKey`, `path`) set of hashes freed since the last full `read` — `served.retired` in `src/served-session/session.ts`. Allocation (`HashIdentity`) treats `used = bitset(oldHashes) ∪ bitset(tombstone)` so a freed anchor never re-binds for the session. ADR-0017 keeps it only as the hash-allocation guard, not as a second identity authority. Cleared on `full read` (`isFullRead`), kept on `partial`/`truncated`, pruned with `served` via `SERVED_TTL_MS`. Prevents `S@3 reborn @3` whole-span stale success (`E_STALE_RANGE`).
_Avoid_: blocked, reserved (lease retirement is the `retired_at` term above; this entry's `served.retired` is a legacy v6 storage shell)

**epoch**:
The per-session, per-path read snapshot `{snapshotId: ino|mtime|size|checksum via fileSnap, servedHashes, servedCanons}` stored in `served.snapshotId`/`canons`/`hashes`. `read full` stores epoch; `partial` merges without clearing. `edit` compares `curId=fileSnap(path)` vs `epoch.snapshotId` to decide `resist` (pos-free, `==`) vs `strict` (pos-restricted, `!=`). Exterior drift (`insert @0` before `served 1..5`) stays `resist` when `changed ∩ [L,R]==∅`. Superseded by ADR-0017: the edit pipeline never populates an epoch, so it gates nothing — the concurrency signal is a leased `line_id` resolved through `line_lineage(C)`.
_Avoid_: version, snapshot (global last-writer-wins `snapshots` table is file-level, not per-session)

**position-free** (pos-free):
The single-thread verification mode where `verifyOrThrow` requires only `served[cFrom+k]==fileHashes[startLine-1+k] && tombstone∉ && canon==`, not `from==startLine-1`. Preserves `anchor philosophy` — exterior inserts do not abort unrelated ranges. Historically the default when the epoch comparison matched; ADR-0017 retired that gate in favour of lease resolution through `line_lineage`.
_Avoid_: strict pos (concurrency fallback only; that gate is retired by ADR-0017)

**strict** (pos-restricted concurrency):
The fallback verification mode when `epoch!=curId` (concurrent write detected) — adds `from==startLine-1 && to==endLine-1` to the pos-free checks. Makes `shift==rebind` loud for `S@2->7` isolated `tombstone` case. Cost is one `reject-and-serve` retry with `E.servedRows`. Automatic, no config flag. Retired by ADR-0017: `strictPos` no longer gates anything, because position equality cannot see a deleted identity (`1 === 1`) while an exterior shift moves every coordinate without touching identity; a leased `line_id` resolved through `line_lineage(C)` replaces it.
_Avoid_: always-strict

**canon** (canon_at_serve):
The whitespace-stripped form `line.replace(/[ \t\r\n]+/g,"")` (`ADR-0005`) captured at serve time and persisted parallel to `hashes` in `served.canons`. Used to detect `S@3==S@3` whole-span where `hash==` still passes but `canon` differs → `E_STALE_RANGE`. Alone not enough without `tombstone`.
_Avoid_: content (byte-level, not canon)
