# pi-hashline-edit-lsz

Hash-anchored `read` and `edit` tools for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Every line of a file gets a unique 3-character hash, and you edit by hash. No line numbers, no fuzzy matching, no edits landing on the wrong line.

Inspired by [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW and [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) — thanks to the original authors for their excellent work. This project is a **self-maintained version**: it is not affiliated with either upstream, exists to carry its own fixes and refinements forward, and deliberately diverges where noted below.

## Refinements over upstream

- **`edit` / `undo_last_edit`** — the tools are renamed from `replace` / `undo_last_replace`, and this extension's `edit` replaces pi's built-in edit tool.
- **Served-state range verification** — `edit` verifies *every line* of the resolved range against what the model was actually shown, not just the two boundary anchors. A line inside the range that changed on disk since it was served is hard-rejected with `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]`, and the current range is echoed back as fresh anchors so the retry needs no `read` (reject-and-serve).
- **Drift notices** — when served territory outside the edit range changed on disk, the result carries an informational notice with the current content around the drift, once per episode.
- **Chained edits without re-reading** — post-edit diff rows and rejection echoes count as serves, so follow-up edits verify cleanly; prompts present `read` as on-demand recovery, not a per-edit ritual.
- **Verified against upstream** — the comparison battery scores this fork 23/23; upstream `pi-hashline-edit-pro` 2.4.1 scores 17/23 (five silent data-loss cases on stale interiors plus a cross-session serve leak) and 2.5.0 scores 21/23 (a blind-edit hole and a cross-session serve leak).
- **Architecture** — a dedicated served-state module owns serve recording and the served-span reconstruction; post-edit result assembly is a single pure function over structured warnings.
- **Own identity** — published as the `pi-hashline-edit-lsz` npm package, with its own config and hash-store directory (`~/.config/pi-hashline-edit-lsz`).

## What you get

- **Read with anchors.** Every line comes back as `HASH│content`. The hash is the line's address.
- **Edit by hash.** `edit` targets a range of hashes, so edits always land on the lines you meant.
- **Anchors that stay put.** Edit one part of a file and the hashes of the rest stay the same. Read once, keep editing.
- **Fresh anchors, automatically.** After every `write` you get the new anchors. After every `edit` you get the diff with the new hashes.
- **Undo when you need it.** The last edit on a file can be reverted, even after a restart.
- **Safe writes.** Permissions, line endings, BOMs, symlinks, and hard links survive every edit.

## Quick start

1. Read a file:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

1. Edit a line by its hash:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "szJ",
  "replacement_text": "  console.log('hi');"
}
```

1. Keep editing. Anchors for lines you didn't touch stay valid, and auto-read hands you fresh anchors after each change.

## Installation

```bash
pi install npm:pi-hashline-edit-lsz
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-lsz
```

## The read tool

`read` returns a text file with every line prefixed by `HASH│content`. The hash is 3 characters from `A-Za-z0-9` (for example `aB3`).

| Parameter | Description |
| --- | --- |
| `offset` | Start reading from this line number (1-indexed). |
| `limit` | Maximum number of lines to return. |

Paged output ends with a continuation hint, for example `[Showing lines 1-50 of 120. Use offset=51 to continue.]`.

Lines up to 200KB are shown in full. Larger lines are shown as a marker with a bash inspection hint (`sed -n 'Np' <path> | head -c 204800`), because hash anchors need full lines.

Edge cases:

- Images (JPEG, PNG, GIF, WebP) come back as visual attachments.
- Binary files and directories are rejected with a descriptive error.
- UTF-16 and UTF-32 text (detected via BOM) is rejected, since editing it would corrupt the file.
- Empty files come back as a single empty-line hash (`HASH│`); use `edit` on that hash to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 238,328 lines are rejected with `[E_FILE_TOO_LARGE]`.

## The edit tool

This extension's `edit` replaces pi's built-in edit tool, and it takes the hash anchors from `read` output.

One edit per call, with `remove_from`, `remove_to`, and `replacement_text` at the top level:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "kQm",
  "replacement_text": "  console.log('hi');\n}"
}
```

| Field | Description |
| --- | --- |
| `remove_from` | 3-char hash from `read` output marking the FIRST line to remove (inclusive). |
| `remove_to` | 3-char hash from `read` output marking the LAST line to remove (inclusive). |
| `replacement_text` | Replacement text as a single string with `\n` line separators; every `\n` separates lines, so a trailing `\n` adds a final empty line — mirror the removed lines exactly, blank lines included (a replacement that is only blank lines is written as one `\n` per blank line). Use `""` to delete the range. |

