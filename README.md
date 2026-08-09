# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored editing workflow. Every line of a file gets a unique 3-character content hash, and `replace` targets lines by those hashes. When the file has changed under you, the edit fails with a clear message instead of silently patching the wrong place.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extended with 3-character hashes and collision resolution. See [Hashing](#hashing).

## Why use it

- **Edits land where you aimed.** Anchors are content hashes, not line numbers. If a line changed since you read it, its anchor no longer matches and the edit is refused. No "close enough" relocations.
- **Anchors survive edits.** Change one part of a file and the hashes of untouched lines stay the same. Anchors from an earlier read keep working.
- **Copy-paste slips get caught.** A leftover `HASH│` prefix or a diff row pasted into the replacement is fixed automatically and reported, so the mistake never reaches the file.
- **Writes are safe.** Files are written atomically (temp file then rename), preserving permissions, BOMs, line endings, symlinks, and hard links.
- **Every edit is undoable.** The most recent replace on a file can be reverted, even after a restart.

## Quick start

1. Read a file. Every line comes back with a hash prefix. The hash is the address; there are no line numbers:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

2. Replace a line by its hash:

```json
{
  "path": "src/main.ts",
  "hash_bounds": ["szJ", "szJ"],
  "new_content": "  console.log('hi');"
}
```

3. Keep editing. Anchors for lines you didn't touch stay valid across edits, so hashes from earlier reads keep working. Changed lines get fresh anchors, which auto-read appends after each `write`.

## Installation

