# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored line-replacing workflow. Strict semantics, no silent relocation, no autocorrection, no fuzzy fallback. Every line gets a unique content hash, so edits stay precise and stale anchors are caught before they reach the file.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW. The strict-semantics policy is unchanged. This fork extends the upstream design with 3-character hashes and collision resolution for unique per-line anchors.

Every line returned by `read` carries a short content hash. Edits reference those hashes instead of raw text, so the tool can detect stale context and reject outdated changes before they reach the file.

## Why fork?

The original uses 2-character hashes of a 16-character alphabet, with the hash being a pure function of line content. That's 8 bits / 256 buckets, and two byte-identical lines (e.g. repeated `import` statements, repeated `}`) always share a hash because the hash is `xxHash32(content)`.

This fork makes two changes that compound:

1. **3-character hash length** over a 64-char URL-safe base64 alphabet (up from 2 characters in the upstream), expanding the hash space from 256 to 262,144 buckets.
2. **Perfect hashing (collision resolution).** When computing hashes for a file, if a line's base hash collides with an already-assigned hash, the next available hash is assigned from a bitset (32KB, 262,144 bits) using a hint cursor for O(1) amortized lookup. This ensures every line gets a unique anchor, even within a 3-character hash space. Two byte-identical lines (e.g. repeated `}` or repeated `import` statements) get different hashes automatically.

## Installation

From npm:

```bash
pi install npm:pi-hashline-edit-pro
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## How It Works

### `read` -- tagged line output

Text files are returned with a `HASH│content` prefix on every line. The line number is not part of the wire format, only the 3-character hash followed by the `│` separator and the line content. Example output for the source below:

```js
function hello() {
  console.log("world");
}
```

would be returned as:

```text
0qH│function hello() {
szJ│  console.log("world");
_zl│}
```

- `HASH` is a 3-character content hash from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3`). See [Hashing](#hashing) for details.

Optional parameters:

- `offset` -- start reading from this line number (1-indexed).
- `limit` -- maximum number of lines to return.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments and do not participate in the hashline protocol. Binary and directory paths are rejected with a descriptive error. Empty files are returned as a single empty-line hash (`HASH│`). Use replace on that hash to insert content.

### `replace` -- hash-anchored modifications

Replaces using the `HASH│content` anchors from `read` output to target lines precisely. Two modes are available, toggled via `/toggle-replace-mode` (persists across sessions):

**Bulk mode (default):** `hash_range_inclusive` and `content_lines` go inside a `changes` array, supporting multiple edits in one call.

```json
{
  "changes": [
    { "content_lines": ["  console.log('hashline');"], "hash_range_inclusive": ["ve7", "ve7"] }
  ],
  "path": "src/main.ts"
}
```

**Flat mode:** `hash_range_inclusive` and `content_lines` sit at the top level. Only one edit per call.

```json
{
  "content_lines": ["  console.log('hashline');"],
  "hash_range_inclusive": ["ve7", "ve7"],
  "path": "src/main.ts"
}
```

| Field | Description |
| --- | --- |
| `hash_range_inclusive` | Inclusive line range `[start_hash, end_hash]` (required). |
| `content_lines` | Literal replacement content, one string per line (use `[]` to delete the range). |

- **Request structure validation.** The request envelope (`path`, `changes` in bulk mode; `path`, `hash_range_inclusive`, `content_lines` in flat mode) and individual edit items are validated before any file I/O. Unknown fields, missing required fields, invalid types, and malformed anchors are rejected with `[E_BAD_SHAPE]` or `[E_BAD_REF]`.
- **Legacy dialect rejected.** The native top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect is rejected with `[E_LEGACY_SHAPE]`. The error message tells the model to call `read` first and send `{content_lines: [...], hash_range_inclusive: ["<START>", "<END>"]}`.
- **Batched atomicity (bulk mode).** All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so the hashes from a single `read` call remain valid across all edits in the batch.

### Stable hashing across edits

Hashes are now computed with a persistent store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) that preserves hashes for unchanged lines across edits. When you replace lines in a file, the runtime maps the old content against the new content and copies hashes for unchanged lines to their new positions. This means editing one part of a file does not change the hashes of unrelated lines elsewhere — the model can keep using previously seen anchors for untouched regions. A replace that produces identical content (a no-op, reported as "No changes made") never rotates hashes: no file change means no anchor change, so previously read anchors remain valid after a no-op.

