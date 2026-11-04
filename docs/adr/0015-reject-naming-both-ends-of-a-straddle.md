# ADR-0015. Reject naming both ends of a straddle

Date: 2026-11-05

## Status

Accepted

Amends [ADR-0014. Anchor the Selection-Range Note on a Point, Not a Range](0014-anchor-the-selection-range-note-on-a-point-not-a-range.md)

## Context

ADR-0014 anchored the selection-range note on the window's first line and **deferred** one option:
name both ends of a straddle. Its reason was that neither reference model has a form for it. This
record closes that item.

Two measurements and one design review produced the evidence the deferral asked for. A window
straddling a boundary is the **majority** case, not an edge case: **23 of 45** recorded single-window
notes name a span the window escapes. The worked example is window 1098-1114 of `src/flask/app.py`,
which opens in `make_default_options_response` (ends 1107) and closes in `ensure_sync` (starts 1108).
Its shipped clause is 79 characters.

Every candidate form was measured on that real example, against the shipped clause:

| form | chars | delta |
|---|---|---|
| shipped, one span | 79 | — |
| second span joined by ` + ` | 117 | +38 |
| second span joined by ` to ` | 118 | +39 |
| second span joined by ` then ` | 120 | +41 |
| escape named without a second span | 124 | +45 |
| every level its own extent, three levels | 128 | +49 |

**This record corrects a figure in ADR-0014.** That record rejected per-level extents on "roughly 14
characters" of growth for three levels. Measured on the worked example it is **+49**, low by 3.5
times. The rejection stands and is now better supported, but the number it rested on was wrong.

## Decision

We will not name both ends of a straddle. The clause names one span, the one enclosing the window's
first line, and the escape stays visible through the two extents already on the header and the
`starts in` preposition.

### Considered Options

- **Name the exit span, joined by ` to `** — rejected. It is the most coherent of the two-span
  forms, because `starts in A to B` reads as traversal along the document. It costs +39 characters
  on 51 % of notes, which grows a clause by half again. Worse, it names **endpoints**: a window
  crossing three methods and rendered `A to C` omits B, and B may be the largest block in the
  window. Endpoint naming buys a false sense of completeness. This is the strongest argument
  against the whole item, and it applies to every two-span form.
- **Name the exit span, joined by ` + `** — rejected. Same cost, +38 characters. ` + ` reads as
  arithmetic addition or a set union, so it claims both methods are jointly enclosed rather than
  traversed in order.
- **Name the escape, joined by `, ends in `** — rejected. The most expensive form at +45
  characters, and it reintroduces a clause-level comma. ADR-0014 removed exactly that comma because
  it bound the extent to the compound chain rather than to the innermost name.
- **Give every chain level its own extent** — rejected, and ADR-0014's rejection is upheld. See the
  correction in Context.
- **Pay a second provider lookup per straddle** — rejected. `enclosingChain` calls
  `handle.parse(source)` on every invocation. The provider caches the grammar **handle** and does
  not cache the **tree**, so a second span costs a second full parse of the same file, on 51 % of
  noted reads, inside the note's 500 ms lookup bound. The note is chrome and must never stall a
  read.

## Consequences

- **The escape is stated, not resolved.** The header carries both extents, so a reader sees
  `1114 > 1107` directly, and the preposition says `starts in`. The note asserts nothing false. This
  is what makes the decision safe: the information is present, and only the second *name* is absent.
- **The preposition is now load-bearing.** `starts in` is the only word that says the window leaves
  the named span. Removing it, or defaulting it back to `in`, would make this decision wrong rather
  than merely terse.
- **The blind middle is unsolved and is the item's real limit.** A window crossing three or more
  blocks cannot be described by naming two of them. Any future proposal to name both ends must
  first answer what it does with the blocks in between.
- **The measurement that would reopen this is the one that would reopen the note.** No follow-up
  read in the recorded corpus covered the named span: **0 of 20**. Nothing therefore measures that
  a model acts on a named span at all. If a future corpus shows the first span is acted on, this
  decision stands. If it shows neither span is acted on, the note itself becomes the question, not
  the number of spans it names.
- **Load-bearing assumption, carried forward from ADR-0014:** that a tighter name is more useful
  than a coarse one. Nothing measures that either. The note's behavioural effect stays unmeasured,
  and three experiments have failed to measure it.
- The design review that produced this evidence is not a durable artifact. Its conclusions, and the
  figures they rest on, are recorded here and in
  [selection-range-note-measurement.md](../analysis/selection-range-note-measurement.md).
