# pi-hashline-edit-pro

Hash-anchored `read` and `replace` tools for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Every line of a file gets a unique 3-character hash, and you edit by hash. No line numbers, no fuzzy matching, no edits landing on the wrong line.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extended with 3-character hashes and collision resolution.

## What you get

- **Read with anchors.** Every line comes back as `HASH│content`. The hash is the line's address.
- **Edit by hash.** `replace` targets a range of hashes, so edits always land on the lines you meant.
- **Anchors that stay put.** Edit one part of a file and the hashes of the rest stay the same. Read once, keep editing.
- **Fresh anchors, automatically.** After every `write` you get the new anchors. After every `replace` you get the diff with the new hashes.
- **Undo when you need it.** The last replace on a file can be reverted, even after a restart.
- **Safe writes.** Permissions, line endings, BOMs, symlinks, and hard links survive every edit.

## Quick start

1. Read a file:

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

3. Keep editing. Anchors for lines you didn't touch stay valid, and auto-read hands you fresh anchors after each change.

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

- Images (JPEG, PNG, GIF, WebP) come back as visual attachments.
- Binary files and directories are rejected with a descriptive error.
- UTF-16 and UTF-32 text (detected via BOM) is rejected, since editing it would corrupt the file.
- Empty files come back as a single empty-line hash (`HASH│`); use `replace` on that hash to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 238,328 lines are rejected with `[E_FILE_TOO_LARGE]`.

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

Notes:

- The request is checked before any file I/O, so a bad request never touches the file.
- Common copy-paste slips are fixed automatically and reported: a leftover `HASH│` prefix in `new_content` or `hash_bounds`, diff-preview rows pasted into the replacement, a reversed range, or a boundary line pasted twice. `file_path` works as an alias for `path` in all three tools.
- An edit that produces identical content reports `No changes made` and leaves the anchors alone.
- After a successful edit you get the post-edit diff with fresh anchors, so you can keep editing without re-reading.

## Undo

`undo_last_replace` reverts the most recent successful `replace` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent replace can be reverted.
- History is persisted and survives session restarts. A failed `write` does not clear it.
- Every applied replace is undoable: the undo record is saved before the edit is written.
- A successful `write` clears the history for that file.
- If the file was modified or deleted since the last replace, the undo is refused rather than overwriting those changes.

## Auto-read

Enabled by default. After a successful `write` that changes the file, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block to the result, so you get fresh `HASH│content` anchors without a separate `read` call.

- After `replace` and `undo_last_replace`, the result shows the post-edit diff. The `+HASH│` and ` HASH│` rows carry the current hashes, so follow-up edits can anchor on the diff directly. Call `read` when you want the full file's anchors.
- After `write`, the block dumps from the top of the file. For files over 2000 lines, the dump is truncated with a pagination hint; use `read` with `offset` to continue.
- Auto-read keeps a 50KB display budget. Lines over 50KB are skipped with a marker instead of their content (use `read` for lines up to 200KB).
- Toggle at runtime with `/toggle-auto-read`; the setting persists across sessions.

## Settings

| Command | Description |
| --- | --- |
| `/toggle-auto-read` | Toggle automatic hashline anchors after write and post-edit diffs after replace and undo_last_replace operations. Persists across sessions. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created automatically when a setting is toggled. On non-Windows platforms, the config directory honors `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows it always uses `~/.config`:

```json
{
  "autoRead": true
}
```

## How anchors work

Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32), then mapped to a 3-character string over `A-Za-z0-9`, which gives 62³ = 238,328 possible anchors. The canonicalization keeps anchors stable across editor-save cycles that add or remove trailing whitespace.

The alphabet is sized for an LLM consumer: the model tokenizes rather than squinting at glyphs, so case and digits are all included. The URL-safe specials `-` and `_` are deliberately excluded. A hash starting with `-` is shape-identical to a diff-preview deletion row, and `-`/`_` at a line start are markdown-active, inviting mis-copying and false autocorrections.

Unique anchors by construction. If a line's base hash collides with an already-assigned hash, the next free hash is allocated from a bitset by probing with a stride coprime to the hash space (O(1) amortized). The stride is `62² + 62 + 1`, so consecutive collisions, runs of blank lines, repeated `}`, land on anchors that differ in all three characters instead of sharing a prefix. Every line in a file therefore gets a unique anchor; two byte-identical lines (repeated `}`, repeated `import` statements) never share one. The same guarantee sets the file size cap: at most 238,328 lines per file, beyond which `read` and `replace` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

Hashes live in a persistent per-file store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) that keeps the hashes of unchanged lines across edits. When a range is replaced, the runtime maps the old content onto the new content and copies hashes for lines that survived; only genuinely new lines get fresh hashes.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows a hash from a line outside it. Lines outside the replaced range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range.
- Re-inserted identical text keeps its hash. If replacement content matches a line that was just removed, the removed line's hash is reused. "Replace X with X" doesn't rotate the anchor.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

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

- Stale anchors. `[E_STALE_ANCHOR]` or `[E_AMBIGUOUS_ANCHOR]` mean the file changed since the anchors were read. Call `read` for fresh anchors and retry.
- Reset the hash store. Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars). Quit pi, delete those three files, and the store is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` and rebuilt automatically.
- Config directory moved. On non-Windows platforms, if `XDG_CONFIG_HOME` is set, the config directory (and the hash store inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-pro` instead of `~/.config/pi-hashline-edit-pro`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.

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
