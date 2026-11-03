# 0012. Serve a Selection-Range Note Instead of Widening the Read

Date: 2026-11-02

## Status

Accepted

Supercedes [0008. Read Expansion: Requested Window, Served Window, and Its Bounds](0008-read-expansion-requested-window-and-bounds.md)

Amended by [ADR-0014. Anchor the Selection-Range Note on a Point, Not a Range](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md)

## Context

[ADR-0008](0008-read-expansion-requested-window-and-bounds.md) made read expansion a built-in capability of `read`: the tool computed the structural block enclosing a requested window, served that block instead of the window, and stated what it had served. The rationale was that a model inspecting a file often needs two calls to understand one block, and that a widened serve could remove the second call. That record stands as written; this one records why it was reversed.

Two measurements reversed it. A benchmark of roughly 1,500 trials across five suites found no score or cost movement outside run-to-run noise, and repeated identical configurations moved the score more than the feature did. In 76 observed widenings the agent returned to that file in only 18, and exactly one widening ever used a line the widening had added. A census of 15,190 windowed probes taken from transcripts that predate the feature put a ceiling on the idea: in 39.0 % of probes the agent never read that file again; in 33.1 % it read a different region, a median of 156 lines away; only 12.6 % wanted more around the probe, and of those the union of probe and follow-up fits inside the 80-line cap in just 8.1 % of all probes. Widening around the probe cannot reach the dominant case, and where it does fire the model has already sized its window to the block.

The feature also broke a contract a tool should not break for a benefit it cannot demonstrate: a read returned something other than what was asked for. It cost 2,439 source lines, 164 tests across 18 files, nine further files carrying pins, five control surfaces, and two prompt sites. The provider layer it introduced — the enclosing-span lookup, the grammar host, and its fixtures — already works for every source and is worth keeping.

## Decision

We will stop widening a read and instead append a selection-range note to the page header, naming the enclosing span of the window actually served. The provider layer, the provider contract seam, and the grammar host stay; the expansion decision layer and its control surfaces are deleted.

1. **The note.** One clause on the page header that names the served window and its span: `[app.py (lines 250-264 of 2698 total; in function parse_args, lines 230-290)]`. It states the span's kind, its name, and its extent — not its size, which the reader subtracts. It changes no served line, carries no lease and no anchor, and is therefore never mistaken for an editable row.
2. **When it appears.** Only when the enclosing span is strictly larger than the served window. A window that already covers its span, a whole-file read, a gate decline, and a failed lookup all produce no note. The note is silent where it has nothing to add.
3. **Multi-window pages.** The note is keyed by span, not by window. A single-window page carries it on the page header; a multi-window page prints it once per distinct span, on the first section served from that span. A later section in the same span shares the note above it.
4. **Degradation by source.** A code span carries its kind and its name; a Markdown heading section carries the section title; a paragraph carries no name and prints only its extent. A span name is sanitized before it reaches the header — brackets removed, whitespace normalized, length clamped — because a heading may legally contain brackets and the header is one bracket grammar that must not break.
5. **The taxonomy of silence.** A missing note means exactly one of four things: the window equals its span; nothing encloses the window; the pre-lookup gate declined (no window, no registered provider, or a window covering the whole file); or the lookup failed. Only the fourth is a fault, and it is logged. The other three are the ordinary case, and a future reader must not read them as a bug.
6. **Admission before lookup.** Only a windowed read on a path with a registered provider, whose window is smaller than the file, reaches the provider. The retired trigger and caps are gone; this gate replaces them and runs before any parsing work, so a read that cannot carry a note pays nothing.
7. **The configuration trade-off.** The retired feature carried five control surfaces and two prompt sites. The note takes one setting, `read.selectionRange`, `on` by default, reachable as `PI_BETTER_EDIT_READ_SELECTION_RANGE`. The retired `read.expansion` key and its environment variable are rejected rather than honoured, so a stale setting cannot silently change behaviour. We accept a single fixed silence rule in exchange for deleting the tuning surfaces that produced no measurable effect; if a future measurement finds the note costly, the setting turns it off whole rather than dialing it.

### Considered Options

- **Keep widening and add the note** — rejected: widening changes what a read returns without being asked, and the measurement shows the added lines are not used. The note can carry the same fact for bytes instead of lines.
- **Delete the span lookup with the decision layer** — rejected: the lookup already works for every source, its grammar host is tested, and the note costs bytes rather than lines. Deleting it would remove the only mechanism that can answer "what encloses this window".
- **Put the note after the served rows as a trailer** — rejected: the page header already names the file and the line range, so the note is a clause on that sentence. A trailer is a third chrome dialect and puts prose among rows the model may edit.
- **Name the enclosing span in the read prompt instead of the page** — rejected: the prompt is a fixed cost paid every session and every read, while the page header is already per-read chrome. The prompt also cannot name a span it has not looked up.

## Consequences

- A read serves exactly the requested window again. Anchors and leases match what the model asked for, and the payload shape is unchanged.
- The note adds a small fixed cost to windowed reads on supported paths. It is chrome only: it cannot be edited, it spends no lease, and it is silent in the common case.
- Deleting the decision layer removes 2,439 source lines, 164 tests across 18 files, and five control surfaces. The provider contract module outlives the deletion, so the note can be retargeted without touching the grammar host.
- Silence now has four meanings, three of which are normal. That taxonomy above is the record; a reader who meets an absent note should not treat it as a failure unless the lookup logged one.
- A provider failure is logged and silent, so grammar coverage can be refined later without spending the model's attention.
- Load-bearing assumption: real windows stay small relative to their blocks, with a median probe-plus-follow-up union of 55 lines. If files grow until whole-file reads become uneconomic, this calibration would be revisited. The deferred outline question carries that measurement: an outline of symbol names with line ranges would reach the 33.1 % whose next read is a different region, and it is a different feature with its own contract.

### Measurement

The retired widening gate was retargeted rather than rebuilt, because it was the only instrument that could say whether a read-time enrichment changes behaviour (ticket #243). The note's gate is `pnpm run replay` over recorded pi sessions; it counts notes in served read headers by provider source, checks that each note names a span strictly larger than its window, and reports the same-file re-read share against a pre-change corpus with a 95 % two-proportion noise band. The command, the metrics, and the refusal vocabulary are in [selection-note-replay.md](../agents/selection-note-replay.md).

Measured 2026-11-02 on the operator host over `~/.pi/agent/sessions`: **zero notes** in 31,185 served reads across 3,122 sessions, and zero correctness violations. The installed build is 2.16.0, whose dist predates this note, so no read could have carried one — a neighbouring census of the same 400-session sample found 6,869 served read headers and no clause in any of them. The note's effect on re-reads is therefore **unmeasured**, not zero: no recorded corpus exposes the treatment. At this corpus size a pair of corpora this large resolves a movement of about 0.7 pp (2,289 reads per side: about 2.3 pp). The number this ADR cannot yet cite is the one that matters, and the gate names exactly what to record to obtain it: a candidate corpus produced by a build that carries the note, compared against the pre-note corpus.

Deep analysis: [read-expansion-final-report.md](../analysis/read-expansion-final-report.md) and [read-expansion-benchmark-evidence.md](../analysis/read-expansion-benchmark-evidence.md).