Two guarantees make the mapping safe for duplicated content:

- **An edited range never borrows a hash from a line outside it.** Lines outside the replaced range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range. Previously, identical text in a replacement could "steal" the nearest sibling line's hash, silently relocating an anchor the model was still holding.
- **Re-inserted identical text keeps its hash.** When replacement content matches a line that was just removed, the removed line's hash is reused for it (same canonical content, same meaning). Previously this was a coin flip: the hash was retired and a fresh one assigned, so "replace X with X" rotated the anchor even though nothing changed.

The store is a SQLite database (WAL journal mode) keyed by canonical file path. Each snapshot stores a 64-bit content checksum (`xxhash64`) plus the per-line hashes, not the full text, so a cache hit is a single keyed lookup and a one-row write. Reads, replaces, undo, and pruning all share one transactional store, so concurrent Pi sessions editing different files never silently clobber each other's snapshots (per-path writers serialize via `BEGIN IMMEDIATE`; same-path concurrent edits still fail safe — stale anchors are rejected by content matching). Stale snapshots (for files that no longer exist) are pruned on session start.

On first run after upgrading, a one-time migration imports the previous `hash-store.json` into the database and renames the old file to `hash-store.json.bak`; the old JSON store is otherwise discarded.

### Chained edits

After a successful replace, the response confirms with `Successfully replaced in {path}. Added X line(s), removed Y line(s).` (warnings are still shown if present). When auto-read is enabled, fresh anchors are appended automatically. Otherwise call `read` to get fresh anchors for follow-up edits.
### Auto-read after write, replace, and undo

Auto-read is **disabled by default**. When enabled, after a successful `write`, `replace`, or `undo_last_replace` the extension automatically reads the file and appends a `--- Auto-read (hashline anchors) ---` block to the result. This gives the model immediate `HASH│content` anchors for the file without requiring a separate `read` call. The workflow becomes:

1. `write` a file, result includes hashline anchors
2. `replace` using those anchors directly

Toggle at runtime with the `/toggle-auto-read` command. The setting persists across sessions in the config file (`~/.config/pi-hashline-edit-pro/config.json`). Set `PI_HASHLINE_AUTO_READ=1` to enable by default on first run.

After a `replace` or `undo_last_replace`, the block is limited to the changed span plus 2 lines of context above and below it. Because the persistent hash store keeps anchors for unchanged lines stable across edits, the model's previously read anchors for the rest of the file remain valid — only the edited region needs fresh anchors. `write` dumps from the top of the file, since the model has no prior anchors for that state.

For `write` on files over 2000 lines, the dump from the top is truncated with a pagination hint — use `read` with `offset` to see more. `replace` and `undo_last_replace` windows are small by construction (the changed span plus context), so they are not truncated except when the changed span itself exceeds 2000 lines.

### Undo

`undo_last_replace` reverts the most recent successful `replace` on a file, restoring the exact previous content (BOM and line endings included) and the previous hash anchors. It is meant for immediate recovery from a bad edit:

- Undo history is per-file and single-level: each successful `replace` replaces the previous undo entry, so only the most recent edit can be reverted.
- Undo history is in-memory and is lost when the session ends or the extension reloads.
- A successful `write` clears the undo history for that file — the write becomes the new source of truth, and reverting past it would be ambiguous.
- After an undo, the hash-store snapshot is restored to match the reverted content, so anchors read from the previous state are valid again.
- Call `read` after an undo to get fresh anchors for follow-up edits.

