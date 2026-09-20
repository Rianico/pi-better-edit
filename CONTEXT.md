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
An anchor (one line, `anchor_from` or `anchor_to`) that no longer resolves against the current file because the line's content changed since it was served (`hash`/`canon`/`tombstone` miss). Reported as `[E_STALE_ANCHOR]` with the current rows served; the model retries with those rows (no `read` needed).
_Avoid_: boundary staleness (use `anchor` for one line, `served range` for span)

**unknown anchor**:
An anchor this session holds no lease for in any file. Reported as `[E_UNKNOWN_ANCHOR]` with no rows and no remedy — the tool cannot tell a wrong file value from wrong anchors from another session, so it states the fact and the model decides. Distinct from `anchor staleness`, which names a served anchor whose content changed.
_Avoid_: unserved anchor, missing anchor, stale anchor

**foreign anchor**:
An anchor this session holds a lease for, but for a file other than the one the edit names. Reported as `[E_FOREIGN_ANCHOR]` with no rows and no remedy — the message names where the anchors were served. Distinct from `anchor staleness`, which names a served anchor whose content changed.
_Avoid_: cross-file anchor, wrong-file anchor, leaked anchor

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
The condition where the `served range` (span between anchors) cannot be reconciled with served state: interior `served span` vs `current span` mismatch (`hash`/`canon`/`tombstone`/`len`). Reported as `[E_STALE_RANGE]` — for a changed span, or for a never-served interior (interior loop miss: a line strictly between the anchors has no served entry; the remedy is identical — retry with the served rows — so no separate code is kept; retired: `[E_UNSERVED_RANGE]`, see ADR-0020). Every `[E_STALE_RANGE]` does `reject-and-serve`: the retry needs no `read`.
_Avoid_: range staleness (use `served range` for span)

**never-served**:
A line with no entry in the served record — the model was never served that line. A user-facing diagnosis carried as `details.cause` on the rejection, never the model remedy (the code alone selects the retry): a never-served interior reports `[E_STALE_RANGE]` (retry with the served rows, no `read` needed); an unplaceable boundary (one bound stale, survivor live and unshifted) reports `[E_UNVERIFIED_RANGE]` (decide from the fresh read); an anchor with no lease at all reports `[E_UNKNOWN_ANCHOR]` (no lease in any file) or `[E_FOREIGN_ANCHOR]` (leased for another file) — both rowless without remedy. `[E_STALE_ANCHOR]` names a served anchor whose identity is dead (rows served, retry with them).

**unverified range**:
The named window served when one bound of the range no longer resolves to the line identity it was served with while the surviving bound is live and unshifted. Reported as `[E_UNVERIFIED_RANGE]`: the rows of the named window are served as a fresh read under the exact heading `Current range (fresh read):`, with no retry hint and no mandate — the model decides from those rows, and the rows are leased through the normal serve seam. One bound stale covers a retired lease with a live unshifted survivor only — a tombstoned boundary reports `[E_STALE_ANCHOR]`, and a boundary anchor with no served position reports `[E_UNKNOWN_ANCHOR]` or `[E_FOREIGN_ANCHOR]`. Retired: `[E_UNSERVED_RANGE]` (see ADR-0020; interior hole → `[E_STALE_RANGE]`, boundary producer → this code).
_Avoid_: unverified region (the model-facing word is `range`, never `region`)

**reject-and-serve**:
The staleness policy for a range-matched rejection: reject the edit and return the current range as fresh `HASH│content` rows, which themselves count as serves, so the interior retry needs no read. An `[E_UNVERIFIED_RANGE]` fresh read is leased the same way but carries no retry hint — the model decides from those rows instead of retrying blind. A rejection whose range cannot be identified carries no rows (see `target-lost rejection`).
_Avoid_: reject-then-reread (the retry must not require a read)

**target-lost rejection**:
A rejection whose range cannot be identified, so its payload carries no rows and recovery is a re-read. Reported as `[E_TARGET_LOST]` for a retired leased identity with no live unshifted bound (deleted target, shifted neighbour, re-added text elsewhere, collapsed window). Disjoint from the row-carrying codes by payload shape: `[E_STALE_RANGE]` and `[E_UNVERIFIED_RANGE]` always render rows, `[E_STALE_ANCHOR]` renders rows when the window is identifiable (the missing-previous-hashes producer in `src/mutation-engine/pipeline.ts:368-373` carries the headline only), `[E_TARGET_LOST]` never does.
_Avoid_: context serve (no such operation exists)

**drift**:
The divergence between the served state and the current file: lines the model was shown whose content has changed on disk since they were served. Detected by comparing served hashes against current hashes.
_Avoid_: modification, external change (the tool cannot know the source)

**drift notice**:
The informational section appended to a replace result (applied or noop, not undo) when drift lies in served territory outside the replacement range: the current content of the drifted lines, capped, with rows counting as serves. Fires once per drift episode — already-reported drift shrinks to a one-line pointer until a read re-serves the lines. Classified as a user-facing signal (details only, not model content).
_Avoid_: warning (the operation succeeded; it is information, not a warning)

