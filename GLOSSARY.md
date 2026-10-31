# Hashline Edit

A hash-anchored file-editing extension for the pi-coding-agent: every line of a file carries a stable 4-char hash derived from (canonical path, line content), and replace operations anchor on hashes, failing closed rather than relocating silently.

## Language

**serve**:
To deliver a line's `HASH│content` row into the model's context through tool output. A default (`served`) read serves the rows it shows; a post-edit diff serves its rows; an error's fresh-anchor feedback serves its rows.
_Avoid_: display, show, echo

**served state**:
The session's active record of leases in `served_leases`, binding presentation anchors to immutable `line_id`s for the snapshot served to the model: `(session_id, file_path, anchor) -> (line_id, served_snapshot_hash, retired_at)` ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)).
_Avoid_: expectation, last read, snapshot

**model–tool boundary**:
The separation of responsibilities: the tool owns verification of what the model submits; the model owns intent. The tool never relies on the model to supply verification data or to perform pre-edit rituals (re-reading) to keep its own checks honest, and never silently rewrites `text` to "fix" the model's intent (e.g. stripping lines that duplicate outside the range). `range = hash_bounds, replacement = text` is pure — no surprise rewrite.
_Avoid_: —

**anchor philosophy**:
The project's core contract: per-line anchors derive from the file's canonical path and the line's content (`canon`: the frozen v3 whitespace class stripped — 28 code points, [ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md) — amending the legacy ASCII-only class), stable for unchanged lines and across whitespace-only formatting, and position-independent; an anchor that cannot be resolved is rejected, never fuzzy-matched or silently relocated. Byte-level detection of non-whitespace changes is unchanged — token-level edits still rotate the anchor ([ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)).

**whitespace class**:
The single frozen code-point set the canon strips from a line before hashing — `CANON_VERSION = 3`, 28 code points (C0 whitespace except U+001C–U+001F, SP, NEL, NBSP, OGHAM SPACE, U+2000–U+200A, U+2028/U+2029, U+202F, U+205F, U+3000, LRM, RLM, BOM), defined once in `src/hashline/hash-identity.ts` ([ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)). Zero-width and joiner characters (ZWSP/ZWNJ/ZWJ), SOFT HYPHEN, WORD JOINER, MONGOLIAN VOWEL SEPARATOR and the C1 controls (except NEL) are significant and survive the canon. The executable per-code-point record is `test/core/canon-v3-disposition.test.ts`; formatter churn against the class is re-measured by `scripts/canon-churn-audit.mjs`.
_Avoid_: whitespace set, trim set (use canon)

**anchor staleness**:
An anchor (one line, `anchor_from` or `anchor_to`) that no longer resolves against the current file because the line's content changed since it was served (`hash`/`canon` miss). Reported as `[E_STALE_ANCHOR]` with the current rows served; the model retries with those rows (no `read` needed).
_Avoid_: boundary staleness (use `anchor` for one line, `served range` for span)

**unknown anchor**:
An anchor this session holds no lease for in any file. Reported as `[E_UNKNOWN_ANCHOR]` with no rows and no served options — the tool cannot tell a wrong file value from wrong anchors from another session, so it states the fact and the model decides. Distinct from `anchor staleness`, which names a served anchor whose content changed.
_Avoid_: unserved anchor, missing anchor, stale anchor