### Diff for the host

The post-edit diff (with `+`/`-` markers) is exposed to the host UI via `details.diff`. It is intentionally not in the LLM-visible text. The model already knows what it changed and can call `read` for fresh anchors when needed.

### Commands

| Command | Description |
| --- | --- |
| `/toggle-replace-mode` | Switch between bulk mode (`changes` array) and flat mode (top-level fields). Persists across sessions. |
| `/toggle-auto-read` | Toggle automatic hashline anchors after write and replace operations. Persists across sessions. |

### Config file

Settings are stored in `~/.config/pi-hashline-edit-pro/config.json`:

```json
{
  "replaceMode": "bulk",
  "autoRead": false
}
```

The file is created automatically when any setting is toggled. Both fields are independent — toggling one never clobbers the other.

### Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields. |
| `[E_BAD_REF]` | An anchor in `hash_range_inclusive` is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | `content_lines` contains diff-preview rows (`+HASH│`, `-HASH│`, `-   │`, `-N   `). |
| `[E_BARE_HASH_PREFIX]` | A `content_lines` entry starts with a hash-like `HASH│` prefix. |
| `[E_LEGACY_SHAPE]` | The request uses the unsupported `oldText`/`newText` dialect. |
| `[E_BAD_OP]` | Range start line is after range end line. |
| `[E_EDIT_CONFLICT]` | Two edits in one batch overlap the same original lines. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 262,144-line hashline limit. |

## Design Decisions

- **Stale anchors fail (per-line).** A hash mismatch means that specific line's content changed since the last `read`; the error tells the model to call `read()` to get fresh anchors, then copy the 3-character HASH of the start and end of the range being replaced into `hash_range_inclusive` of the next replace call. When a range has one stale and one still-valid anchor, the error also shows the current lines (with fresh hashes) around the resolved anchor, so the model can re-locate the range without a full re-read. Because staleness is per-line, editing or appending lines does **not** invalidate anchors for lines whose content is unchanged — anchors for untouched regions stay valid across edits to other regions.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Strict patch content.** If `content_lines` contains diff-preview rows — `+HASH│` addition prefixes, `-HASH│` or `-   │` deletion rows (the padded format the diff preview emits), or `-N   ` numbered deletion rows — the edit is rejected with `[E_INVALID_PATCH]`. This narrowly guards against pasting the tool's own diff-preview rows back as content; standard unified-diff lines (`+x`, `-x`, ` x`, `@@ … @@`) are **not** rejected — they are written literally, since literal content must never be silently altered. Bare `HASH│` content (the first 4 chars of a `content_lines` entry looking like 3 base64 chars + `│`) is rejected with `[E_BARE_HASH_PREFIX]`. When the suspect's prefix happens to match a real file-line anchor, the error message flags that as strong evidence the model copied an anchor from the read output.