**model-facing signal**:
A model-visible signal the tool must include in `content` for correctness (e.g. `anchor staleness`, `served-range staleness`, `E_STALE_*`/`E_UNVERIFIED_RANGE`, `E_SUSPICIOUS_TEXT`). The model needs it to retry correctly.

**user-facing signal**:
A model-visible signal informative for the human only, emitted in `details`/`warnings` and rendered collapsed in TUI (e.g. drift notice, Batch drift note). Not in model content.

**orphaned serve**:
An entry in served state whose hash no longer matches the current file at that position — the mirror retained a hash that the file has moved or removed elsewhere. Contrast with never-served. An orphan is drift, but at a single position rather than a range. Superseded by ADR-0016: an anchor with no lease now rejects fail-closed (`[E_STALE_ANCHOR]`) and a retired `line_id` rejects `[E_UNVERIFIED_RANGE]` (live unshifted survivor) or `[E_TARGET_LOST]` (otherwise), rather than being healed onto a twin.
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
Marking a lease terminal: after a snapshot commits, every `served_leases` row whose `line_id` is absent from that snapshot's `line_lineage` gets `retired_at` set. A retired identity is gone until a re-read grants a fresh lease, so a stale anchor rejects `[E_TARGET_LOST]` (no live unshifted survivor) or `[E_UNVERIFIED_RANGE]` (survivor live and unshifted: a fresh read to decide from) instead of silently rebinding.
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
The `│` character dividing a served row into `HASH│content`. The model copies only the 3 chars before it into `anchor_from`/`anchor_to` and never emits it — in `replace_with`, in anchors, or anywhere in the call — except under a `literal declaration`, which asserts the bytes are content.
_Avoid_: pipe, delimiter

**file**:
The top-level payload field naming the text file to edit — a non-empty string, never a directory. It sits above the `edits` array rather than inside each item, so every edit in one call targets the same file. A legacy `null` file is still folded in code but rejected fail-closed with `[E_BAD_PAYLOAD]`.
_Avoid_: path, optional path

**edit item**:
A named object `{ "anchor_from": …, "anchor_to": …, "replace_with": … }` — one entry inside the payload's `edits` array, the model-facing unit of mutation. Named fields (not positional tuples) so every provider schema accepts them. The file is not part of the item; it is hoisted to the payload root.
_Avoid_: patch language, tuple

**served hash echo**:
A candidate line that begins with the exact served anchor and reproduces the served content that anchor was served with, at any position (position-agnostic, content-matched) — tool output mistaken for file content. One such row suffices. Detection is evidence-only — the tool never gates on the shape of a line. Detected before dispatch/write, file stays byte-identical. Not a generic `^[A-Za-z0-9]{3}│` strip.
_Avoid_: hash echo (without served qualification — targets the unqualified condition name), anchor echo; served-qualified identifier (findServedHashEcho) is canonical, surface-qualified one (findEditHashEcho) is not

**literal declaration**:
The caller's explicit assertion, via `mode: "literal"`, that bytes reproducing served rows are intended file content; the sole escape from `E_SUSPICIOUS_TEXT`.
_Avoid_: force, override, bypass

**E_SUSPICIOUS_TEXT**:
Refusal that `replace_with` (for `edit`) copied a `served hash echo` — `[E_SUSPICIOUS_TEXT] Refused write to ${path}: line ${n} begins with the exact ${hash}│ anchor served for this session, path, and line ${servedLine}` or `Refused edit to ${path}: replacement line ${k} begins with the exact ${hash}│ anchor served for this session, path, and line ${servedLine}`. Evidence-only: it fires only when `replace_with` reproduces a row actually served for this session, path, and line, never for the shape of a line — a `HASH│`-shaped line whose anchor was never served is written verbatim. The refusal names the reproduced row's real coordinate, states nothing was written, and carries the literal fragment (`mode: "literal"`) that escapes it. Omit the copied anchors from `replace_with` and retry with the same anchors, or reassert under a `literal declaration`, the sole escape. Nothing was written. Deny, not strip — fail-loud, compensable.
_Avoid_: E_HASH_ECHO (ambiguous), E_SERVED_ECHO (retired name; the refusal is E_SUSPICIOUS_TEXT, see ADR-0019)

**boundary duplication** (historical — removed):
Former auto-fix that silently stripped replacement lines duplicating lines outside the range (`trailingDups`/`leadingDups` with byte `===`, and `firstNewAfterDups`/`lastNewBeforeDups` with `canon()`+`sectionIsUnique`). Removed as a fix: the tool is now pure `range = hash_bounds, replacement = replace_with`. A true duplicate stays loud in the post-edit diff/drift signal for the model to fix next turn; silent removal is irreversible (brace-balance loss). No new error code — the duplicate is preserved verbatim.
_Avoid_: dedup, autofix, trimming

