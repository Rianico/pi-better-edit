Replace lines in a text file using HASH anchors from `read`.

Put all operations on one file in a single `replace` call. Stack every region into the `changes` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot.

How to use:

1. Call `read` to get HASH anchors:
```
read({ path: "src/main.ts" })
```

2. Copy the 3-character HASH (before `│`) into `hash_range_incl`:
```json
{ "path": "src/main.ts", "changes": [
  { "hash_range_incl": ["MQX", "MQX"], "content_lines": ["const x = 99;"] }
] }
```

Examples:

1. Single line replace:
```json
{ "path": "src/main.ts", "changes": [
  { "hash_range_incl": ["MQX", "MQX"], "content_lines": ["const x = 1;"] }
] }
```

2. Range replace (3 lines → 3 new lines):
```json
{ "path": "src/main.ts", "changes": [
  { "hash_range_incl": ["ZPM", "VRW"], "content_lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  }
] }
```

3. Multiple regions in one call (delete two non-adjacent ranges):
```json
{ "path": "src/server.ts", "changes": [
  { "hash_range_incl": ["aB3", "xY7"], "content_lines": [] },
  { "hash_range_incl": ["MQX", "ZPM"], "content_lines": [] }
] }
```

4. Append after the last line (include the old last line so the new line is added after it):

```json
{ "path": "src/main.ts", "changes": [
  { "hash_range_incl": ["ZPM", "ZPM"], "content_lines": ["old last line", "new line"] }
] }
```

5. Seed content into an empty file (replace the single empty-line hash returned by read):

```json
{ "path": "src/main.ts", "changes": [
  { "hash_range_incl": ["aB3", "aB3"], "content_lines": ["first line", "second line"] }
] }
```

⚠️ Common mistake: do not copy the `HASH│` prefix into `content_lines`.

Wrong:
```json
{ "hash_range_incl": ["F4T", "F4T"], "content_lines": ["F4T│import { x } from \"./x\";"] }
```

Right:
```json
{ "hash_range_incl": ["F4T", "F4T"], "content_lines": ["import { x } from \"./x\";"] }
```

`hash_range_incl` uses the hash anchor. `content_lines` uses literal file content only — the same text that appears after the `│` in `read` output.

⚠️ Common mistake: `hash_range_incl` is only the 3-character HASH, not the full `HASH│content` line.

Wrong:
```json
{ "hash_range_incl": ["F4T│import { x } from \"./x\";", "F4T│import { x } from \"./x\";"], "content_lines": [...] }
```

Right:
```json
{ "hash_range_incl": ["F4T", "F4T"], "content_lines": [...] }
```

Rules:
- `hash_range_incl` is a pair `[start, end]`. A single-line replace is `hash_range_incl: ["X", "X"].
- To delete a range, use `content_lines: []`.
- `hash_range_incl` elements are HASH anchors only (e.g. `aB3`). Do not include `│` or line content.
- `content_lines` is literal file content — each string becomes exactly one line in the file. No `HASH│` prefix, no `+`/`-` diff markers.
- Don't add `""` for spacing unless you actually want a new blank line.
- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
- All changes in one call must be non-conflicting. The runtime rejects with `[E_EDIT_CONFLICT]` if two ranges overlap.
- If `content_lines` matches current content, the replace is classified as `noop` (file unchanged).
- The `hash_range_incl` is inclusive — both anchors and every line between them are replaced. If your replacement content includes lines that already exist in the file (e.g. closing brackets), make sure those lines are within your range, otherwise they will appear twice.
On success, the response text is empty (or contains only warnings if present). Call `read` to get fresh anchors for follow-up edits.

Error recovery:
- `[E_STALE_ANCHOR]` — file changed since last read. Call `read` to get fresh anchors, then copy the HASH and retry.
- `[E_BAD_REF]` — malformed HASH. Re-read and try again.
- `[E_BAD_OP]` — invalid operation (e.g. start line > end line).
- `[E_BAD_SHAPE]` — malformed request or change item (missing fields, wrong types, unknown fields).
- `[E_LEGACY_SHAPE]` — old `oldText`/`newText` or `old_text`/`new_text` format detected. Use `{hash_range_incl, content_lines}` instead.
- `[E_EDIT_CONFLICT]` — two changes overlap on the same line range. Make changes non-overlapping.
- `[E_AMBIGUOUS_ANCHOR]` — hash collision. Call `read` to get fresh anchors.
- `[E_BARE_HASH_PREFIX]` — a `content_lines` entry starts with `HASH│`. Remove the hash prefix; keep only the literal line content that appears after `│` in `read` output. `hash_range_incl` uses hashes, `content_lines` does not.
- `[E_INVALID_PATCH]` — diff prefixes (`+`/`-`) in `content_lines`. Use literal content only.
- `[E_WOULD_EMPTY]` — edit would empty a non-empty file.