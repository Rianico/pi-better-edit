# Selection-range note: measured helpfulness

Date: 2026-11-03

## Verdict

The note fires often, and names a span too coarse to act on about half the time.

- It fired on **51.4 %** and **56.2 %** of windowed reads in two independent legs.
- The named span covered **over half the file** in **42 %** and **39 %** of those firings.
- **No** follow-up read of the same file ever covered the named span: **0 of 20**.

The score comparison is **invalid** and cannot support any claim. The same arm scored
16/16 and then 10/16, so drift exceeds any note effect.

## What the note is

A read of a window inside a larger span gets a clause on its page header:

```
[src/flask/app.py (lines 1098-1114 of 1686 total; in class Flask, lines 108-1686)]
```

The clause appears only when the span strictly contains the window. Several windows in
one span share one clause. `selection-range-note.ts` decides and renders it.

## Method

Four legs of the `micro-swe` suite, 16 tasks each, on Pi 1.4.0 with
`opencode-go/muse-spark-1.3-contributor`, thinking `low`, concurrency 10, one attempt.

| leg | arm | note |
|---|---|---|
| `note-on-a` | on (shipped default) | `PI_BETTER_EDIT_READ_SELECTION_RANGE` unset |
| `note-off-a` | off | `PI_BETTER_EDIT_READ_SELECTION_RANGE=off` |
| `note-on-b` | on | as above |
| `note-off-b` | off | as above |

The legs ran back to back in that order, so each off leg immediately followed an on leg.
The image was built from `main` at `6e258d7` by `pnpm pack` into `Containerfile.note`.

`micro-swe` was chosen for one reason: its reads are **82 % windowed**, so the note has
the most opportunity to fire there. `EDIT-Bench` reads windows 7-16 % of the time and
Aider 0.5-3 %, so neither can carry this measurement.

`scripts/note-census.py` reads the agent transcripts only. A read counts as noted when
its served text carries the clause. It counts as windowed when the header carries a
range. Both counts are deterministic and provider-independent.

## Result 1: the note fires on half the windowed reads

| leg | served reads | noted reads | share |
|---|---|---|---|
| `note-on-a` | 37 | 19 | 51.4 % |
| `note-on-b` | 32 | 18 | 56.2 % |
| `note-off-a` | 27 | 0 | 0 % |
| `note-off-b` | 36 | 0 | 0 % |

The two off legs confirm the toggle works: zero notes, with windowed reads still served.

## Result 2: the named span is usually too coarse to act on

| leg | median span | spans over half the file |
|---|---|---|
| `note-on-a` | 9 % of the file | 8 of 19 |
| `note-on-b` | 9 % of the file | 7 of 18 |

The distribution is bimodal. The same spans recur in both legs:

| span named | median extent | notes |
|---|---|---|
| `method export_svg` | 253 lines | 7 and 10 |
| `class Console` | 2 062 lines | 4 and 6 |
| `class Flask` | 1 579 lines | 4 and 1 |
| `method make_response` | 141 lines | 2 and 1 |

`class Console` spans 2 062 of 2 698 lines, so the note says the window sits inside a
class that is 76 % of the file. `class Flask` spans 1 579 of 1 686 lines, or 94 %.

## Result 3: no follow-up read acted on the named span

| leg | notes with no later read of that file | later read of that file | that read covered the span |
|---|---|---|---|
| `note-on-a` | 9 | 10 | **0** |
| `note-on-b` | 8 | 10 | **0** |

Split by span size, an overlapping read follows 8 of 21 tight spans and 9 of 14 big spans.
Overlap is weak evidence, because a 1 579-line span overlaps almost any later read of
that file. Coverage is the meaningful test, and it is 0 of 20.

## Result 4: the score endpoint is dead

| leg | passed | timed out at 300 s | median seconds |
|---|---|---|---|
| `note-on-a` | 16 / 16 | 0 | 138 |
| `note-off-a` | 8 / 16 | 6 | 190 |
| `note-on-b` | **10 / 16** | 4 | 157 |
| `note-off-b` | 13 / 16 | 3 | 243 |

The arms overlap: on spans 10 to 16, off spans 8 to 13. The **within-arm** spread is
6 points, which equals the whole between-arm difference. The same arm moved 6 points
between two runs with the note unchanged. Provider latency drifted about 2× across the
session, and the timeouts at the 300 s wall drive the score.

Any score difference here is drift. This matches the earlier read-expansion finding:
provider drift dominates every trigger and cap effect measured.

## Why the span is coarse: the straddle

The note names the innermost span that **contains** the window. When a window straddles
two methods, no method contains it, so the answer degrades to the enclosing class.

`src/flask/app.py`, window 1098-1114, which produced `in class Flask, lines 108-1686`:

