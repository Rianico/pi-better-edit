# 0006. AST-Guarded Bash View Interception, Compound Peeling, and Multi-File Views

Date: 2026-10-30

## Status

Accepted

## Context

Coding agents frequently inspect files using shell commands in the `bash` tool (`cat`, `head`, `tail`, `sed -n`) rather than invoking the dedicated `read` tool. Raw bash command execution emits unanchored text, leaving the model without the 4-character presentation anchors and session leases required by `edit`. Consequently, the agent is forced to perform a redundant follow-up `read` call before editing, wasting an entire interaction turn and duplicating context tokens ([`docs/.archive_adrs/0033-bash-view-interception.md`](../.archive_adrs/0033-bash-view-interception.md)).

Earlier naive approaches had severe limitations:
1. **Output Appending**: Appending an anchored read block after raw command execution doubled context token usage.
2. **Regex Parsing**: Attempting to identify read commands with regular expressions broke on shell quoting, redirects, subshells, and command flags.
3. **Compound Command Failure**: Agents routinely combine commands (e.g. `cd src && head -n 50 index.ts`); failing to support compound commands forced agents back to manual workflows ([`docs/.archive_adrs/0039-compound-bash-view-interception.md`](../.archive_adrs/0039-compound-bash-view-interception.md)).

## Decision

We will intercept bash tool calls using the `unbash` AST parser (v5) to detect provably pure view operations, replacing plain output with anchored slice previews, recording session leases, and enforcing a byte-level verification gate.

1. **AST-Guarded Pure View Detection**:
   - Commands are parsed into ASTs via `unbash`.
   - A pipeline is classified as a pure view if it targets readable files using sanctioned view utilities (`cat`, `head`, `tail`, `sed -n`, `nl`), display transforms (`cat -A`/`-vet`, `od -c`, `xxd`, `hexdump -C`), search inspection (`grep`/`rg`, tagged with `[Bash search (anchors)]`), or directory listings (`rg --files`/`ls`, tagged with `[Bash file list (no anchors)]`), without file mutation, output redirection, or arbitrary subshells ([`docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md`](../.archive_adrs/0048-bash-serve-admission-display-context-compound.md), [`docs/.archive_adrs/0049-multi-file-bash-views.md`](../.archive_adrs/0049-multi-file-bash-views.md)).
   - Pipelines are capped at `BASH_VIEW_MAX_PIPELINE_STAGES = 4` and chains at `BASH_VIEW_MAX_CHAIN_SEGMENTS = 8`. Any unknown or mutating command passes through untouched.
2. **Byte-Level Verification Gate & View Replacement**:
   - The anchored page replaces stdout only when captured command stdout byte-matches the re-read disk slice; any mismatch fails closed and passes through untouched.
   - For verified views, output is replaced under the bracketed page header `[Bash view: <file> (<N> lines total | lines A-B of <N> total)]`.
   - Viewed lines are assigned 4-character anchors and leased in `served_leases` for the active session, enabling immediate editing.
3. **Sequential Peeling of Compound Chains**:
   - Chains joined by `&&` or `;` undergo sequential peeling.
   - Silent statements (e.g. `cd <dir>`, `true`, `:`) and static glue segments (literal `printf`, `echo`, `export`, `set`) are peeled from stdout, isolating the inner view segment.
4. **Multi-File View Support**:
   - Multi-file commands (`cat file1 file2`) emit per-file pages up to line admission bounds, registering independent leases for each file ([`docs/.archive_adrs/0049-multi-file-bash-views.md`](../.archive_adrs/0049-multi-file-bash-views.md)).

### Considered Options

- **Appending anchored reads to bash output** — rejected on the context-budget boundary: duplicates file lines in context and burns generation tokens.
- **Regex-based command interception** — rejected: brittle against shell metacharacters, variable expansions, and quotes.
- **Interception of arbitrary shell output** — rejected: fails closed; modifying output of commands with side effects risks breaking agent reasoning.

## Consequences

- Agents seamlessly transition from terminal file inspection to hash-anchored editing without follow-up `read` calls.
- Pure AST verification and byte-level matching ensure non-view shell commands execute completely unmodified.
- Eliminates context bloat by swapping raw output rather than appending duplicate blocks.