**foreign anchor**:
An anchor this session holds a lease for, but for a file other than the one the edit names. Reported as `[E_FOREIGN_ANCHOR]` with no rows and no served options — the message names where the anchors were served. Distinct from `anchor staleness`, which names a served anchor whose content changed.
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
The condition where the `served range` (span between anchors) cannot be reconciled with served state: interior `served span` vs `current span` mismatch (`hash`/`canon`/`len`), a served interior row whose lease is retired or whose `line_id` moved off its coordinate, a boundary row the mirror never served, or a mirror row a serve truncated away while its lease still lives (issue #151). Reported as `[E_STALE_RANGE]` — retired: `[E_UNSERVED_RANGE]`, see [ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md). An **unread interior** line between two leased boundaries is not staleness and does not fail closed ([ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md)): it carries no identity to verify, and the boundaries plus the window-length gate already pin the span. Every `[E_STALE_RANGE]` does `reject-and-serve`: the current range is served under the exact heading `Current range (fresh read):` with no retry hint and no mandate — the rows prove served state and disk disagree, not that the same anchors are the right retry, so the model decides from them instead of retrying blind ([ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md)).
_Avoid_: range staleness (use `served range` for span)

**never-served**:
A line with no entry in the served record — the model was never served that line. A user-facing diagnosis carried as `details.cause` on the rejection, never a served option (facts are the default; options are the curated exception). It fails closed only where there is no identity left to verify: a **boundary** row of a leased span (one of the two anchors the model named) reports `[E_STALE_RANGE]`; an unplaceable boundary (one bound stale, survivor live and unshifted) reports `[E_UNVERIFIED_RANGE]`; an anchor with no lease at all reports `[E_UNKNOWN_ANCHOR]` (no lease in any file) or `[E_FOREIGN_ANCHOR]` (leased for another file) — both rowless with no options. An **unread interior** row between two leased boundaries is accepted instead, because it carries no identity to verify ([ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md)). `[E_STALE_ANCHOR]` names a served anchor whose identity is dead (rows served, retry with them).

**unverified range**:
The named window served when one bound of the range no longer resolves to the line identity it was served with while the surviving bound is live and unshifted. Reported as `[E_UNVERIFIED_RANGE]`: the rows of the named window are served as a fresh read under the exact heading `Current range (fresh read):`, with no retry hint and no mandate — the model decides from those rows, and the rows are leased through the normal serve seam. One bound stale covers a retired lease with a live unshifted survivor only — a boundary anchor with no served position reports `[E_UNKNOWN_ANCHOR]` or `[E_FOREIGN_ANCHOR]`. Retired: `[E_UNSERVED_RANGE]` (see [ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md); interior hole → `[E_STALE_RANGE]`, boundary producer → this code); the library-seam blocked-hash boundary check that also reported `[E_STALE_ANCHOR]` is retired (#10).
_Avoid_: unverified region (the model-facing word is `range`, never `region`)

**reject-and-serve**:
The staleness policy for a range-matched rejection: reject the edit and return the current range as fresh `HASH│content` rows, which themselves count as serves. The range-family codes (`[E_STALE_RANGE]`, `[E_UNVERIFIED_RANGE]`) serve those rows under `Current range (fresh read):` with no retry hint and no mandate — the model decides from them instead of retrying blind; `[E_STALE_ANCHOR]` keeps the `Current range:` retry hint, because there the rows themselves are the retry. A rejection whose range cannot be identified carries no rows (see `target-lost rejection`).
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
A model-visible signal informative for the human only, emitted in `details`/`warnings` and rendered collapsed in TUI (e.g. drift notice). Not in model content.

**line identity**:
A line's stable identity across the file's materialized versions: the immutable `line_id` allocated for its content, plus its ancestry in `line_lineage`. Identity follows content, not coordinate — an exterior insert or delete shifts line numbers without changing `line_id`, which is exactly what lets an edit rebase silently ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)). Distinct from the 4-char `anchor`, which is a presentation token the model copies out of a served row. Supersedes heuristic healing and legacy position-dependent concurrency (`strictPos` and `pos-free` modes).
_Avoid_: anchor identity, hash identity, epoch, strict pos, pos-free, orphaned serve, orphaning re-serve

**dynamic rebase**:
The transparent realignment of an edit's target anchors to current file coordinates when external modifications have shifted preceding lines, resolved by looking up leased `line_id`s in `line_lineage` ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)).
_Avoid_: fuzzy rebase, coordinate shift

**patience pairing** (`pairSnapshots`):
The four-phase diff alignment algorithm (pins → minimal-Δ LIS backbone → zip → unique-embedding LCS leaf) mapping line lineage between successive file snapshots ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)).
_Avoid_: heuristic pairing, diff guessing

**lease** (served lease):
The `served_leases` row that binds a served anchor to the immutable `line_id` it denotes for the snapshot actually served: `(session_id, file_path, anchor) -> line_id, served_snapshot_hash, retired_at`. `serve` is the only operation that may create one, and it upserts atomically — re-serving an anchor replaces the row (fresh `line_id`, `retired_at = NULL`) instead of failing closed or leaving a stale slot. An edit resolves its lease strictly read-only.
_Avoid_: reservation, lock, epoch

