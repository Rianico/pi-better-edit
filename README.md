# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored editing workflow. Every line of a file is tagged with a unique 3-character content hash; `replace` targets lines by those hashes instead of raw text, so stale context is caught and rejected before it reaches the file.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extending it with 3-character hashes and collision resolution — see [Hashing](#hashing).

## Features

- **Hash-anchored reads.** `read` returns every line as `HASH│content`.
- **Precise edits.** `replace` targets a line range by hash. Mismatched anchors fail loudly with `[E_STALE_ANCHOR]` — never a silent "close enough" relocation.
- **Stable anchors.** Editing one part of a file leaves the hashes of untouched lines unchanged, so anchors from earlier reads stay valid.
- **Autocorrection with warnings.** Unambiguous copy-paste mistakes — hash prefixes, diff-preview rows, reversed ranges — are fixed automatically and reported.
- **Safe writes.** Atomic temp-file-then-rename writes preserve permissions, BOMs, line endings, symlinks, and hard links.
- **Auto-read.** Fresh anchors are appended to the result of every `write`, `replace`, and `undo_last_replace`.

## Installation

From npm:

```bash
pi install npm:pi-hashline-edit-pro
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## Quick start

1. Read a file. Every line comes back with a hash prefix (no line numbers — the hash is the address):

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

2. Replace a line by its hash:

```json
{
  "path": "src/main.ts",
  "hash_range_inclusive": ["szJ", "szJ"],
  "content_lines": ["  console.log('hi');"]
}
```

3. Keep editing. Anchors for untouched lines remain valid across edits, so hashes from earlier reads keep working; changed lines get fresh anchors, which auto-read appends to each result.

## The `read` tool

Returns a text file with every line prefixed by `HASH│content`. The hash is a 3-character content hash from the alphabet `A-Za-z0-9` (e.g. `aB3`).

Optional parameters:

| Parameter | Description |
| --- | --- |
| `offset` | Start reading from this line number (1-indexed). |
| `limit` | Maximum number of lines to return. |

Paged output ends with a continuation hint, e.g. `[Showing lines 1-50 of 120. Use offset=51 to continue.]`.

Lines up to 200KB are displayed in full; larger lines are replaced by a marker with a bash inspection hint (`sed -n 'Np' <path> | head -c 204800`) since hash anchors require full lines.

Edge cases:

- **Images** (JPEG, PNG, GIF, WebP) are passed through as visual attachments and don't participate in the hashline protocol.
- **Binary and directory paths** are rejected with a descriptive error.
- **UTF-16/UTF-32 encoded text** (detected via BOM) is rejected with `[E_NOT_TEXT]` — editing such a file would decode it as `U+FFFD` garbage and rewrite it as corrupted UTF-8.
- **Empty files** are returned as a single empty-line hash (`HASH│`); use `replace` on that hash to insert content.
- **BOMs** are stripped for display; **non-UTF-8 bytes** are shown as `U+FFFD` (editing such a file rewrites it as UTF-8, with a warning).
- **Files over 238,328 lines** are rejected with `[E_FILE_TOO_LARGE]` (see [Hashing](#hashing)).

## The `replace` tool

The built-in `edit` tool is disabled — `replace` is the only edit path; call it with the hash anchors from `read` output.

Exactly one edit per call, with `hash_range_inclusive` and `content_lines` at the top level of the request:

```json
{
  "path": "src/main.ts",
  "hash_range_inclusive": ["szJ", "kQm"],
  "content_lines": ["  console.log('hi');", "}"]
}
```

| Field | Description |
| --- | --- |
| `hash_range_inclusive` | Pair of 3-char hashes from `read` output marking the first and last line of the range to replace (inclusive). |
| `content_lines` | Replacement content, one string per line; entries must not contain line breaks. Use `[]` to delete the range. |

Behavior:

- **Validation before any file I/O.** Unknown fields, missing fields, wrong types, and malformed anchors are rejected with `[E_BAD_SHAPE]` / `[E_BAD_REF]`. The edit applies against the pre-edit snapshot, so all hashes in the request come from one consistent file state.
- **Rejected dialects.** The `changes` array dialect and the legacy `oldText`/`newText` dialect are rejected with `[E_LEGACY_SHAPE]`; the error tells you to send `{hash_range_inclusive: ["<START>", "<END>"], content_lines: [...]}`.
- **Autocorrections** (all accompanied by a warning unless noted):
  - A `HASH│` prefix accidentally left on a `content_lines` entry is stripped.
  - Diff-preview rows (`+HASH│…`, `-HASH│…`, `-   │…`) pasted into `content_lines` have their markers stripped. Numbered deletion rows (`-1    foo`) and unified-diff lines are written literally — never silently altered.
  - A reversed range (start hash after end hash) is swapped and applied.
  - A duplicated boundary line — the classic `}`, `});`, or `} else {` pasted twice — is silently removed; the duplicate never reaches the file.
  - `file_path` is accepted as an alias for `path`; a JSON-string `content_lines` is parsed into an array.
- **Response.** With auto-read enabled (the default), a successful edit returns the post-edit diff — the same `+HASH│` / `-   │` / ` HASH│` rows the user sees — instead of the summary, and the auto-read block appends fresh anchors right after it. With auto-read disabled, the edit reports `Successfully replaced in {path}. Added X line(s), removed Y line(s).` plus any warnings. Warnings are appended in both modes. An edit that produces identical content reports `No changes made` and never rotates anchors. The post-edit diff is exposed to the host UI via `details.diff`; it reaches the model-visible text only while auto-read is on.
- **Undo.** Every successful replace is undoable once via `undo_last_replace` — see [Undo](#undo).

## Anchor stability

Hashes are stored in a persistent per-file store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) that preserves the hashes of unchanged lines across edits. When a range is replaced, the runtime maps the old content onto the new content and copies hashes for lines that survived; only genuinely new lines get fresh hashes.

Two guarantees make this safe even with duplicated content:

- **An edited range never borrows a hash from a line outside it.** Lines outside the replaced range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range.
- **Re-inserted identical text keeps its hash.** If replacement content matches a line that was just removed, the removed line's hash is reused — "replace X with X" doesn't rotate the anchor.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

## Auto-read

Enabled by default. After a successful `write`, `replace`, or `undo_last_replace`, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block to the result, so the model gets immediate `HASH│content` anchors without a separate `read` call.

- After `replace`, the success summary is replaced by the post-edit diff (the same `+HASH│` / `-   │` / ` HASH│` rows the user sees) plus any warnings, so the model sees the change like a git diff instead of line counts.
- After `replace` / `undo_last_replace`, the block covers the changed span plus 2 lines of context above and below — the rest of the file keeps its anchors from the persistent store.
- After `write`, the block dumps from the top of the file. For files over 2000 lines, the dump is truncated with a pagination hint — use `read` with `offset` to continue.
- Auto-read keeps a 50KB display budget: lines over 50KB are skipped with a marker instead of their content (use `read` for lines up to 200KB).
- Toggle at runtime with `/toggle-auto-read`; the setting persists across sessions.
- If the auto-read itself fails (e.g. the file was deleted between the operation and the read), a short `--- Auto-read failed: ... ---` notice is appended instead of the anchor block, so the model knows the anchors are missing.

## Undo

`undo_last_replace` reverts the most recent successful `replace` on a file, restoring the exact previous content — BOM and line endings included — and the previous anchors.

- History is per-file and single-level: only the most recent replace can be reverted.
- History is persisted in the hash store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) and survives session restarts; a failed `write` does not clear it.
- **Undo is a precondition, not a convenience.** The undo record is persisted *before* the edit is written; if it cannot be persisted, the `replace` is refused with `[E_UNDO_UNAVAILABLE]` and the file is not touched, so every applied edit is undoable. If the file write itself then fails, the previous undo record is restored, so a refused edit never destroys earlier undo history.
- A successful `write` clears the history for that file.
- Call `read` after an undo to get fresh anchors for follow-up edits.
- **Safety guard.** If the file was modified or deleted since the last replace, `undo_last_replace` refuses with `[E_UNDO_STALE]` rather than overwriting those changes.

## Commands and configuration

| Command | Description |
| --- | --- |
| `/toggle-auto-read` | Toggle automatic hashline anchors after write and replace operations. Persists across sessions. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created automatically when a setting is toggled:

```json
{
  "autoRead": true
}
```

## Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields, or a `content_lines` entry contains a line break. |
| `[E_BAD_REF]` | An anchor in `hash_range_inclusive` is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `content_lines` entry is a diff-preview row (`+HASH│`, `-HASH│`, `-   │`) — the marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `content_lines` entry starts with a hash-like `HASH│` prefix — the prefix is stripped automatically with a warning. |
| `[E_LEGACY_SHAPE]` | The request uses an unsupported dialect: `oldText`/`newText` fields or a `changes` array. |
| `[E_BAD_OP]` | Range start line is after range end line — the pair is swapped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_replace` refused: the file was modified or deleted after the last replace. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the `replace` was refused and the file was left unchanged. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit. |

## Hashing

Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32), then mapped to a 3-character string over `A-Za-z0-9` — 62³ = 238,328 possible anchors. The canonicalization keeps anchors stable across editor-save cycles that add or remove trailing whitespace.

