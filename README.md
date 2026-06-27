# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored line-replacing workflow. Strict semantics, no silent relocation, no autocorrection, no fuzzy fallback. 3-character content hashes over a 64-character URL-safe base64 alphabet give 18 bits of entropy per anchor, with perfect hashing (collision resolution) ensuring every line gets a unique anchor.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW. The strict-semantics policy is unchanged. This fork extends the upstream design in two ways: a 3-character hash length with a 64-character alphabet for more entropy, and perfect hashing (collision resolution) that ensures every line in a file gets a unique anchor.

Every line returned by `read` carries a short content hash. Edits reference those hashes instead of raw text, so the tool can detect stale context and reject outdated changes before they reach the file.

## Why fork?

The original uses 2-character hashes of a 16-character alphabet, with the hash being a pure function of line content. That's 8 bits / 256 buckets, and two byte-identical lines (e.g. repeated `import` statements, repeated `}`) always share a hash because the hash is `xxHash32(content)`.

This fork makes two changes that compound:

1. **Bump hash length to 3 characters** of the 64-char URL-safe base64 alphabet. That gives 18 bits / 262,144 buckets, up from 8 bits / 256 in the upstream.
2. **Perfect hashing (collision resolution).** When computing hashes for a file, if a line's base hash collides with an already-assigned hash, the hash is incremented (using a retry counter: `:R{retry}`) until a unique hash is found. This ensures every line in a file gets a unique anchor, even with the shorter 3-character hash space. Two byte-identical lines (e.g. repeated `import` statements, repeated `}`) get different hashes automatically.

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