**retirement** (`retired_at`):
Marking a lease terminal: after a snapshot commits, every `served_leases` row whose `line_id` is absent from that snapshot's `line_lineage` gets `retired_at` set. A retired identity is gone until a re-read grants a fresh lease, so a stale anchor rejects `[E_TARGET_LOST]` (no live unshifted survivor) or `[E_UNVERIFIED_RANGE]` (survivor live and unshifted: a fresh read to decide from) instead of silently rebinding. An interior row whose lease is terminal rejects `[E_STALE_RANGE]` with `details.cause: "retirement"` (the leased-span gate), the same diagnosis the boundary rule reports.
_Avoid_: the `blocked hashes` term below (the hash-allocation guard, not a lease state)

**lineage** (`line_lineage`):
The per-snapshot table `line_lineage(snapshot_id, line_number) -> (line_id, canon_hash, anchor)`, written inside `BEGIN IMMEDIATE` for every materialized version held in `file_snapshots`. It is the sole coordinate authority: an edit looks its leased `line_id` up here and either rebases to the new coordinate or fails closed. A batch's commit writes it directly from the in-memory working buffer — surviving lines keep the `line_id` they already carry and only lines the batch created take fresh ids from `line_id_counters` — so re-pairing `S_latest` against the new content (`pairSnapshots`) stays a read-path mechanism, used where there is content to align and no working buffer to consult.
_Avoid_: epoch snapshot, served hash map

**reference read**:
A read that serves no hashes and records no served state — the model consumes the content rather than editing it. `read` with `mode: "verbatim"` is the reference read; it loads skill content (SKILL.md or any file in its directory), config values, and docs. It is not subject to the served path's admission ceiling (`SERVED_MAX_LINES = 200_000` in `src/constants.ts:23`), so a file too large to anchor is still readable verbatim; both modes share the 100MB size guard, which bounds bytes read. Neither mode materializes a file's lines to take a page: a read walks the lines it shows and, when served, assigns each row's anchor in that same walk — so an unbounded read holds the lines it pages as its page, and the only other line array on a read is the snapshot store's lineage write, bounded by the anchor-space ceiling.
_Avoid_: unmanaged read

**mode-as-intent**:
The principle that the payload's `mode` field, not the tool name, selects the model's read contract — `served` (the editing-safe default: hashed, editable) vs `verbatim` (plain, consumable) — so the model always knows what it's getting.
_Avoid_: —

