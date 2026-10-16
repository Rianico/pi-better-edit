# ADR-0039 — Compound bash view interception and sequential peeling

Date: 2026-10-16

## Status

accepted — council consensus (`feat/bash-view`), operator grill Q1–Q9. Extends ADR-0033 and supersedes its single-statement and single-`cd` restrictions for compound bash scripts.

## Context

ADR-0033 introduced AST-guarded bash view interception for single-file views and searches, but strictly constrained the admitted command grammar:
- Only `&&`-chains with exactly one `view` or `search` segment were admitted.
- Any compound scripts using `;` or newlines (except `;`-separated silent-prefix chains admitted under commit `7b78278`), multiple `cd` commands, or mixing views with echo/diagnostic outputs failed closed to pass-through.
- Slicing tools (`head`/`tail`) were admitted for view pipelines (`cat file | head -n 10`), but not for search pipelines (`grep PATTERN file | head -n 10`).

In practice, agents frequently generate compound bash commands:
1. Redundant `cd` prefixes: `cd /path/to/cwd && echo "=== header ==="; grep -n "pat" file | head -3; grep -n "pat2" file | head -5` where `/path/to/cwd` is already the session cwd.
2. Pipelined searches: combining `grep` or `rg` with `head -N` or `tail -N` to inspect top matches.
3. Batch diagnostics: grouping multiple file inspections separated by `;` or `&&` with literal banner echoes.

Because ADR-0033 treated any non-view output or multiple view statements as `unsafe`, these compound calls passed through raw without anchors, leading to subsequent `E_UNKNOWN_ANCHOR` errors and wasted re-read round trips.

## Decisions

### 1. Deterministic Sequential Slicing (Sequential Peeling)
Compound scripts (`cmd1; cmd2; cmd3` or `cmd1 && cmd2`) emit a single combined `stdout` stream. Rather than injecting synthetic runtime boundary markers or sentinels (e.g. `printf "\0__MARKER__\0"`) into the command AST at `tool_call`—which risks altering `$?` / `$PIPESTATUS`, disrupting processes sensitive to stdout boundaries, and leaking synthetic tokens on failure—the interceptor uses deterministic sequential slicing. Each expected output segment is parsed, verified against disk snapshots, and peeled left-to-right from the combined stdout stream using exact line-count and byte-length accounting.

### 2. Hybrid Output Envelope
Replacement remains wholesale post-execution. When a compound script contains both admitted view/search statements and unintercepted statements (e.g. literal banner echoes or trailing unadmitted commands), the return value replaces raw stdout with a structured hybrid envelope. Unintercepted stdout lines are preserved verbatim in their relative sequential positions, while admitted view and search blocks are rendered under their respective anchored headers (`--- Bash view (hashline anchors) ---` / `--- Bash search (hashline anchors) ---`). Non-view outputs are never discarded.

### 3. Pipelined Search Admission with Slice Ops
Commands piping an admitted search into `head` or `tail` (e.g. `grep [-n] PATTERN FILE | head -N`) are admitted as `pureSearch` with attached `SliceOp`s. Because `head` and `tail` perform pure line-count truncations without mutating line content or relative line numbering, the slice operations are evaluated directly against the resolved `ServedRow[]` array. Granted leases cover only the surviving rows shown in the output.

### 4. Left-to-Right Peeling until First Unknown/Unverified Block
If an intermediate statement in a compound script fails verification (e.g. disk mismatch, dynamic stdout length, or unexpected command failure), peeling halts at that statement. Any prior statements that have already been deterministically verified against disk retain their granted leases and anchored rendering. The failing statement and all remaining stdout are emitted as unanchored raw text. Because anchored rows explicitly carry `HASH│` delimiters and bracketed headers, partial lease granting introduces no ambiguity for the model.

### 5. Multi-Statement AST Injection in `tool_call`
`withSearchLineNumbers` traverses every statement in the parsed `unbash` AST. For every admitted search command across the compound script, it injects `-n` / `--line-number` at `node.name.end`. Multi-statement scripts with unnumbered searches are thus rewritten in a single pass before execution.

### 6. Admissible Static Glue Segments
Non-view statements that emit statically predictable stdout—specifically literal `echo "<literal>"` and `printf "<literal>\n"` without dynamic expansions (`$VAR`, `$(...)`, `*`, backticks)—along with silent environment/shell commands (`export VAR=val`, `set -e`, `set +e`), are admitted as static glue segments. Their expected output length and content are computed at parse time and verified during sequential peeling. Statements with dynamic expansions are not admitted as static glue and cause peeling to halt.

### 7. Redundant `cd` AST Normalization
A `cd <path>` command that resolves to the current effective working directory (`resolve(cdPath, effCwd) === effCwd`) is classified as an inert silent no-op (identical to `:` or `true`). Redundant `cd`s do not count towards the single-`cd` limit and do not trip pass-through rules for multi-`cd` or post-view-`cd` chains.

### 8. Sequential Working Directory Tracking
The classifier maintains an `effCwd` state across statements in a compound script. When an admitted non-redundant `cd <target>` executes, `effCwd` updates to `toCwd(target, effCwd)`. Subsequent statements resolve relative paths against the active `effCwd` at their position in the sequence.

### 9. Path Comparison for Redundant `cd`
Path equivalence for `cd` statements is checked lexically first (`path.resolve(effCwd, target) === effCwd`). If lexical comparison does not match, it falls back to `fs.realpath` to detect symlink equivalence without incurring unnecessary I/O on common lexical matches.

## Consequences

- Compound scripts mixing literal banner echoes, redundant `cd`s, and multiple view/search commands (e.g. `grep | head`) are now intercepted and anchored, significantly reducing re-read round trips in agent workflows.
- Zero runtime sentinel injection preserves pristine shell execution semantics and exit statuses.
- Wholesale hybrid envelopes preserve operator and model visibility for non-view outputs while delivering valid leases for viewed and searched spans.
- Partial peeling ensures robust degradation: a failure or unadmitted command mid-script does not invalidate leases for previously verified blocks.