Notes:

- The request is checked before any file I/O, so a bad request never touches the file.
- Common copy-paste slips are fixed automatically and reported: a leftover `HASH│` prefix in `replacement_text` or `remove_from`/`remove_to`, diff-preview rows pasted into the replacement, a reversed range, or a boundary line pasted twice. New lines that re-include a block adjacent to the range are stripped automatically when that block is unique in the file — the whole run is stripped as one unit (including repeated structural lines like `}`), so re-including an unchanged block next to the range never duplicates it. A missing `path` is resolved from the anchors when they uniquely identify a file in the hash store (reported as a warning); when the anchors match multiple known files the request is rejected with the candidate paths named. `file_path` works as an alias for `path` in all three tools.
- An edit that produces identical content reports `No changes made` and leaves the anchors alone.
- After a successful edit you get the post-edit diff with fresh anchors, so you can keep editing without re-reading.
- Do not issue multiple edit calls on the same file in one message; use `batch_edit` instead — it validates every edit before writing anything and returns one combined diff per file.

## The batch_edit tool

`batch_edit` applies several edits in one atomic call. Each item has the same shape as `edit` (`path`, `remove_from`, `remove_to`, `replacement_text`; `path` is optional per item and resolved from the anchors when they uniquely identify a file). Items are applied in order; edits to the same file are applied as one in-memory chain, so disjoint ranges compose while overlapping ranges fail closed.

The batch is **all-or-nothing**:

- **Preflight / application**: every item is resolved and its served-state span is verified before anything is written. If any item fails — stale or ambiguous anchor, `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]`, or a range that changed because of an earlier item in the batch — the whole batch is rejected with `[E_BATCH_ABORT]` and **no file changes**. The failing item's current range is echoed as fresh `HASH│content` rows (recorded as serves), so the retry needs no `read`.
- **Writes**: each touched file is written exactly once (original BOM and line endings preserved), after an undo record for every touched file is persisted. If a write fails, already-written files are restored from their undo records. `undo_last_edit` on any touched file reverts the batch's effect on that file.
- **Noops**: an item whose range already contains the replacement is reported without failing the batch; an all-noop batch reports "No changes made". The noop-loop guard applies per payload per file.
- **Result**: one combined diff per file with fresh anchors, aggregated warnings, and per-file drift notices. All diff rows count as serves, so follow-up `edit` calls anchor on the diff without re-reading.

`batch_edit` accepts 1–32 items (`[E_BAD_SHAPE]` otherwise). Malformed envelopes are rejected before any file I/O.

## Undo

`undo_last_edit` reverts the most recent successful `edit` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent edit can be reverted.
- History is persisted and survives session restarts. A failed `write` does not clear it.
- Every applied edit is undoable: the undo record is saved before the edit is written.
- A successful `write` clears the history for that file.
- If the file was modified or deleted since the last edit, the undo is refused rather than overwriting those changes.

## Auto-read

Always on. After a successful `write` that changes the file, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block to the result, so you get fresh `HASH│content` anchors without a separate `read` call.

- After `edit` and `undo_last_edit`, the result shows the post-edit diff. The `+HASH│` and `HASH│` rows carry the current hashes, so follow-up edits can anchor on the diff directly. The `-HASH│` rows show removed lines with their old hashes, so you can see exactly which anchors were deleted (those hashes are stale after the edit). Call `read` when you want the full file's anchors.
- Auto-read keeps a 50KB display budget. Lines over 50KB are skipped with a marker instead of their content (use `read` for lines up to 200KB).

## How anchors work

Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32), then mapped to a 3-character string over `A-Za-z0-9`, which gives 62³ = 238,328 possible anchors. The canonicalization keeps anchors stable across editor-save cycles that add or remove trailing whitespace.

The alphabet is sized for an LLM consumer: the model tokenizes rather than squinting at glyphs, so case and digits are all included. The URL-safe specials `-` and `_` are deliberately excluded. A hash starting with `-` is shape-identical to a diff-preview deletion row, and `-`/`_` at a line start are markdown-active, inviting mis-copying and false autocorrections.