- **BOM preservation.** A UTF-8 BOM is stripped for display and hashing but restored on write, so edits (and undo) never silently strip a BOM from a file that has one.
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated without replacing the symlink. Hard-linked files are updated in place to preserve the shared inode. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by the canonical write target, so concurrent edits through different symlink paths still serialize onto the same underlying file.
- **Boundary duplication auto-fix.** When the last line of a replacement matches the next surviving line (or the first line matches the preceding one), the runtime automatically strips the duplicate from `content_lines` before applying the edit. This catches a common LLM pattern where closing delimiters like `}`, `});`, or `} else {` are accidentally duplicated. The auto-fix is completely silent — the model sees a normal successful edit. The duplicate never reaches the file. Raw line comparison (not trimmed) avoids false positives when indentation differs.
- **Flat mode normalization.** When flat mode is active, the tool's `execute` function wraps the top-level `hash_range_inclusive` and `content_lines` into a single-element `changes` array internally, then runs the same pipeline as bulk mode. The `normReq` function in `replace-normalize.ts` also handles flat format directly, so any code path that normalizes input (e.g. `compPreview`) works with both formats.
- **Persistent hash store.** `lineHashes` is async and uses a persistent store to preserve hashes for unchanged lines across edits. The store is a SQLite database at `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (per-path snapshots keyed by resolved path storing a 64-bit content checksum + line hashes; auto-created on first use). When called from the replace pipeline, it maps old vs new content and copies hashes for unchanged lines. When called from read, it returns saved hashes if the content's checksum matches, otherwise computes fresh hashes via `_lineHashesPure`. Stale snapshots are pruned on session start. This ensures that editing one part of a file does not cascade to change hashes of unrelated lines. Per-operation work scales with the target file, not cumulative history. If the database is corrupt or unreadable it is quarantined (renamed to `hash-store.sqlite.corrupt-<timestamp>`) and rebuilt from content on the next session start — the store is a cache, never a source of truth.
## Hashing

Hashes are computed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32 via WebAssembly), then mapped to a 3-character string from the URL-safe base64 alphabet `A-Za-z0-9-_`. That's 64 distinct characters, 6 bits per position, 18 bits of entropy per anchor.

The alphabet is sized for an LLM consumer. The model tokenizes, it doesn't squint at pixel glyphs, so the human-readability heuristics used by smaller hand-curated alphabets (no G/L/I/O because they look like digits, no vowels so the hash doesn't accidentally spell a word, no hex digits so it can't be confused with `0xFF`) don't apply. The full 64 chars give maximum entropy per character, with case and digits included.

Before hashing, each line is normalized: carriage returns are stripped and trailing whitespace is trimmed. This `canon()` normalization prevents insignificant whitespace changes from cascade-triggering hash churn across the file. Two lines that differ only in trailing spaces or `\r` characters produce the same hash, so anchor stability is preserved across editor-save cycles that add or remove trailing whitespace.

**Perfect hashing (collision resolution):** When computing hashes for a file, if a line's base hash collides with an already-assigned hash, the next available hash is assigned from a bitset (32KB, 262,144 bits) using a hint cursor for O(1) amortized lookup. This ensures every line in a file gets a unique anchor, even with the shorter 3-character hash space. Two byte-identical lines (e.g. repeated `}` or repeated `import` statements) get different hashes automatically.
The runtime always precomputes the full per-line hash array for a file via `lineHashes(content, path)`, then looks up by line number during validation and during `read` / `replace` response formatting. There is no per-line recomputation that could disagree with what the model saw in its last read. When `path` is provided, `lineHashes` uses a persistent store to preserve hashes for unchanged lines across edits — see [Stable hashing across edits](#stable-hashing-across-edits).
`HASH_LEN` in `src/hashline/hash.ts` sets the hash body length; bump it to 4 if you need even more entropy without collision resolution.

The 3-character space holds 262,144 unique anchors, so files are capped at 262,144 lines: `read` and `replace` reject larger files with `[E_FILE_TOO_LARGE]` (use `write` or a non-line-based approach for very large files).

### Bare-prefix detector

With the `│` delimiter format, the bare-prefix detector regex `^\s*([A-Za-z0-9_\-]{3})│` is highly specific. It only matches lines starting with a hash-like prefix. This eliminates false positives from common code patterns like `init:`, `data:`, `else:`, etc. The detector rejects edit lines matching this pattern with `[E_BARE_HASH_PREFIX]` to prevent the model from accidentally pasting hash anchors into file content.

## Development

Requires [Node.js](https://nodejs.org) and npm.

```bash
npm install
npm test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

Set `PI_HASHLINE_AUTO_READ=1` to enable auto-read after write and replace by default on first run (can still be toggled at runtime with `/toggle-auto-read`; the setting persists across sessions once toggled).

## Credits

- [RimuruW](https://github.com/RimuruW) -- original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357) -- original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
