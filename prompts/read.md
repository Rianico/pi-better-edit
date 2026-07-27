Read a text file. Each line returned as HASH│content (3-char URL-safe base64 hash). No line numbers — use the 3-char HASH to reference lines in replace calls.

Text → HASH│content lines. Images → visual attachments. Binary/directory → rejected. Empty → HASH│ (replace to insert). Pageable with offset/limit. BOM stripped; non-UTF-8 shown as U+FFFD.