**payload contract**:
The model-facing JSON shape used to state one or more file edits in a single `edit` call: `{ "file": …, "edits": [{ "anchor_from": …, "anchor_to": …, "text" | "text_ref" [, "at"] }, …] }`. Items are flat with no discriminator: exactly one payload per item — `text` (by value) XOR `text_ref` (a `served span` taken by reference, `mode: "copy" | "cut"` required) — and the optional `at` is placement only, defaulting to `"in-place"` when omitted. The file is hoisted to the payload root (see file), and the `edits` array expresses arity — length 1 is a single edit, longer is a batched edit applied atomically to one file. There is no separate batch tool.
_Avoid_: patch language, command language, operation tag (the payload's presence states the intent; no tag field exists)

**edits**:
The payload's array of edit items; its length is the call's arity. The tool name `edit` covers single and batched edits — intent is expressed by arity, not by a separate tool.
_Avoid_: batch_edit (removed tool)

**inclusive anchor range**:
A pair of boundary anchors (`anchor_from`, `anchor_to`) identifying the first and last lines of a model-facing range; both boundaries are included.
_Avoid_: hunk, region

**separator**:
The `│` character dividing a served row into `HASH│content`. The model copies only the 4 chars before it into `anchor_from`/`anchor_to` and never emits it — in `text`, in anchors, or anywhere in the call — except under a `literal declaration`, which asserts the bytes are content.
_Avoid_: pipe, delimiter

**file**:
The top-level payload field naming the text file to edit — a non-empty string, never a directory. It sits above the `edits` array rather than inside each item, so every edit in one call targets the same file. A missing, `null`, empty, or wrapper-only `file` is refused fail-closed at admission with `[E_BAD_PAYLOAD]` naming the field.
_Avoid_: path, optional path

**edit item**:
A named, flat object `{ "anchor_from": …, "anchor_to": …, "text" | "text_ref" [, "at"] }` — one entry inside the payload's `edits` array, the model-facing unit of mutation. Named fields (not positional tuples) so every provider schema accepts them; exactly one payload per item (`text` XOR `text_ref`, both or neither refused). `at` is placement relative to the resolved range — `"in-place"` (default when omitted), `"before"`, `"after"` — and placement is decoupled from payload semantics: the payload's *presence* carries the meaning, so no tag field is needed. The file is not part of the item; it is hoisted to the payload root.
_Avoid_: patch language, tuple, move (retired fused verb for retiring a referenced span — the current word is `cut`)

**DesiredContent** (internal):
The payload union built at the single admission boundary (`normReq`) from each validated wire item — the wire never names it. Arms: `literal` (the `text` content), `reference` (carrying `span` and `mode: "copy" | "cut"`), `empty` (the deletion the wire folds from `text: ""`); the engine switches over it exhaustively (`assertNever`), so a new arm fails `pnpm run typecheck` until handled.
_Avoid_: DesiredText (retired name), hand-written / span reference / none (retired arm words), payload enum (it is a union, not a closed tag)

**served hash echo**:
A candidate line that begins with the exact served anchor and reproduces the served content that anchor was served with, at any position (position-agnostic, content-matched) — tool output mistaken for file content. One such row suffices. Detection is evidence-only — the tool never gates on the shape of a line. Detected before dispatch/write, file stays byte-identical. Not a generic `^[A-Za-z0-9]{4}│` strip.
_Avoid_: hash echo (without served qualification — targets the unqualified condition name), anchor echo; served-qualified identifier (findServedHashEcho) is canonical, surface-qualified one (findEditHashEcho) is not

**literal declaration**:
The caller's explicit assertion, via `mode: "literal"`, that bytes reproducing served rows are intended file content; the sole escape from `E_SUSPICIOUS_TEXT`.
_Avoid_: force, override, bypass

**E_SUSPICIOUS_TEXT**:
Refusal that `text` (for `edit`) copied a `served hash echo` — `[E_SUSPICIOUS_TEXT] Refused write to ${path}: line ${n} begins with the exact ${hash}│ anchor served for this session, path, and line ${servedLine}` or `Refused edit to ${path}: replacement line ${k} begins with the exact ${hash}│ anchor served for this session, path, and line ${servedLine}`. Evidence-only: it fires only when `text` reproduces a row actually served for this session, path, and line, never for the shape of a line — a `HASH│`-shaped line whose anchor was never served is written verbatim. The refusal names the reproduced row's real coordinate, states nothing was written, and carries the literal fragment (`mode: "literal"`) that escapes it. Omit the copied anchors from `text` and retry with the same anchors, or reassert under a `literal declaration`, the sole escape. Nothing was written. Deny, not strip — fail-loud, compensable.
_Avoid_: E_HASH_ECHO (ambiguous), E_SERVED_ECHO (retired name; the refusal is E_SUSPICIOUS_TEXT, see ADR-0019)

**pure edit**:
The invariant that an edit is exactly the resolved range replaced by the exact `text` payload with no boundary-dedup rewrite. Verified by `resolveEdit`/`valEdit → resToSpan → assemble` with no intermediate splice; served-state verification belongs to lease resolution (`resolveLeasedEdit`, `src/hashline/lease-resolve.ts`), not to a content seam.
_Avoid_: smart edit, autocorrection, boundary duplication, dedup, autofix, trimming

**blocked hashes**:
The per-session set of 4-character hashes freed by mutations since the last full `read`. Allocation (`HashIdentity`) treats `used = bitset(oldHashes) ∪ bitset(blockedHashes)` so a freed anchor never re-binds for the session prior to a full re-read ([ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)).
_Avoid_: blocked, reserved, tombstone

**canon digest**:
`String(xxh32(canon(line)))` — the opaque canon identity `line_lineage.canon_hash` and `served_leases.canon_hash` store and compare, produced by the single `canonDigest` definition in `src/hashline/hash-identity.ts` ([ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)). Canon evidence is always a digest: the hash-allocation lineage writer, the served-row evidence scans (`findServedHashEcho`, `findServedPrefixMismatches`), and the drift rotated-survivor check all compare digests derived on demand from the lease that carries them, so raw canon line text is never persisted.

**epoch**:
The demoted per-(session, path) `served.snapshot_id` stamp, still persisted in the served mirror and exposed as `loadEpochId`, but superseded by CAS `file_snapshots` and `line_lineage` ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)). The edit pipeline never populates an epoch, and it is never consulted for verification or coordinates; concurrency and coordinate realignment are owned by leased `line_id` resolution.
_Avoid_: version, snapshot (global last-writer-wins `file_snapshots` table is file-level, not per-session)