```bash
pi install npm:pi-hashline-edit-pro
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## The read tool

`read` returns a text file with every line prefixed by `HASH│content`. The hash is 3 characters from `A-Za-z0-9` (for example `aB3`).

| Parameter | Description |
| --- | --- |
| `offset` | Start reading from this line number (1-indexed). |
| `limit` | Maximum number of lines to return. |

Paged output ends with a continuation hint, for example `[Showing lines 1-50 of 120. Use offset=51 to continue.]`.

Lines up to 200KB are shown in full. Larger lines are replaced by a marker with a bash inspection hint (`sed -n 'Np' <path> | head -c 204800`), because hash anchors need full lines.

Edge cases:

- Images (JPEG, PNG, GIF, WebP) come back as visual attachments and don't take part in the hashline protocol.
- Binary files and directories are rejected with a descriptive error.
- UTF-16 and UTF-32 text (detected via BOM) is rejected with `[E_NOT_TEXT]`. Editing such a file would decode it as `U+FFFD` garbage and rewrite it as corrupted UTF-8.
- Empty files come back as a single empty-line hash (`HASH│`); use `replace` on that hash to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 238,328 lines are rejected with `[E_FILE_TOO_LARGE]` (see [Hashing](#hashing)).

## The replace tool

The built-in `edit` tool is disabled. `replace` is the only edit path, and it takes the hash anchors from `read` output.

One edit per call, with `hash_bounds` and `new_content` at the top level:

```json
{
  "path": "src/main.ts",
  "hash_bounds": ["szJ", "kQm"],
  "new_content": "  console.log('hi');\n}"
}
```

| Field | Description |
| --- | --- |
| `hash_bounds` | Pair of 3-char hashes from `read` output marking the first and last line of the range to replace (inclusive). |
| `new_content` | Replacement content as a single string with `\n` line separators; a trailing newline is the last line's ending, not an extra empty line. Use `""` to delete the range. |

What happens:

- The request is validated before any file I/O. Unknown fields, missing fields, wrong types, and malformed anchors are rejected with `[E_BAD_SHAPE]` or `[E_BAD_REF]`. The edit applies against the pre-edit snapshot, so all hashes in the request come from one consistent file state.
- Autocorrections, each reported with a warning unless noted:
  - A `HASH│` prefix accidentally left on a `new_content` line is stripped.
  - Diff-preview rows (`+HASH│…`, `-HASH│…`, `-   │…`) pasted into `new_content` have their markers stripped. Numbered deletion rows (`-1    foo`) and unified-diff lines are written literally, never silently altered.
  - A reversed range (start hash after end hash) is swapped and applied.
  - A duplicated boundary line, the classic `}`, `});`, or `} else {` pasted twice, is silently removed. The duplicate never reaches the file.
  - `file_path` is accepted as an alias for `path`.
- The response depends on auto-read. With auto-read on (the default), a successful edit returns the post-edit diff, the same `+HASH│` / `-   │` / ` HASH│` rows you see in the tool. With auto-read off, the edit reports `Successfully replaced in {path}. Added X line(s), removed Y line(s).` plus any warnings, and no diff is shown to the model. Warnings are appended in both modes. An edit that produces identical content reports `No changes made` and never rotates anchors. The post-edit diff is exposed to the host UI via `details.diff`, so the TUI always shows it.
- Every successful replace is undoable once via `undo_last_replace` (see [Undo](#undo)).

## Anchor stability

Hashes live in a persistent per-file store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) that keeps the hashes of unchanged lines across edits. When a range is replaced, the runtime maps the old content onto the new content and copies hashes for lines that survived; only genuinely new lines get fresh hashes.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows a hash from a line outside it. Lines outside the replaced range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range.
- Re-inserted identical text keeps its hash. If replacement content matches a line that was just removed, the removed line's hash is reused. "Replace X with X" doesn't rotate the anchor.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

## Auto-read

Enabled by default. After a successful `write` that changes the file, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block to the result, so you get immediate `HASH│content` anchors without a separate `read` call.

- A no-op `replace` produces no diff. The file is unchanged, so existing anchors remain valid.
- After `replace` and `undo_last_replace`, the success summary is replaced by the post-edit diff (the same `+HASH│` / `-   │` / ` HASH│` rows used for replace) plus any warnings. The diff rows are the fresh anchors: `+HASH│` and ` HASH│` rows carry the current hashes, and unchanged lines keep their previous hashes, so follow-up edits can anchor on the diff directly. Call `read` when you want the full file's anchors.
- With auto-read disabled, `replace` and `undo_last_replace` results keep the plain summary in the model-visible text. No diff and no anchor block reach the model; the post-edit diff is still shown to the user.
- After `write`, the block dumps from the top of the file. For files over 2000 lines, the dump is truncated with a pagination hint; use `read` with `offset` to continue.
- Auto-read keeps a 50KB display budget. Lines over 50KB are skipped with a marker instead of their content (use `read` for lines up to 200KB).
- Toggle at runtime with `/toggle-auto-read`; the setting persists across sessions.
- If the auto-read itself fails (for example the file was deleted between the write and the read), a short `--- Auto-read failed: ... ---` notice is appended instead of the anchor block, so you know the anchors are missing.

## Undo

`undo_last_replace` reverts the most recent successful `replace` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent replace can be reverted.
- History is persisted in the hash store and survives session restarts. A failed `write` does not clear it.
- Undo is a precondition, not a convenience. The undo record is persisted before the edit is written. If it cannot be persisted, the `replace` is refused with `[E_UNDO_UNAVAILABLE]` and the file is not touched, so every applied edit is undoable. If the file write itself then fails, the previous undo record is restored, so a refused edit never destroys earlier undo history.
- A successful `write` clears the history for that file.
- With auto-read enabled, the model sees the post-edit diff after an undo, just like a replace. With auto-read disabled it sees the plain summary. No anchors are appended after an undo; call `read` to get fresh anchors for follow-up edits.
- Safety guard: if the file was modified or deleted since the last replace, `undo_last_replace` refuses with `[E_UNDO_STALE]` rather than overwriting those changes.

## Commands and configuration

| Command | Description |
| --- | --- |
| `/toggle-auto-read` | Toggle automatic hashline anchors after write and post-edit diffs after replace and undo_last_replace operations. Persists across sessions. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created automatically when a setting is toggled. On non-Windows platforms, the config directory honors `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows it always uses `~/.config`:

```json
{
  "autoRead": true
}
```

## Hashing

Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32), then mapped to a 3-character string over `A-Za-z0-9`, which gives 62³ = 238,328 possible anchors. The canonicalization keeps anchors stable across editor-save cycles that add or remove trailing whitespace.