Unique anchors by construction. If a line's base hash collides with an already-assigned hash, the next free hash is allocated from a bitset by probing with a stride coprime to the hash space (O(1) amortized). The stride is `62² + 62 + 1`, so consecutive collisions, runs of blank lines, repeated `}`, land on anchors that differ in all three characters instead of sharing a prefix. Every line in a file therefore gets a unique anchor; two byte-identical lines (repeated `}`, repeated `import` statements) never share one. The same guarantee sets the file size cap: at most 238,328 lines per file, beyond which `read` and `edit` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

Hashes live in a persistent per-file store (`~/.config/pi-hashline-edit-lsz/hash-store.sqlite`) that keeps the hashes of unchanged lines across edits. When a range is edited, the runtime maps the old content onto the new content and copies hashes for lines that survived; only genuinely new lines get fresh hashes.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows a hash from a line outside it. Lines outside the edited range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range.
- Re-inserted identical text keeps its hash. If replacement content matches a line that was just removed, the removed line's hash is reused. "Edit X with X" doesn't rotate the anchor.

A no-op edit never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

## Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `replacement_text` must be a string with `\n` line separators). |
| `[E_BAD_REF]` | An anchor in `remove_from`/`remove_to` is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `replacement_text` line is a diff-preview row (`+HASH│`, `-HASH│`, `-   │`). The marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `replacement_text` line starts with a hash-like `HASH│` prefix. The prefix is stripped automatically with a warning. |
| `[E_BAD_OP]` | Range start line is after range end line. The pair is swapped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_edit` refused: the file was modified or deleted after the last edit. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the `edit` was refused and the file was left unchanged. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit. |
| `[E_RANGE_STALE]` | A line inside the resolved edit range changed on disk since it was served (read output, diff, or rejection feedback). The edit is refused and the current range is echoed as fresh `HASH│content` rows; retry with those rows (no `read` needed). |
| `[E_RANGE_UNSERVED]` | A line inside the resolved edit range was never served to the model (paged reads, truncated output). The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_RANGE_UNVERIFIED]` | A boundary anchor (`remove_from`/`remove_to`) has no served position or was served at multiple positions, so the range cannot be verified against served state. The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_NOOP_LOOP]` | The exact same edit (same path, anchors, and replacement) was re-sent and produced no changes 3 consecutive times — the range already contains the replacement. The edit is refused and the current range is echoed as fresh `HASH│content` rows. |
| `[E_BATCH_ABORT]` | `batch_edit` rejected the whole batch: the named item failed validation or served-state verification. Nothing was written anywhere; the failing item's current range is echoed as fresh `HASH│content` rows. |

## Troubleshooting

- Stale anchors. `[E_STALE_ANCHOR]` or `[E_AMBIGUOUS_ANCHOR]` mean the file changed since the anchors were read. Call `read` for fresh anchors and retry.
- Reset the hash store. Anchors live in `~/.config/pi-hashline-edit-lsz/hash-store.sqlite` (with `-wal`/`-shm` sidecars). Quit pi, delete those three files, and the store is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` and rebuilt automatically.
- Config directory moved. On non-Windows platforms, if `XDG_CONFIG_HOME` is set, the config directory (and the hash store inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-lsz` instead of `~/.config/pi-hashline-edit-lsz`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.
- Package renamed. This fork was renamed from `pi-hashline-edit-pro` to `pi-hashline-edit-lsz`; the config directory moved from `~/.config/pi-hashline-edit-pro` to `~/.config/pi-hashline-edit-lsz`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

### Runtime edge-suite

`npm run test:runtime` runs the served-state edge scenarios (stale-interior reject-and-serve, chained edits without re-read, undo, never-served interior, drift notice) as one `fabric_exec` program against real pi, using the **temporary-extension** form (`pi -e npm:pi-fabric`) so nothing is installed into your pi. It needs network access to install the temp extension and takes a few minutes; exit code 0 means the suite passed.

## Credits

- [RimuruW](https://github.com/RimuruW), original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357), original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## Evaluation

A cross-version behavior battery lives in `test/eval/` (external-behavior only, `RUN_EVAL`-gated). Run it against this fork:

    npm run eval

Or compare this fork against the published upstream npm package (`pi-hashline-edit-pro`), by default `2.4.1` (the fork base) and `2.5.0` (latest); pass target specs as arguments to override:

    npm run eval:compare
    npm run eval:compare -- local pi-hashline-edit-pro@2.5.0

The compare script installs the requested package versions into `node_modules` temporarily (`--no-save --no-package-lock`), runs the battery against each target, prints a per-scenario correctness table plus aggregate call/token counts, then restores `node_modules` to the lockfile state.

## License

[MIT](LICENSE)