**stat identity** (`stat_key`):
The `stat(2)` version stamp a served read observes and stamps on the snapshot row it materializes: `ino:size:mtimeMs:ctimeMs`, stored in `file_snapshots.stat_key`. A later read whose stamp matches adopts that snapshot without re-deriving every line; it resolves only its page's lineage and verifies each line's `canon_hash` before serving its anchor, falling back to the content-hash path on any mismatch ([ADR-0001](docs/adr/0001-content-addressed-line-identity-cas-mvcc.md)). `ctime` is the version witness because userspace can restore `mtime` but cannot set `ctime`. Distinct from the `epoch`, which is the per-session read snapshot; a stat key is store state, not session state.
_Avoid_: mtime check, file fingerprint (the content checksum is the fingerprint; the stat key names the version, not the bytes)

**canon** (canon_at_serve):
The whitespace-stripped form `line.replace(CANON_RE, "")` where `CANON_RE` is the frozen 28-code-point whitespace class (see `whitespace class` and [ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)), used to detect `S@3==S@3` whole-span where `hash==` still passes but `canon` differs → `E_STALE_RANGE`. Alone not enough without the `blocked hashes` whole-span signal (retired from verification with the mirror seam, #10; the set lives on as the hash-allocation guard). A canon is **file-scoped**: a 4-char anchor is unique only inside one file's allocation, so it travels with the anchor's lease and there is no process-wide hash→canon lookup ([ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)). Canon evidence is compared as a **canon digest** — `String(xxh32(canon(line)))`, exactly the value `line_lineage.canon_hash` / `served_leases.canon_hash` persist — so no canon text is stored: `served.canons` is written by no v7 code path and survives only as a legacy v6 storage shell (issue #151). An absent digest is absent evidence, so an evidence scan stays silent rather than refusing on the shape of a line.
_Avoid_: content (byte-level, not canon)

**E_LARGE_FILE**:
Refusal that the file exceeds the hashline size contract — more than 200,000 lines on the served read/edit load path (`limitKind: "lines"`, served admission budget `SERVED_MAX_LINES`: the paged walk still retains one anchor per hashed line even for an unshown window — `walkLines` visits every line, `walkPage` assigns one anchor per visit — at ~6.1 MB of walked anchors plus the ~7.0 MB spelling-memo entry overhead over the same strings (`HASH_CACHE_MAX_ENTRIES`) plus the fixed ~1.76 MB allocator bitset, so 200,000 lines cost ~14.9 MB marginal worst case over the loaded text against the ~15 MB target (probe: `node --expose-gc scripts/measure-served-budget.mjs`); reporting the count when it is known; a `mode: "verbatim"` read is not capped), or hash-anchor space exhausted during allocation (`limitKind: "hash-space"`, the 14,766,336-line ceiling for allocatable 4-char anchors — 62^4 minus the 10,000 reserved all-digit spellings, carrying no line count; live width record [ADR-0002](docs/adr/0002-tokenizer-stable-4-character-anchors-canon-v3.md)). The streaming gate reports a lower bound ("more than N lines") — its count is trip-instant, not a total; the preloaded gate counts the materialized text and reports the exact line count. Nothing was written; use `write` or a non-line-based approach for very large files.
_Avoid_: E_TOO_BIG (unclaimed code)

**E_UNKNOWN**:
The unexpected-error envelope: a throw that is not a `DomainError` (an invariant breach, a filesystem or store failure) is reported through the registry as `[MODEL] [E_UNKNOWN]` carrying only the error name and the first message line — never a scraped bracket token, never the verbatim dump. Serves no options by rule: no cause is knowable at all.
_Avoid_: E_UNSPECIFIED (unclaimed code)

**applied warning** (`W_*`):
The applied-path diagnostic tier: a `[W_*]` line reports a mutation that was applied, carrying the audience that owns it — `[MODEL]` lines are informational (the bytes were written, so no retry is needed) and `[USER]` lines render dimmed for the human. An `[E_*]` line reports a rejection; an applied mutation never emits one. The seven codes are `W_NEVER_SERVED_SHAPE`, `W_SERVED_PREFIX_MISMATCH`, and `W_NOOP_INSERT` (`MODEL`), plus `W_REVERSED_ANCHORS`, `W_UNICODE_LITERAL`, `W_LITERAL_BYPASS`, and `W_NOOP` (`USER`).
_Avoid_: E-tier code on a success; No action is required (retired sentinel, redundant with the tier)

**reversed anchors**:
An `anchor_from`/`anchor_to` pair whose resolved lines run opposite the slot order. Anchors carry no order, so reversal is a property of the resolved lines of the slot pair — never of the anchor strings. The tool heals the swapped pair and narrates `[USER] [W_REVERSED_ANCHORS]`; the retired refusal name must not be reused.
_Avoid_: E_REVERSED_ANCHORS (retired refusal; the healed notice is W_REVERSED_ANCHORS)

**noop**:
A call whose resolved range already contains the replacement text: nothing changed, so it is not a failure. The first no-op proceeds, the second identical no-op narrates `[USER] [W_NOOP]`, and only the third identical resend refuses as `[E_NOOP_LOOP]` (`NOOP_LOOP_THRESHOLD = 3`, `src/noop-guard.ts:103-148`).
_Avoid_: E_NOOP (no such code; the warn arm is W_NOOP, the refuse arm is E_NOOP_LOOP)

**remediation options**:
Refusals state facts. A served `Options:` list is the exception: two or more neutral, non-destructive moves that keep the model's choice, rendered only by the refusal that proved the cause and only for `MODEL` audience. Never a single directive, never prompt prose, never a success path. Curated: `E_SUSPICIOUS_TEXT`, `E_BATCH_ABORT`, `E_UNDO_UNAVAILABLE` ([ADR-0004](docs/adr/0004-model-tool-boundary-and-error-protocol.md)).
_Avoid_: remedy, suggestion, hint (one directive biases the next call)

**source of truth**:
The file bytes on disk plus the lease store (`served_leases`, snapshots, `line_lineage`) — the sole authority for retry coordinates. Rendered diff text is never the source of truth; coordinates resolve through leases, never by re-reading a projection.
_Avoid_: machine diff (a projection, not the table)

**projection**:
The single shared rendered diff — preview, applied, and human display render the same text with different context params — derived from the source of truth under a stated collapse contract. Informational only: hidden spans come in two kinds, each with a unified counted marker whose count equals its hidden span — untouched-span (middle gap; ` ... [N lines untouched] ...`, both cursors advance so following anchors stay at their true positions; hidden rows are addressable only through the leases the carrying serve grants) and deleted-span (removed run; ` - ... [N lines deleted] ...`, the count drives the old-side cursor); added spans are never hidden (the collapse invariant). The model path never consumes projection text as coordinate input.
_Avoid_: view (unqualified — name the audience), second diff (there is only one rendering), middle-gap marker (think spans, not gaps)

**pure view**:
A bash chain whose whole stdout is provably exactly one file's viewed lines: one `view` span (single-file `cat`/`head`/`tail`/`sed -n`/`nl` numeric print, or a sanctioned `cat |` line-filter pipeline) with every other `&&` segment (or every preceding `;` statement) `silent` ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)). Only a pure view is eligible for view replacement.
_Avoid_: safe command (safety is per-span-kind, never whole-command)

**slice view**:
A pure view naming a strict sub-range of the file (`head`/`tail` counts, `sed -n` print addresses, pipeline compositions). Served slice-accurately: exactly the computed intervals are previewed and leased, never the whole file ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)).
_Avoid_: partial read (a read concept; this is a bash classification)

