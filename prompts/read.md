Read a text file. Each line is returned as `HASH│content`.

Key rule: line numbers are NOT part of the output. Use the 3-char HASH to reference lines in replace calls. A HASH may change when the line content changes.

HASH format:
- The HASH is 3 characters from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3`, `4yN`, `-qk`).
- The content after the `│` separator is the line verbatim.
- The line number is not part of the output. Use the HASH to reference lines.

Pagination:
- Large files return a truncated preview with a pagination hint (e.g. `[Showing lines 1-100 of 500. Use offset=101 to continue.]`). Call `read` again with `offset=N` to continue.
- Default cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}; output exceeding either is truncated. Pass `limit` to read fewer lines.

File kinds:
- Text files are returned as `HASH│content` lines.
- Images (JPEG, PNG, GIF, WebP) are returned as visual attachments.
- Binary files and directories are rejected with a descriptive error.
- Empty files are returned as a single empty-line hash (`HASH│`). Use replace on that hash to insert content.

Non-UTF-8 bytes:
- UTF-8 byte-order marks (BOM) are stripped. Editing a file with a BOM rewrites it without the BOM.