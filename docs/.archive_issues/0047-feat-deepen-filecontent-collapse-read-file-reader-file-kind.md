# feat: deepen FileContent — collapse read/file-reader/file-kind cluster (C3)

> **Archived from pre-migration issue #47.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-28T17:52:32Z · state CLOSED · labels: ready-for-agent

## Body

Part of architecture review 2026-08-28 (candidate 3 — Worth exploring). Follows #43, #45.

> [!note] Context
> See `CONTEXT.md` (hashline anchors, snapshot cache) and recent lens fix P1–P7 that touched all three together. Base `src/read.ts` (292 LOC) + `src/file-reader.ts` (107) + `src/file-kind.ts` (162) = 561 LOC for one concept.

## Problem
One concept ("prepare file content" — kind detection `text|binary|image` + BOM/UTF-8 + `CRLF→LF` normalization + snapshot `checksum→hashes` + preview `oversize`/`truncation`) scattered across three shallow modules. ==Locality broken== — understand "read" → bounce 3 files; a fix (BOM, encoding, oversize) edits all three. Each module small but collectively spread; interfaces are thin but joint behaviour leaks (callers choose text vs binary path).

Deletion test: deleting `src/file-reader.ts` scatters its 3 fns — no complexity concentrates, pure pass-through.

## Solution
Deepen into `FileContent` — `interface: prepare(path, {offset,limit}) → { kind, normalized, hashes, preview, servedRows }` hiding `file-type` (magic+ext), `decode` (BOM+utf8), `normalize` (CRLF→LF), `snapshot` cache, `oversize` short-circuit inside. Internal seams for `binary|image` vs `text` stay private — callers never choose a path. Keep keel spine small: one new load-bearing seam, `local-substitutable` (file-type, BOM, fs).

> [!tip] Seam discipline
> In-process otherwise; storage is `SnapshotStore` adapter already split (`MemorySnapshotStore` exists). No new external seam beyond `FileContent`.

## Acceptance
- [ ] New `src/file-content/*` (or equivalent) owning detection+decode+normalize+snapshot+preview behind `prepare`/`load` handle
- [ ] `src/file-reader.ts` + `src/file-kind.ts` thinned to graded facades or retired; `src/read.ts` delegates to `FileContent` (thin adapter for pi's `read` tool wiring)
- [ ] `index.ts` auto-read + `edit-pipeline`/`mutation-engine` share one seam (no duplicated `loadFileKindAndText` + `readNormFile` sequencing)
- [ ] Binary/image short-circuit + oversize `DEFAULT_MAX_BYTES`/`AUTO_READ_MAX` handling lives inside, co-located with encoding — one place to fix BOM/CRLF/oversize
- [ ] `npm run typecheck && npm test` green; keep Obsidian `.md` flavour

## Files
`src/read.ts` (292) · `src/file-reader.ts` (107) · `src/file-kind.ts` (162) · `src/hashline/hash-identity.ts` (via `snapshotIO`) · `index.ts` · `src/edit-pipeline.ts`/`src/mutation-engine/*`

Closes-by: squash PR with `Closes #NN`.