- `HASH` is a 3-character content hash from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3`).

Optional parameters:

- `offset` -- start reading from this line number (1-indexed).
- `limit` -- maximum number of lines to return.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments and do not participate in the hashline protocol. Binary and directory paths are rejected with a descriptive error. Empty files return an advisory suggesting using replace to insert content.

### `replace` -- hash-anchored modifications

Replaces using the `HASH│content` anchors from `read` output to target lines precisely:

```json
{
  "path": "src/main.ts",
  "changes": [
    { "hash_range_incl": ["ve7", "ve7"], "content_lines": ["  console.log('hashline');"] }
  ]
}
```

| Field | Description |
| --- | --- |
| `hash_range_incl` | Inclusive line range `[start_hash, end_hash]` (required). |
| `content_lines` | Literal replacement content, one string per line (use `[]` to delete the range). |

- **Request structure validation.** The request envelope (`path`, `changes`) and individual edit items are validated before any file I/O. Unknown fields, missing required fields, invalid types, and malformed anchors are rejected with `[E_BAD_SHAPE]` or `[E_BAD_REF]`.
- **Legacy dialect rejected.** The native top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect is rejected with `[E_LEGACY_SHAPE]`. The error message tells the model to call `read` first and send `{hash_range_incl: ["<START>", "<END>"], content_lines: [...]}`.
- **Batched atomicity.** All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so the hashes from a single `read` call remain valid across all edits in the batch.

### Chained edits

After a successful replace, the response text is empty (warnings are still shown if present). To get fresh anchors for follow-up edits, call `read` on the file first. This avoids token overhead from re-displaying content the model already knows.

### Auto-read after write

Auto-read is **disabled by default**. When enabled, after a successful `write` the extension automatically reads the file and appends a `--- Auto-read (hashline anchors) ---` block to the result. This gives the model immediate `HASH│content` anchors for the newly written file without requiring a separate `read` call. The workflow becomes:

1. `write` a file, result includes hashline anchors
2. `replace` using those anchors directly

Toggle at runtime with the `/toggle-auto-read` command. The current state persists for the session.

For large files (>2000 lines), the auto-read output is truncated with a pagination hint. Use `read` with `offset` to see more.

### Diff for the host

The post-edit diff (with `+`/`-` markers) is exposed to the host UI via `details.diff`. It is intentionally not in the LLM-visible text. The model already knows what it changed and can call `read` for fresh anchors when needed.

## Design Decisions

- **Stale anchors fail (per-line).** A hash mismatch means that specific line's content changed since the last `read`; the error tells the model to call `read()` to get fresh anchors, then copy the 3-character HASH of the start and end of the range being replaced into `hash_range_incl` of the next replace call. Because staleness is per-line, editing or appending lines does **not** invalidate anchors for lines whose content is unchanged — anchors for untouched regions stay valid across edits to other regions.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Strict patch content.** If `content_lines` contains `+HASH│` display prefixes (or `-N   ` numbered deletion rows), the edit is rejected with `[E_INVALID_PATCH]`. This narrowly guards against pasting the tool's own diff-preview rows back as content; standard unified-diff lines (`+x`, `-x`, ` x`, `@@ … @@`) are **not** rejected — they are written literally, since literal content must never be silently altered. Bare `HASH│` content (the first 4 chars of a `content_lines` entry looking like 3 base64 chars + `│`) is rejected with `[E_BARE_HASH_PREFIX]`. When the suspect's prefix happens to match a real file-line anchor, the error message flags that as strong evidence the model copied an anchor from the read output.
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated without replacing the symlink. Hard-linked files are updated in place to preserve the shared inode. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by the canonical write target, so concurrent edits through different symlink paths still serialize onto the same underlying file.
- **Boundary duplication warnings.** When the last line of a replacement matches the next surviving line (or the first line matches the preceding one), a warning is emitted. This catches a common LLM pattern where closing delimiters like `}`, `});`, or `} else {` are accidentally duplicated. The warning includes the surviving line's post-edit hash so the model can reference it in a follow-up edit. No autocorrection is applied — the duplicate stays in the file and the model decides whether to remove it. Raw line comparison (not trimmed) avoids false positives when indentation differs.

## Hashing

Hashes are computed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32 via WebAssembly), then mapped to a 3-character string from the URL-safe base64 alphabet `A-Za-z0-9-_`. That's 64 distinct characters, 6 bits per position, 18 bits of entropy per anchor.

The alphabet is sized for an LLM consumer. The model tokenizes, it doesn't squint at pixel glyphs, so the human-readability heuristics used by smaller hand-curated alphabets (no G/L/I/O because they look like digits, no vowels so the hash doesn't accidentally spell a word, no hex digits so it can't be confused with `0xFF`) don't apply. The full 64 chars give maximum entropy per character, with case and digits included.

**Perfect hashing (collision resolution):** When computing hashes for a file, if a line's base hash collides with an already-assigned hash, the hash is incremented (using a retry counter: `:R{retry}`) until a unique hash is found. This ensures every line in a file gets a unique anchor, even with the shorter 3-character hash space. Two byte-identical lines (e.g. repeated `}` or repeated `import` statements) get different hashes automatically.

The runtime always precomputes the full per-line hash array for a file via `lineHashes(content)`, then looks up by line number during validation and during `read` / `replace` response formatting. There is no per-line recomputation that could disagree with what the model saw in its last read.

`HASH_LEN` in `src/hashline/hash.ts` sets the hash body length; bump it to 4 if you need even more entropy without collision resolution.

### Bare-prefix detector

With the `│` delimiter format, the bare-prefix detector regex `^\s*[A-Za-z0-9_\-]{3}│` is highly specific. It only matches lines starting with exactly 3 base64 chars and `│`. This eliminates false positives from common code patterns like `init:`, `data:`, `else:`, etc. The detector rejects edit lines matching this pattern with `[E_BARE_HASH_PREFIX]` to prevent the model from accidentally pasting hash anchors into file content.

## Development

Requires [Node.js](https://nodejs.org) and npm.

```bash
npm install
npm test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

Set `PI_HASHLINE_AUTO_READ=1` to enable auto-read after write by default (can still be toggled at runtime with `/toggle-auto-read`).

## Credits

- [RimuruW](https://github.com/RimuruW) -- original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357) -- original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