**pure edit**:
The invariant that an edit is exactly the resolved range replaced by the exact `replace_with` with no boundary-dedup rewrite. Verified by `valEdit → verifyServed → resToSpan` with no intermediate splice.
_Avoid_: smart edit, autocorrection

**tombstone**:
The per-session (`sessionKey`, `path`) set of hashes freed since the last full `read` — `served.retired` in `src/served-session/session.ts:804-815`. Allocation (`HashIdentity`) treats `used = bitset(oldHashes) ∪ bitset(tombstone)` so a freed anchor never re-binds for the session (`src/hashline/hash-identity.ts:202-209`, `:348-349`, plumbed via `src/hashline/hash.ts:105-134`). ADR-0017 retains it only as the hash-allocation guard, never as a second identity authority — and the verification job below is a signal, not a lease state, so the `retirement` (`retired_at`) term above still owns lease-terminal state. Its second live job is the verification signal: `src/hashline/served-verification.ts:454-471` rejects a tombstoned boundary hash as `[E_STALE_ANCHOR]` via `throwStaleForTombstone` (`:749-765`, rows served with the retry hint, `details.cause: "tombstone"`), and `:520-544` rejects a tombstoned interior as `[E_STALE_RANGE]` (retry with the served rows, same cause). ADR-0020 decision 2 prescribed the fresh-read heading for the boundary check; as-built `0bc2b65` serves `[E_STALE_ANCHOR]` rows instead (see ADR-0021 decision 3). Cleared on `full read` (`isFullRead`), kept on `partial`/`truncated`, pruned with `served` via `SERVED_TTL_MS`. Prevents `S@3 reborn @3` whole-span stale success.
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

**E_LARGE_FILE**:
Refusal that the file exceeds the hashline size contract — more than `maxLines` lines on the read/edit load path (`limitKind: "lines"`, reporting the counted lines), or hash-anchor space exhausted during allocation (`limitKind: "hash-space"`, the 238,328-line ceiling for 3-char anchors, carrying no line count). Nothing was written; use `write` or a non-line-based approach for very large files.
_Avoid_: E_TOO_BIG (unclaimed code)

**E_UNKNOWN**:
The unexpected-error envelope: a throw that is not a `DomainError` (an invariant breach, a filesystem or store failure) is reported through the registry as `[MODEL] [E_UNKNOWN]` carrying only the error name and the first message line — never a scraped bracket token, never the verbatim dump. Carries no remedy by rule: no cause is knowable at all.
_Avoid_: E_UNSPECIFIED (unclaimed code)

**applied warning** (`W_*`):
The applied-path diagnostic tier: a `[W_*]` line reports a mutation that was applied, carrying the audience that owns it — `[MODEL]` lines are informational (the bytes were written, so no retry is needed) and `[USER]` lines render dimmed for the human. An `[E_*]` line reports a rejection; an applied mutation never emits one. The six codes are `W_NEVER_SERVED_SHAPE` and `W_SERVED_PREFIX_MISMATCH` (`MODEL`), plus `W_REVERSED_ANCHORS`, `W_UNICODE_LITERAL`, `W_LITERAL_BYPASS`, and `W_NOOP` (`USER`).
_Avoid_: E-tier code on a success; No action is required (retired sentinel, redundant with the tier)

**reversed anchors**:
An `anchor_from`/`anchor_to` pair whose resolved lines run opposite the slot order. Anchors carry no order, so reversal is a property of the resolved lines of the slot pair — never of the anchor strings. The tool heals the swapped pair and narrates `[USER] [W_REVERSED_ANCHORS]`; the retired refusal name must not be reused.
_Avoid_: E_REVERSED_ANCHORS (retired refusal; the healed notice is W_REVERSED_ANCHORS)

**noop**:
A call whose resolved range already contains the replacement text: nothing changed, so it is not a failure. The first no-op proceeds, the second identical no-op narrates `[USER] [W_NOOP]`, and only the third identical resend refuses as `[E_NOOP_LOOP]` (`NOOP_LOOP_THRESHOLD = 3`, `src/noop-guard.ts:59-99`).
_Avoid_: E_NOOP (no such code; the warn arm is W_NOOP, the refuse arm is E_NOOP_LOOP)

**remedy-eligibility**:
Payload text reports facts; a remedy clause may appear only when it is helpful, unharmful and fail-closed AND the evidence pins a single cause. When the intent is ambiguous the payload states the fact and carries no remedy, because an intent-guessing suggestion steers the model's next action. Remedy-free by rule: `E_UNKNOWN`, `E_UNKNOWN_ANCHOR`, `E_FOREIGN_ANCHOR`, `E_UNVERIFIED_RANGE`, `E_NOOP_LOOP` (see ADR-0021 decisions 4 and 5).
_Avoid_: suggestion (an intent-guessing remedy steers the model's next action)
