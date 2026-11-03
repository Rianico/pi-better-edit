# Selection-range note replay and acceptance gate

Ticket #243, replacing the read-expansion replay of ticket #205. The replay measures the
selection-range note over the pi session JSONL already on disk: how often a served read carried a
note and from which provider source, and whether the same-file re-read share moved against a
pre-change corpus. It adds no log format and no runtime dependency.

## Command

```bash
pnpm run replay
```

The one command. Without flags it measures the default corpus (`$PI_CODING_AGENT_DIR/sessions`,
falling back to `~/.pi/agent/sessions`) and reports no movement, because no baseline was named.

Options:

- `--candidate <dir>` — the corpus to measure, normally recorded with the note installed. Defaults
  to the session root above.
- `--baseline <dir>` — the corpus recorded before the note. Omit it and the movement is reported as
  `unmeasured`; it is never reported as a zero.
- `--limit-sessions <n>` — the newest N session files per corpus (default 400).
- `--json` — print the machine-readable report only. `--out <path>` also writes it to a file.

pnpm forwards unknown flags to the script, so the flags go after the script name without a `--`
separator: `pnpm run replay --limit-sessions 4000 --json`.

Exit codes:

- `0` — measured; the report is on stdout.
- `1` — at least one served note named a span that is not strictly larger than its own window. The
  count and a bounded sample of the offenders are in `candidate.notes`.
- `2` — an argument or corpus error: an absent corpus, a path that is not a directory, or a corpus
  with no `.jsonl` sessions. The message names the path; an empty sample never passes.

## Note evidence

Only a **served-mode** read can carry a note, and only its header carries one. The replay reads the
clause back out of the header the model saw — it does not re-run the decision layer, so the gate
cannot drift from the shipped note. A quoted clause inside an assistant message, and a note-shaped
line in a served body behind an anchor, are both ignored.

`notes.fires` counts clauses; `notes.readsWithNote` counts reads; `notes.fireShare` is
`fires / totals.reads`. A multi-window page keys the note to its span, so one read may carry more
than one clause.

`notes.bySource` attributes each clause to the source that answered it, read back from the label the
clause prints:

| Label shape | Source |
|---|---|
| `paragraph` | `text` |
| `section "<title>"` | `md` |
| every other kind (`function`, `class`, `arrow`, …) | `ast` |

Shell answers travel the AST provider, so they land in `ast`. `lsp` is enrichment only and never a
source of a note, so it cannot appear.

**Correctness rule.** A note is legal only when its span covers its served window and is strictly
larger than it: `span.start <= window.start && span.end >= window.end && (span.start < window.start
|| span.end > window.end)`. A whole-file page is normalised to the range it covers, so a note on one
is a violation by construction. `notes.violationCount` is the authority; `notes.violations` is a
bounded sample of 20.

## Re-read metric and movement

- **Same-file re-read share** — among a corpus's served reads, the share followed by another
  successful read of the same canonical path within the next three tool calls. The window is the
  three tool calls immediately after the source read; other tools count toward it. The numerator
  counts any successful later `read` of the same path, so a served read followed by a verbatim read
  still counts; only denominator reads are served-mode.
- Languages come from file extensions (`.ts`/`.tsx` → `typescript`, `.py` → `python`, `.md` →
  `markdown`, `.txt` → `text`, `.sh`/`.bash`/`.zsh` → `shell`, and so on). Unknown extensions are
  reported as `unknown`.

`reRead` compares the two corpora and reports the numbers, not just a verdict: `baselineReads`,
`candidateReads`, both shares, `delta`, `relativeChange`, the pooled share, `standardError`,
`noiseBand`, `z`, and `withinNoise`.

**Noise rule.** The movement is tested as a two-proportion difference at 95%: a delta smaller than
`1.96` standard errors of the difference is reported as `inside-noise`, and only a delta beyond that
band is reported as `candidate-lower` or `candidate-higher`. The band is printed with the movement,
so a reader can see what the corpus could have detected. `attribution` states what the delta may be
blamed on: `note` (the baseline carries no clause and the candidate does), `none` (the candidate
carries no clause, so the note cannot explain anything), or `mixed` (both carry clauses).

Three shapes are reported as `unmeasured` instead of as a zero:

- no `--baseline` was named;
- baseline and candidate resolve to the same corpus, where any delta is zero by construction;
- one side has no served-mode reads.

## Measurement

Measured on 2026-11-02 on the operator host, pi session corpus `~/.pi/agent/sessions`. The sample
is the newest N session files, so the counts drift by a few reads and the shares by a tenth of a
point as sessions accumulate; the figures below are one run at that time.

Default command, `pnpm run replay`:

```text
candidate: ~/.pi/agent/sessions (400 sessions, 2289 served reads)
notes: 0 clause(s) on 0 read(s) of 2289 served reads (0.0%)
  ast 0  md 0  text 0  violations 0
re-read: n/a (0 reads) -> 18.5% (2289 reads)
  unmeasured (attribution: unknown) — no baseline corpus named
```

Whole corpus, `pnpm run replay --limit-sessions 4000`:

```text
candidate: ~/.pi/agent/sessions (3122 sessions, 31185 served reads)
notes: 0 clause(s) on 0 read(s) of 31185 served reads (0.0%)
  ast 0  md 0  text 0  violations 0
re-read: n/a (0 reads) -> 21.9% (31185 reads)
  unmeasured (attribution: unknown) — no baseline corpus named
```

What these numbers say, and what they do not:

- **The note has never fired in a recorded session on this host.** Zero clauses over 31,185 served
  reads in 3,122 sessions. This is not a parse blind spot on a different header shape: the same 400
  session sample holds 6,869 served read headers, and not one contains a `; in ` clause.
- **The absence is the treatment's, not the effect's.** The installed build is 2.16.0, whose dist
  predates the note, so no read could have carried one. A zero fire count is therefore evidence of
  no exposure, never evidence of no effect.
- **The movement is unmeasured, for the same reason.** No recorded corpus carries the note, so there
  is no candidate side to compare and nothing to attribute. Nothing in this document claims the note
  changes behaviour.
- **The noise floor at this corpus size**, computed from the observed shares for a pair of corpora
  this size: about ±2.3 pp at 2,289 reads per side and about ±0.7 pp at 31,185 reads per side. A
  future movement smaller than that is churn, however it is produced.

To obtain the missing measurement, record a `--candidate` corpus on a host running a build that
carries the note, keep a `--baseline` corpus recorded before that build was installed, and run:

```bash
pnpm run replay --limit-sessions 4000 --baseline <pre-note-dir> --candidate <note-dir> --json
```

`candidate.notes.fires` states the exposure, `reRead` states the movement and whether it clears the
band, and `reRead.attribution` states whether the note can be blamed for it. Cite those three
together.

## Refusal vocabulary

`selection-range.log` uses one `reason` code per refused attempt. The audit sink's module comment points here; `REFUSAL_REASONS` in `src/read-expansion/provider-contract.ts` is the code authority.
| Reason | Meaning | Extra fields |
|---|---|---|
| `above_trigger` | The folded window is larger than 24 lines, so expansion never starts. | — |
| `past_eof` | The requested offset is beyond the visible line count. | — |
| `not_text` | The file loaded as something other than text, so no boundary can be read. | — |
| `toggle_off` | `read.selectionRange` resolved to `off`; the read is exact and provider work is skipped. Recorded once per session. | — |
| `no_provider` | No expansion provider covers this file type (data extension or unsupported grammar). | — |
| `boundary_crossing` | The window crosses a structural boundary or no single boundary contains it (two paragraphs, Setext/unclosed Markdown, no enclosing scope). | `language` for code |
| `grammar_unavailable` | Permanent grammar failure: manifest missing, offline, corrupt bytes or unloadable wasm. | `language` |
| `cold_grammar` | A grammar fetch started but did not finish inside the read budget; the fetch continues, so the next read can widen. | `language` |
| `runtime_absent` | The optional `web-tree-sitter` module is unresolvable. Recorded once per session. | `language` |
| `provider_declined` | Genuinely unclassified decline, such as unreadable text or a source tree with syntax errors. | `language` when known |
| `provider_error` | The provider threw; the read stays exact. | — |
| `invalid_answer` | The provider returned a malformed span. | — |
| `not_superset` | The provider's span did not cover the requested window. | `section` |
| `over_cap` | The code or plain-text block exceeds its cap and is refused, never clamped. | `blockSize`, `section` |

`selection-range.log` also carries the first-entry `rung` for the resolved configuration source. The read budget is 250 ms; `cold_grammar` is transient, while `grammar_unavailable` and `runtime_absent` are permanent for the session unless the host changes.

## Machine-readable fields

The JSON report carries `schemaVersion` (2), `generatedAt`, `options` (`baselineRoot`,
`candidateRoot`, `limitSessions`, `noiseZ`), the two corpora, and `reRead`.

Each corpus has `source`, `sessions`, `parseErrors`, `totals`, `byLanguage`, and `notes`:

```json
{
  "source": "/home/me/.pi/agent/sessions",
  "sessions": 400,
  "parseErrors": 0,
  "totals": { "reads": 2289, "reReads": 424, "reReadShare": 0.1852 },
  "byLanguage": {
    "typescript": { "reads": 1210, "reReads": 190, "reReadShare": 0.157 }
  },
  "notes": {
    "fires": 0,
    "readsWithNote": 0,
    "fireShare": 0,
    "bySource": { "ast": 0, "md": 0, "text": 0 },
    "violationCount": 0,
    "violations": []
  }
}
```

`reRead` carries the comparison:

```json
{
  "baselineReads": 2190,
  "candidateReads": 2289,
  "baselineShare": 0.1904,
  "candidateShare": 0.1852,
  "delta": -0.0052,
  "relativeChange": -0.0273,
  "pooledShare": 0.1878,
  "standardError": 0.0116,
  "noiseBand": 0.0228,
  "z": -0.4483,
  "withinNoise": true,
  "attribution": "note",
  "verdict": "inside-noise",
  "reason": "-0.5 pp over 2190 -> 2289 served reads is inside the 95% band of +-2.3 pp"
}
```

The numbers above are illustrative shapes, not a measurement; the only measurement this document
holds is the one recorded in **Measurement**.

Useful checks:

```bash
jq '.candidate.notes' replay.json
jq '.reRead' replay.json
```
