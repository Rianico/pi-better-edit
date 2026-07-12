Replace lines in a text file using HASH anchors from `read`. Only one edit per call (no bulk `changes` array — `hash_range_inclusive` and `content_lines` sit at the top level).

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

⚠️ Common mistake: do not copy the `HASH│` prefix into `content_lines`.

Wrong:
```json
{ "content_lines": ["F4T│import { x } from \"./x\";"], "hash_range_inclusive": ["F4T", "F4T"] }

Right:
```json
{ "content_lines": ["import { x } from \"./x\";"], "hash_range_inclusive": ["F4T", "F4T"] }

`hash_range_inclusive` uses the hash anchor. `content_lines` uses literal file content only — the same text that appears after the `│` in `read` output.

⚠️ Common mistake: `hash_range_inclusive` is only the 3-character HASH, not the full `HASH│content` line.

Wrong:
```json
{ "content_lines": [...], "hash_range_inclusive": ["F4T│import { x } from \"./x\";", "F4T│import { x } from \"./x\";"] }

Right:
```json
{ "content_lines": [...], "hash_range_inclusive": ["F4T", "F4T"] }

⚠️ Common mistake: do not serialize `content_lines` as a JSON string.

Wrong:
```json
{ "content_lines": "[\"line1\", \"line2\"]", "hash_range_inclusive": ["F4T", "F4T"], "path": "src/main.ts" }

Right:
```json
{ "content_lines": ["line1", "line2"], "hash_range_inclusive": ["F4T", "F4T"], "path": "src/main.ts" }

`content_lines` must be a native JSON array of strings, not a string that looks like an array. Pass it as a proper JSON array value.

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
{ "content_lines": ["  const y = 2;", "  return y;", "}"], "hash_range_inclusive": ["X", "Y"] }
This produces `function greet() {\n  const y = 2;\n  return y;\n}\n}` — the `}` appears twice because it was already on line 4 (outside the range) AND in `content_lines`.

Right: Only include the new lines that belong in the range:
```json
{ "content_lines": ["  const y = 2;", "  return y;"], "hash_range_inclusive": ["X", "Y"] }
The `}` on line 4 is outside the range and stays in place.

**Undo:** If a replace produced incorrect results, call `undo_last_replace` with the file path to revert the last replace. The tool reports how many lines were removed and restored. After undoing, call `read` to get fresh anchors for a corrected replace.
