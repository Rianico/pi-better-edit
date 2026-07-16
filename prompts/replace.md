Replace lines in a text file using HASH anchors from `read`.{{MODE_DESCRIPTION}}

Examples:
{{MODE_EXAMPLES}}

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
{{CL_SERIALIZE_WRONG}}

Right:
```json
{{CL_SERIALIZE_RIGHT}}

`content_lines` must be a native JSON array of strings, not a string that looks like an array. Pass it as a proper JSON array value.

Rules:
- `hash_range_inclusive` is a pair `[start, end]`. A single-line replace is `hash_range_inclusive: ["X", "X"]`.
- To delete a range, use `content_lines: []`.
- `hash_range_inclusive` elements are HASH anchors only (e.g. `aB3`). Do not include `│` or line content.
- `content_lines` is literal file content — each string becomes exactly one line in the file. No `HASH│` prefix. A line that happens to start with `+` or `-` is written as-is; the only rejected form is the diff preview's `+HASH│…` row (see `[E_INVALID_PATCH]`).
- **Preserve leading whitespace (indentation) exactly.** The content after `│` in read output includes all leading spaces and tabs — copy them into `content_lines` unchanged. Dropping indentation will produce broken code.
- Don't add `""` for spacing unless you actually want a new blank line.
{{MODE_RULES_MID1}}- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
{{MODE_RULES_MID2}}- If `content_lines` matches current content, the replace is classified as `noop` (file unchanged).
{{MODE_RULES_END}}On success, the response text shows the line change summary (e.g. "Added 3 line(s), removed 1 line(s).") plus any warnings if present. {{AUTO_READ_GUIDANCE}}

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