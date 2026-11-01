# Read-expansion replay and acceptance gate

Ticket #205. The replay measures whether read expansion actually removes follow-up reads, per
language, from the pi session JSONL already on disk. It adds no log format and no runtime dependency.

## Command

```bash
pnpm run replay:read-expansion \
  --baseline /path/to/sessions-before \
  --candidate /path/to/sessions-after \
  --limit-sessions 400 \
  --json > replay.json
```

- `--baseline` and `--candidate` name two transcript corpora. A real acceptance run records the
  baseline before installing the candidate build and the candidate after; omitting `--candidate`
  defaults it to `--baseline`, which is useful for a smoke run but cannot prove a fall.
- The default root is `$PI_CODING_AGENT_DIR/sessions`, falling back to `~/.pi/agent/sessions`.
- `--limit-sessions` takes the newest N session files per corpus (default 400).
- `--json` prints the machine-readable report; without it the command prints a short table.
  `--out <path>` also writes the JSON report. `--fail-on-reject` exits 1 when any language's
  `accepted` field is false.
- `--language <name>` (repeatable or comma-separated) limits the metrics and gate to those
  languages.

The command exits 2 on an argument or corpus-read error. A gate failure only changes the exit code
with `--fail-on-reject`.

## Metrics

Each corpus is parsed from pi's session records: assistant `toolCall` entries are paired with their
`toolResult` by `toolCallId`. Only successful **served-mode** reads are denominator reads; a
`mode: "verbatim"` reads contribute no anchored rows and are therefore ignored by both metrics.

- **Same-file re-read share** — among served reads of a language's files, the share followed by
  another successful read of the same canonical path within the next three tool calls. The window is
  the three tool calls immediately after the source read; other tools count toward it.
  The numerator counts any successful later `read` of the same path, so a served read followed by a verbatim read still counts as a re-read; only denominator reads are served-mode.
- **Waste** — served lines parsed from the anchored `HASH│content` rows of each read result. A
  served line is touched when a later edit's anchor range (including `text_ref`) or a later
  `around_anchor` read resolves to it in the same file. `waste share = (served lines − touched
  lines) / served lines`. A line served by two reads counts in both records; a later touch marks
  each record it covers.
  Audit-log writes (`read-expansion.log`) never count as touches: the touch scan walks only `toolCall` events.
- Languages come from file extensions (`.ts`/`.tsx` → `typescript`, `.py` → `python`, `.md` →
  `markdown`, `.txt` → `text`, `.sh`/`.bash`/`.zsh` → `shell`, and so on). Unknown extensions are
  reported as `unknown` but never gated.
  A retired multi-file read shape attributes to its first file (`files[0]`); while `read` keeps its `files?.[0]` tolerance, this has no corpus impact.

## Gate

Binding D24 overlay:

- At least **200** candidate served-mode reads for the language.
- At least a **20% relative fall** in same-file re-read share:
  `(baseline − candidate) / baseline >= 0.20`.
- Served-line waste must **not rise**: `candidate waste share <= baseline waste share` (the report compares `wasteDelta <= 1e-12`).

Below 200 candidate reads the verdict is `insufficient-sample` and the waste metric alone decides:
`decision: "accept-on-waste"` when waste does not rise, `"reject-on-waste"` otherwise. A language is
accepted only when both the re-read fall and the waste test pass.

## Machine-readable fields

The JSON report carries `schemaVersion`, `generatedAt`, `options` (`baselineRoot`, `candidateRoot`,
`limitSessions`, `minSampleSize`, `relativeFallThreshold`, `reReadWindow`), the two corpora, and the
gate.

Each corpus has `sessions`, `parseErrors`, `totals`, and `byLanguage`. Each language has:

```json
{
  "reads": 212,
  "reReads": 61,
  "reReadShare": 0.2877,
  "servedLines": 8120,
  "touchedLines": 2044,
  "wasteLines": 6076,
  "wasteShare": 0.7483
}
```

`gate.languages.<language>` carries the evidence a ticket cites directly:

```json
{
  "sampleSize": 212,
  "baselineReads": 198,
  "candidateReads": 212,
  "baselineReReadShare": 0.4444,
  "candidateReReadShare": 0.2877,
  "relativeFall": 0.3526,
  "baselineWasteShare": 0.81,
  "candidateWasteShare": 0.7483,
  "wasteDelta": -0.0617,
  "wasteVerdict": "pass",
  "verdict": "accept",
  "status": "accepted",
  "decision": "accept",
  "accepted": true,
  "reason": "relative fall and waste gate passed"
}
```

`gate` also carries `minSampleSize`, `relativeFallThreshold`, the rule text, and the
`accepted` / `rejected` / `insufficientSample` language lists. Cite `sampleSize` and `verdict`
together in an acceptance ticket; for a below-threshold language cite `decision` and
`wasteVerdict` as well.

Useful checks:

```bash
jq '.gate.languages | with_entries(select(.value.verdict != "accept"))' replay.json
jq -r '.gate.languages | to_entries[] | "\(.key): \(.value.sampleSize) reads, \(.value.verdict)"' replay.json
```