**pass-through (bash view)**:
A bash result the hook returns byte-unmodified: not a pure view, or a view with any `unsafe` segment, or any guard failure (error, truncation, non-text). The fail-closed default — worst case is the status quo.
_Avoid_: skip (says nothing about what the model receives)

**silent segment**:
A segment in an `&&` chain (or preceding an unconditional `;` statement) provably emitting no stdout on success and not touching the viewed file. v1 set: `cd <literal-path>` (never `-`), `true`, `:` — closed by corpus census ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)), extensible only by audit.
_Avoid_: harmless command (harmlessness is unproven; silence is proven)

**span kind**:
The per-segment classification `silent` | `view` | `unsafe`. Unknown is `unsafe` — the kind system fails closed by default, so a new command shape is pass-through until audited, never intercepted until proven.
_Avoid_: risk level (this is a proof obligation, not a score)

**view replacement**:
The full-content swap of a pure view's tool result for the anchored slice preview under the page header `[Bash view: <file> (<N> lines total | lines A-B of <N> total)]`: zero duplication (unlike the write path's append), leases bound to the canonical disk re-read, never to bash stdout ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)).
_Avoid_: auto-read (the write-path append; this is a swap, not an addition)

**interval algebra**:
The exact line-set composition for pipeline slices: surviving source lines as ordered disjoint 1-indexed intervals over `[1..L]`, each filter stage (`head`/`tail` counts, `sed -n` addresses) mapping intervals to intervals by pure arithmetic — no content consulted, nothing estimated ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)).
_Avoid_: range math (intervals are sets; ranges are model-facing spans)