```
 1092 |     def make_default_options_response(self, ctx: AppContext) -> Response:
 1098 |         Takes ``ctx: AppContext`` as the first parameter.   <<< window starts
 1107 |         return rv
 1108 |     def ensure_sync(self, func: t.Callable[..., t.Any]) -> ...   <<< next method
 1114 |         Override this method to change how the app runs async views.   <<< window ends
```

The window opens inside the first method's docstring and closes inside the second
method's docstring. The only span containing it is `class Flask`.

Agents read windows across boundaries **when they are exploring**, which is exactly when
a precise answer would help. That is the structural reason the note is usually not
actionable.

## Answer to the question asked

Only a small portion is actionable, and the share is now measured rather than guessed.

- The note is not rare. It fires on about half of all windowed reads.
- It is usually **coarse**: 4 notes in 10 name a span covering over half the file.
- It is **never acted on** in this corpus, by the strict test: 0 of 20 follow-ups.
- The cause is the straddle, not the wording. A window that crosses a boundary has no
  tight container, and crossing a boundary is what exploration looks like.


## Follow-up: the point anchor moves the metric it was aimed at

The note was then re-anchored on the window's first line and reshaped into a breadcrumb
([ADR-0014](../adr/0014-anchor-the-selection-range-note-on-a-point-not-a-range.md)).
Four fresh legs of the same suite measure the new form against the old one.

| form | leg | noted reads | named span over half its file |
|---|---|---|---|
| range anchor | `note-on-a` | 19 of 37 | **8 of 19** |
| range anchor | `note-on-b` | 18 of 32 | **7 of 18** |
| point anchor | `crumb-on-a` | 18 of 33 | **2 of 18** |
| point anchor | `crumb-on-b` | 31 of 43 | **1 of 32** |

The coarse share falls from **15 of 37 (41 %)** to **3 of 50 (6 %)**. The note also fires
more often, 51-56 % becoming 55-72 %, because a straddle is no longer silence.

The names change accordingly. The old anchor produced a bare `class Console` of 2 062
lines and a bare `class Flask` of 1 579. The new one reaches three levels and tight spans:

| span named | median extent | notes in `crumb-on-b` |
|---|---|---|
| `class Console › method export_svg` | 253 lines | 16 |
| `class Flask › method make_response` | 141 lines | 4 |
| `class Console › method export_svg › function escape_text` | 3 lines | 2 |
| `class Scaffold › method route › function decorator` | 4 lines | 1 |
| `class Flask › method finalize_request` | 35 lines | 1 |
| `class Flask` | 1 579 lines | 1 |

A bare class name survives once in 32 notes, against 8 in 19 under the old anchor.

### The score endpoint stays dead

| leg | passed | timed out at 300 s | median seconds |
|---|---|---|---|
| `crumb-on-a` | 7 / 16 | 8 | 275 |
| `crumb-off-a` | 16 / 16 | 0 | 182 |
| `crumb-on-b` | 15 / 16 | 0 | 129 |
| `crumb-off-b` | 12 / 16 | 4 | 232 |

The on arm spans 7 to 15, the off arm 12 to 16. The arms overlap and the within-arm spread
of 8 points exceeds the whole between-arm difference. The 8 timeouts in `crumb-on-a`
belong to the leg that ran when the provider was slowest, not to the note. This is the same
finding as Result 4, reproduced on a second experiment.

### What the follow-up does not settle

The 6 % figure is a structural result: it counts what the note names, not what the model
does with it. The strict action test still reads 0. A tighter name is a better answer to
"what am I looking at", and that is all this measures. Whether the model acts on it more
often than it acted on a class name remains unmeasured.
## Threats to validity

- **One suite.** `micro-swe` was picked for its high windowed-read share. A suite with
  larger files and tighter windows would fire the note on tighter spans.
- **Two legs per arm.** Enough to show the mechanism is stable, not enough to bound a
  small score effect.
- **No provider control.** Drift was measured, not removed. A paired design that
  interleaves arms trial by trial would be needed for any score claim.
- **Coverage is a strict test.** It asks whether a later read served the whole span.
  A weaker test, overlap, is reported and is not decisive.
- **One model.** `muse-spark-1.3-contributor` at thinking `low` only.

## Reproducing

```bash
# image
cd /path/to/pi-better-edit && pnpm run build && pnpm pack --pack-destination /tmp
cd /path/to/explicit-edit-benchmark && cp /tmp/pi-better-edit-*.tgz pi-better-edit-note.tgz
podman build -f Containerfile.note -t localhost/eeb-bench:note .

# legs
bash /tmp/run-note.sh

# analysis
uv run scripts/note-census.py results/note-on-a results/note-off-a results/note-on-b results/note-off-b
```
