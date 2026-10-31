# ADR-0049 — Multi-file bash views: per-file pages, line-count boundaries, and an evidence gate

Date: 2026-10-26

## Status

accepted — implemented by #183. M7's evidence gate is met (a real-workload capture of plain `cat`
over two or more files, plus the synthetic fixture matrix and its review), so multi-file views are
admitted for the M1 shape only. The deferrals this record recorded (no composition in a compound,
no byte-length boundaries, no root banner) are unchanged.

Extends [ADR-0048](0048-bash-serve-admission-display-context-compound.md) D5 and inherits
[ADR-0033](0033-bash-view-interception.md) D9/D10 and [ADR-0039](0039-compound-bash-view-interception.md)
D10. ADR-0033 D7's multi-file view non-goal remains in force until this record is accepted for
implementation.

Amended 2026-10-27 (Issue #183): implemented. The admitted surface is exactly M1's four shapes, the
serve seam proves M3's line-count boundaries per file and renders M2's page sections, M4's zero-row
page is emitted only inside an otherwise served result, M5's ranges span operands, M6's caps resolve
from `bash.multiFile.{maxFiles,maxRows}` through the project/global ladder, and M8's whole-command
fail-closed rule gates every serve. Implementation notes, each fail-closed:

- **Numbering (M3).** GNU `cat -n`/`nl` number the STREAM continuously; BSD `cat -n` restarts in each
  file and BSD `nl` refuses multiple operands (a non-zero exit, so it never serves). The seam admits
  both closed renderings because both are pure functions of the line counts — the observed bytes pick
  which ran, and a stream matching neither passes through (`test/tools/bash-multifile-view.test.ts`).
- **Zero-row pages (M4).** The page is literally `(0 lines total)`, as this record prescribes, for
  both an empty file and a file whose lines were not selected; it never claims the file's length.
- **BOM (M3/D9).** `stripBOM` is stream-leading, so a BOM on the FIRST operand is normalized away and
  a BOM on a later operand leaves a byte the line-count proof cannot place — that command passes
  through rather than serving normalized rows the shell did not print.
- **Compound (M1).** A multi-file view never rides in a chain; a chained shape declines with the
  existing `multi-view` reason, so the closed reason vocabulary gains nothing.
- **Caps (M6).** The classifier admits any operand count (it is pure and zero-fs); the serve seam
  enforces the configured file and row caps, so the bound is operator policy and not a parse rule.

## Context

ADR-0048 D5 deferred multi-file views. The safe subset was identified — `cat`, `cat -n`, `nl -ba`,
and `sed -n` over two or more newline-terminated text files — but the multi-block serve seam,
per-file leases, boundary proof, and page chrome were left to a follow-up ADR. The four-run corpus
has zero standalone multi-file views, so the deferral claims no benchmark gain.

The current single-file seams already serve one page per view with the page header
`[Bash view: <file> (<range>)]`; the retired `---` banner is not part of the current chrome. The
two-sided serve invariant (ADR-0048 D1) requires every served block to be byte-identical to its
re-read file slice and to occupy a disjoint, ordered interval of observed stdout. This ADR resolves
the multi-file seam without weakening that invariant.

## Decision

### M1. Admitted shape

Admit a **standalone multi-file view** over two or more newline-terminated text files:

- `cat FILE...` (no flags),
- `cat -n FILE...`,
- `nl -ba FILE...`,
- `sed -n` with numeric print ranges over `FILE...`.

Exclude `head`/`tail` with multiple files: their `==> FILE <==` headers are not file bytes and are
implementation-dependent. Exclude stdin (`-`), redirects, pipelines, prefixes, display transforms,
binary files, non-newline-terminated files, and any non-literal operand. The command remains a
single view; this ADR does not compose multi-file views as blocks inside a compound chain.

### M2. One result, one page section per file

A served multi-file view is **one result text** containing one page section per file, in operand
order. Each section carries the existing page header shape:

```text
[Bash view: a.txt (2 lines total)]
a1B2│alpha
c3D4│beta
[Bash view: b.txt (2 lines total)]
e5F6│gamma
g7H8│delta
```

The page header is chrome, not observed stdout. The rows are the raw re-read lines with the usual
four-character anchors. There is **no new root banner** and no restored `---` banner: a view is N
pages, and the per-file header is the page's identity. This preserves the single-file/multi-file
unification and avoids a second chrome dialect.

Leases keep the existing `(session, path, anchor)` identity. There is no multi-file lease and no
cross-file anchor: every row is leased under its own file. An empty page leases nothing.

### M3. Boundaries are line counts

For all four admitted shapes, prove boundaries from **line counts**, not content matching:

- Read every operand as newline-terminated text; count its lines.
- Lay the operands end to end in stream order. A file's interval is
  `[sum(previous line counts) + 1, sum(previous line counts) + file.lineCount]`.
- `cat` and `sed -n` are line-oriented: the selected rows map back to file lines by subtracting the
  preceding line count.
- `cat -n` and `nl -ba` add a numbering transform. The numbering is continuous across the stream;
  file N starts at `sum(previous line counts) + 1`. The served rows are the raw re-read lines; the
  transform oracle checks the numbered observed interval, never the content.
- A missing trailing newline, binary decode, ambiguous numbering, or any mismatch passes the whole
  command through with zero leases. No partial pages.

Byte lengths are rejected as a second boundary primitive: the stream is line-oriented, anchors and
leases are line-based, and a byte path would add arithmetic without proving anything line counts do
not.

### M4. Zero-row pages

A file with no selected or output lines contributes a zero-row page only when:

1. the command is a multi-file view, and
2. at least one other file contributes at least one row.

The page is `[Bash view: <file> (0 lines total)]`; it has no rows, no anchors, and no leases. Its
observed interval is zero-length, so it does not weaken the two-sided invariant.

The rule deliberately does **not** change single-file behaviour: `cat empty.txt` remains raw, as
pinned by the existing A9 test. An all-empty multi-file command also remains raw, because serving
only synthetic headers would produce no observed output and no leases.

### M5. Cross-file `sed -n` ranges

Numeric ranges may cross file boundaries. A range that selects stream lines 2–4 over `a`=2 lines and
`b`=2 lines selects `a:2` and `b:1–2`; the result is page sections for both files in operand order,
with file-relative page headers:

```text
[Bash view: a.txt (lines 2-2 of 2 total)]
i9J0│beta
[Bash view: b.txt (2 lines total)]
e5F6│gamma
g7H8│delta
```

Selected stream lines map to file lines by the cumulative line counts in M3. Files with no
selected lines follow M4. Any unparseable or unprovable range passes the whole command through;
the existing numeric-print grammar remains the closed range surface.

### M6. Caps and configuration

Defaults:

- `bash.multiFile.maxFiles`: **10** (allowed 2–10)
- `bash.multiFile.maxRows`: **2,000** total rows (allowed 1–2,000)

The file cap mirrors `BASH_SEARCH_MAX_FILES`; the row cap fits the built-in bash result cap. The
file cap counts every operand, including a zero-row page. The row cap counts served rows, not page
headers. Over either cap → whole command raw, zero leases.

The caps are settings, not hard-coded constants. They resolve through the shared project/global
config ladder under the existing `bash` object:

```json
"bash": {
  "view": "on",
  "multiFile": {
    "maxFiles": 10,
    "maxRows": 2000
  }
}
```

The command surface mirrors the existing `bash-view` subcommand:

```text
/pi-better-edit bash-view multi-file status
/pi-better-edit bash-view multi-file max-files 8 global
/pi-better-edit bash-view multi-file max-rows 1000 project
```

`/pi-better-edit settings` reports the effective values and sources. Arbitrary numeric editing
belongs to the subcommand; the current enum-only `SettingsList` is not forced to accept free text.
Values outside the allowed range are ignored with a warning and fall through the ladder. Lower caps
are allowed; higher caps are not a way to exceed the safety bound.

### M7. Evidence gate

D5 stays design-only until the evidence gate is met:

1. A real workload capture shows multi-file view commands occurring (not necessarily the external
   four-run benchmark; a replay of that corpus would exercise zero multi-file calls).
2. The implementation carries a synthetic fixture matrix covering: two normal files; a zero-row
   file; an all-empty command; `cat -n` and `nl -ba` continuous numbering; a cross-file `sed`
   range; no selected row in one file; binary; no trailing newline; CRLF/BOM; over-cap; and a
   ten-file boundary.
3. A fresh reviewer verifies the two-sided invariant, per-file leases, page headers, empty-page
   rule, and configuration provenance.

No implementation is scheduled by this ADR. The corpus gain remains zero until a real workload
shows demand.

### M8. Failure and attribution

One bad file, page, boundary, transform, or cap fails the **whole command** raw with zero leases.
There is no partial multi-file serve. Every surviving page's rows are byte-verified against the
re-read file slice before the first lease; page headers are never counted as observed bytes; empty
pages have a zero-length interval. The D1 invariant, not content matching, remains the admission
authority.

## Consequences

- Behaviour today (implemented by #183): a standalone multi-file view serves one page section per file
  in operand order and leases every row under its own file. A chained multi-file view, an over-cap
  command, a binary or unterminated operand, and any unprovable boundary still pass through raw.
- Multi-file views add model-facing page sections, zero-row pages, a `bash.multiFile` config subtree,
  a `/pi-better-edit bash-view multi-file …` surface and a new lifecycle seam. Each is covered by the
  M7 fixture matrix.
- Risks: synthetic page headers can be mistaken for file bytes; numbering can confuse file-relative
  line numbers (which is why the served rows are raw lines and only the transform is checked); `sed`
  ranges spanning operands multiply the mapping surface; zero-row pages add chrome without anchors;
  configuration can lower the caps but must not raise the safety bound.
- The current single-file A9 behaviour stays intact; a future decision to align single-file empty
  handling would be a separate change, not a side effect of D5.

## Alternatives considered

- **Root banner for multi-file views.** Rejected: it duplicates the page label and reintroduces the
  chrome dialect removed by #173.
- **Byte-length boundaries.** Rejected: the stream is line-oriented and anchors/leases are
  line-based; line counts are the single proof path.
- **Omit zero-row pages.** Rejected: the model would not know which files were considered; the
  empty page is cheap and carries no lease.
- **Reject cross-file `sed` ranges.** Rejected: line counts already map them; rejecting would make
  the admitted `sed` surface arbitrary.
- **Synthetic-only promotion.** Rejected: the corpus has zero multi-file demand; synthetic tests
  prove correctness, not value.
- **Hard-coded 10/2,000 caps.** Rejected: caps are operator policy and follow the existing
  project/global configuration surface.
- **Implement D5 now.** Rejected: no real-workload evidence and no benchmark gain.

## Links

- [ADR-0033 — AST-guarded bash view interception](0033-bash-view-interception.md)
- [ADR-0039 — Compound bash view interception and sequential peeling](0039-compound-bash-view-interception.md)
- [ADR-0048 — Bash serve admission: display tails, context searches, and verified compound chains](0048-bash-serve-admission-display-context-compound.md)
- [Bash interception gaps analysis](../analysis/bash-interception-gaps.md)
- Tracking: #183 (D5, landed — see the amendment above), #176 (D2, deferred), #185 (D4, landed).