**transparent wrapper**:
A command prefix (`rtk`) that forwards a view command's bytes unchanged. Accepted in source positions only and unwrapped to the inner view shape — but never trusted: the stdout-verification gate (D9) re-checks every replacement against the observed bytes, so transparency is proven per call, not assumed per tool ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)).
_Avoid_: silent segment (silence is proven no-output; transparency is proven byte-identity)

**atomic view block**:
An individual statement or pipeline in a compound bash command evaluated for view or search interception.
_Avoid_: sub-command (ambiguous with subshell or git subcommand)

**sequential peeling**:
Deterministically verifying and slicing each statement's output left-to-right from a combined bash stdout stream.
_Avoid_: stream splitting, stdout demuxing

**static glue segment**:
A non-view statement emitting statically predictable output (e.g. literal quoted prints via `printf`) that can be cleanly peeled from the combined stdout stream.
_Avoid_: print segment (ambiguous with dynamic prints)

**redundant cd**:
A `cd` statement resolving to the active `effCwd`, treated as an inert silent no-op.
_Avoid_: duplicate cd, unnecessary cd

**canonical payload**:
The single argument shape a tool accepts from the model — for `read`, `{ file, windows?, mode? }` ([ADR-0003](docs/adr/0003-tool-payload-contracts-read-and-edit.md)). Caps, window resolution and row serving see only this shape.
_Avoid_: primary shape, new format

**render projection**:
The pure mapping from a tool's argument payload onto the shape pi's builtin renderer consumes, used only for TUI presentation. It never mutates the payload and never changes what is served to the model.
_Avoid_: display mapping, path fixup, view model

**legacy shape**:
An argument shape a tool no longer accepts but which survives in already-recorded transcripts. Rendering tolerates it; the schema rejects it.
_Avoid_: deprecated shape, backward compatibility, old format

**two roots**:
The physical separation between human-editable extension configuration (`settingsRoot`/`settings.json` under `~/.pi/agent/extensions/pi-better-edit/`) and internal MVCC SQLite state (`stateRoot`/`hash-store.sqlite` under `$XDG_STATE_HOME/pi-better-edit/`) ([ADR-0005](docs/adr/0005-store-janitor-two-root-lifecycle.md)).
_Avoid_: single-root config, shared config directory

**store janitor**:
The event-driven background SQLite maintenance runner invoked on `session_start` and `session_shutdown`, applying hard 7-day lease TTL deletion and conditional autocommit `VACUUM` ([ADR-0005](docs/adr/0005-store-janitor-two-root-lifecycle.md)).
_Avoid_: store worker, background daemon

**stdout byte gate**:
The fail-closed verification barrier in Bash view interception ensuring raw captured command stdout byte-matches the re-read disk slice before replacing tool output with anchored rows ([ADR-0006](docs/adr/0006-ast-guarded-bash-view-interception.md)).
_Avoid_: parser trust, unverified preview