The alphabet is sized for an LLM consumer: the model tokenizes rather than squinting at glyphs, so case and digits are all included. The URL-safe specials `-` and `_` are deliberately excluded. A hash starting with `-` is shape-identical to a diff-preview deletion row, and `-`/`_` at a line start are markdown-active, inviting mis-copying and false autocorrections.

Unique anchors by construction. If a line's base hash collides with an already-assigned hash, the next free hash is allocated from a bitset by probing with a stride coprime to the hash space (O(1) amortized). The stride is `62² + 62 + 1`, so consecutive collisions, runs of blank lines, repeated `}`, land on anchors that differ in all three characters instead of sharing a prefix. Every line in a file therefore gets a unique anchor; two byte-identical lines (repeated `}`, repeated `import` statements) never share one. The same guarantee sets the file size cap: at most 238,328 lines per file, beyond which `read` and `replace` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

## Design decisions

- Stale anchors fail, per line. A hash mismatch means that line's content changed since the last `read`. The error says so and, when only one anchor of a pair is stale, shows the current lines around the still-valid anchor so the range can be re-located without a full re-read. Mismatched anchors are never silently relocated to a "close enough" line. Correctness over convenience.
- Autocorrection only when the intent is unambiguous, and always visible: hash-prefix and diff-row stripping produce a warning; the boundary-duplication fix is silent because the duplicate never reaches the file. Literal content is never silently altered when the intent is ambiguous (numbered deletion rows and unified-diff lines are written verbatim).
- Byte-exact preservation. UTF-8 BOMs, CRLF, LF, and CR-only line endings, file permissions, and trailing newlines survive edits and undo; files with mixed line endings are normalized to a single line ending on edit.
- Atomic and ordered writes. Files are written via temp-file-then-rename; symlink chains are resolved so the target is updated without replacing the symlink; hard-linked files are updated in place; concurrent edits to the same underlying file serialize through a per-target mutation queue.
- One edit per call. The request shape stays `{path, hash_bounds, new_content}` from schema through validation to application; there is no batching dialect.

## Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `new_content` must be a string with `\n` line separators). |
| `[E_BAD_REF]` | An anchor in `hash_bounds` is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `new_content` line is a diff-preview row (`+HASH│`, `-HASH│`, `-   │`). The marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `new_content` line starts with a hash-like `HASH│` prefix. The prefix is stripped automatically with a warning. |
| `[E_BAD_OP]` | Range start line is after range end line. The pair is swapped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_replace` refused: the file was modified or deleted after the last replace. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the `replace` was refused and the file was left unchanged. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit. |

## Troubleshooting

- Stale anchors. `[E_STALE_ANCHOR]` or `[E_AMBIGUOUS_ANCHOR]` mean the file changed since the anchors were read, or an earlier `read` never happened. Call `read` for fresh anchors and retry.
- Reset the hash store. Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars). Quit pi, delete those three files, and the store is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Upgrading. A hash-allocation change clears the hash store once on the first run after upgrade. Anchors are rebuilt on the next read and undo history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` (plus `-wal`/`-shm` variants) and rebuilt automatically. The quarantined files can be deleted once a healthy store exists.
- Legacy migration. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`, which can be deleted. Legacy snapshots containing duplicate hashes are skipped and rebuilt on the next read.
- Config directory moved. On non-Windows platforms, if `XDG_CONFIG_HOME` is set, the config directory (and the hash store inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-pro` instead of `~/.config/pi-hashline-edit-pro`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.
- `[E_UNDO_UNAVAILABLE]`. The edit was refused because the undo record could not be written. Check disk space and that the config directory is writable, then retry.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW), original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357), original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