The alphabet is sized for an LLM consumer: the model tokenizes rather than squinting at glyphs, so case and digits are all included. The URL-safe specials `-` and `_` are deliberately excluded — a hash starting with `-` is shape-identical to a diff-preview deletion row, and `-`/`_` at a line start are markdown-active, inviting mis-copying and false autocorrections.

**Unique anchors by construction.** If a line's base hash collides with an already-assigned hash, the next free hash is allocated from a bitset (O(1) amortized). Every line in a file therefore gets a unique anchor — two byte-identical lines (repeated `}`, repeated `import` statements) never share one. The same guarantee sets the file size cap: at most 238,328 lines per file, beyond which `read` and `replace` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

## Design decisions

- **Stale anchors fail, per line.** A hash mismatch means that line's content changed since the last `read`. The error says so and, when only one anchor of a pair is stale, shows the current lines around the still-valid anchor so the range can be re-located without a full re-read. Mismatched anchors are never silently relocated to a "close enough" line — correctness over convenience.
- **Autocorrection only when the intent is unambiguous**, and always visible: hash-prefix and diff-row stripping produce a warning; the boundary-duplication fix is silent because the duplicate never reaches the file. Literal content is never silently altered when the intent is ambiguous (numbered deletion rows and unified-diff lines are written verbatim).
- **Byte-exact preservation.** UTF-8 BOMs, CRLF, LF, and CR-only line endings, file permissions, and trailing newlines survive edits and undo; files with mixed line endings are normalized to a single line ending on edit.
- **Atomic and ordered writes.** Files are written via temp-file-then-rename; symlink chains are resolved so the target is updated without replacing the symlink; hard-linked files are updated in place; concurrent edits to the same underlying file serialize through a per-target mutation queue.
- **One edit per call.** The request shape stays `{path, hash_range_inclusive, content_lines}` from schema through validation to application; there is no batching dialect.

## Troubleshooting

- **Stale anchors.** `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` mean the file changed since the anchors were read, or an earlier `read` never happened. Call `read` for fresh anchors and retry.
- **Reset the hash store.** Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars). Quit pi, delete those three files, and the store is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- **Corrupt store.** If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` (plus `-wal`/`-shm` variants) and rebuilt automatically; the quarantined files can be deleted once a healthy store exists.
- **Legacy migration.** On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`, which can be deleted.
- **`[E_UNDO_UNAVAILABLE]`.** The edit was refused because the undo record could not be written — check disk space and that the config directory is writable, then retry.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.13 and npm.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW) — original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357) — original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
