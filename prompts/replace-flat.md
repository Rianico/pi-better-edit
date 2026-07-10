Replace lines in a text file using HASH anchors from `read`. Only one edit per call (no bulk `changes` array — `hash_range_inclusive` and `content_lines` sit at the top level).

How to use:

1. Call `read` to get HASH anchors:
```
read({ path: "src/main.ts" })
```

2. Copy the 3-character HASH (before `│`) into `hash_range_inclusive`:
```json
{ "content_lines": ["const x = 99;"], "hash_range_inclusive": ["MQX", "MQX"], "path": "src/main.ts" }
```

Examples:

1. Single line replace:
```json
{ "content_lines": ["const x = 1;"], "hash_range_inclusive": ["MQX", "MQX"], "path": "src/main.ts" }
```

2. Range replace (3 lines → 3 new lines):
```json
{ "content_lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  ], "hash_range_inclusive": ["ZPM", "VRW"], "path": "src/main.ts" }
```

3. Delete a range:
```json
{ "content_lines": [], "hash_range_inclusive": ["aB3", "xY7"], "path": "src/server.ts" }
```

4. Append after the last line (include the old last line so the new line is added after it):
```json
{ "content_lines": ["old last line", "new line"], "hash_range_inclusive": ["ZPM", "ZPM"], "path": "src/main.ts" }
```

5. Seed content into an empty file (replace the single empty-line hash returned by read):
```json
{ "content_lines": ["first line", "second line"], "hash_range_inclusive": ["aB3", "aB3"], "path": "src/main.ts" }
```

⚠️ Common mistake: do not copy the `HASH│` prefix into `content_lines`.

Wrong:
```json
{ "hash_range_inclusive": ["F4T", "F4T"], "content_lines": ["F4T│import { x } from \"./x\";"] }
```

Right:
```json
{ "hash_range_inclusive": ["F4T", "F4T"], "content_lines": ["import { x } from \"./x\";"] }
```

`hash_range_inclusive` uses the hash anchor. `content_lines` uses literal file content only — the same text that appears after the `│` in `read` output.

⚠️ Common mistake: `hash_range_inclusive` is only the 3-character HASH, not the full `HASH│content` line.

Wrong:
```json
{ "hash_range_inclusive": ["F4T│import { x } from \"./x\";", "F4T│import { x } from \"./x\";"], "content_lines": [...] }
```

Right:
```json
{ "hash_range_inclusive": ["F4T", "F4T"], "content_lines": [...] }
```

Rules:
- `hash_range_inclusive` is a pair `[start, end]`. A single-line replace is `hash_range_inclusive: ["X", "X"]`.
- To delete a range, use `content_lines: []`.
- `hash_range_inclusive` elements are HASH anchors only (e.g. `aB3`). Do not include `│` or line content.
- `content_lines` is literal file content — each string becomes exactly one line in the file. No `HASH│` prefix. A line that happens to start with `+` or `-` is written as-is; the only rejected form is the diff preview's `+HASH│…` row (see `[E_INVALID_PATCH]`).
- **Preserve leading whitespace (indentation) exactly.** The content after `│` in read output includes all leading spaces and tabs — copy them into `content_lines` unchanged. Dropping indentation will produce broken code.
- Don't add `""` for spacing unless you actually want a new blank line.
- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
- If `content_lines` matches current content, the replace is classified as `noop` (file unchanged).
- The `hash_range_inclusive` is inclusive — the entire span from the first anchor through the second anchor is deleted and replaced with `content_lines`. The old lines in that span are gone. If your replacement content includes lines that already exist in the file (e.g. closing brackets), make sure those lines are within your range, otherwise they will appear twice.
- `hash_range_inclusive` and `content_lines` must be native JSON values, not JSON strings. Do not serialize them — pass them as a proper array and array of strings respectively.
On success, the response text shows the line change summary (e.g. "Added 3 line(s), removed 1 line(s).") plus any warnings if present. {{AUTO_READ_GUIDANCE}}

⚠️ Common mistake: `hash_range_inclusive` replaces the ENTIRE range. Every line from the first anchor through the second anchor is deleted and replaced with `content_lines`. Do not include "context" or "surrounding" lines in `content_lines` — they are outside the range and will be preserved automatically.

Wrong: To replace lines 2-3 in this function:
```
function greet() {
  const x = 1;
  return x;
}
```
A model might write:
```json
{ "hash_range_inclusive": ["X", "Y"], "content_lines": ["  const y = 2;", "  return y;", "}"] }
```
This produces `function greet() {\n  const y = 2;\n  return y;\n}\n}` — the `}` appears twice because it was already on line 4 (outside the range) AND in `content_lines`.

Right: Only include the new lines that belong in the range:
```json
{ "hash_range_inclusive": ["X", "Y"], "content_lines": ["  const y = 2;", "  return y;"] }
```
The `}` on line 4 is outside the range and stays in place.

Error recovery:
- `[E_STALE_ANCHOR]` — the anchored line's content changed since the last read. Call `read` to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into `hash_range_inclusive` and retry. (Staleness is per-line: editing or appending lines does not invalidate anchors for lines whose content is unchanged, so anchors for untouched regions stay valid across edits.)
- `[E_BAD_REF]` — malformed HASH. Re-read and try again.
- `[E_BAD_OP]` — invalid operation (e.g. start line > end line).
- `[E_BAD_SHAPE]` — malformed request or change item (missing fields, wrong types, unknown fields).
- `[E_LEGACY_SHAPE]` — old `oldText`/`newText` or `old_text`/`new_text` format detected. Use `{hash_range_inclusive, content_lines}` instead.
- `[E_AMBIGUOUS_ANCHOR]` — hash collision. Call `read` to get fresh anchors.
- `[E_BARE_HASH_PREFIX]` — a `content_lines` entry starts with `HASH│`. Remove the hash prefix; keep only the literal line content that appears after `│` in `read` output. `hash_range_inclusive` uses hashes, `content_lines` does not.
- `[E_INVALID_PATCH]` — a `content_lines` entry matches the diff preview's `+HASH│…` addition-row form. Use literal file content. (Plain `+`/`-` lines are not rejected — they are written literally.)
- `[E_WOULD_EMPTY]` — edit would empty a non-empty file.
- `[E_FILE_TOO_LARGE]` — file exceeds the 1,000,000-line edit limit. Use `write` or a non-line-based approach for very large files.

**Undo:** If a replace produced incorrect results, call `undo_last_replace` with the file path to revert the last replace. The tool reports how many lines were removed and restored. After undoing, call `read` to get fresh anchors for a corrected replace.
