# ADR-0014. Anchor the Selection-Range Note on a Point, Not a Range

Date: 2026-11-03

## Status

Accepted

Amends [0012. Serve a Selection-Range Note Instead of Widening the Read](0012-serve-a-selection-range-note-instead-of-widening-the-read.md)

## Context

[ADR-0012](0012-serve-a-selection-range-note-instead-of-widening-the-read.md) introduced the note and fixed its anchor as "the enclosing span of the window actually served". The implementation required that span to contain the **whole** window. `findEnclosingScope` kept a node only when `range.startLine <= requestedStart && range.endLine >= requestedEnd`.

Measurement exposed the consequence. A window that crosses a boundary qualifies no tight span. The answer then degrades to the outermost container that does contain it.

Four `micro-swe` legs on Pi 1.4.0 measured the effect: two with the note on, two with it off, 16 tasks each. The note fired on 51.4 % and 56.2 % of windowed reads. But the named span covered **over half the file** in 42 % and 39 % of those firings. `class Console` was 2 062 of 2 698 lines. `class Flask` was 1 579 of 1 686. No follow-up read of the same file ever covered the named span: **0 of 20**. The measurement is recorded in [selection-range-note-measurement.md](../analysis/selection-range-note-measurement.md).


The fix was then measured the same way, over two legs of the same suite. They produced 18 notes in 33 windowed reads and 31 in 43. The named span covered over half its file in only **2 of 18** and **1 of 32** firings. The old anchor measured **8 of 19** and **7 of 18**. A bare class name survives once in 32 notes, where it was 8 in 19. The breadcrumb reaches three levels and names spans as tight as 3 lines.

The cause is visible in source. Window 1098-1114 of `src/flask/app.py` opens inside `make_default_options_response`, which ends at 1107. It closes inside `ensure_sync`, which starts at 1108. No method contains it, so the smallest containing node is `class Flask`. Agents read across boundaries precisely when they are exploring. The rule therefore failed hardest in the case it existed to serve.

Both reference models in the ecosystem anchor on a **point**, never on a range. LSP `textDocument/selectionRange` takes positions. It returns a chain in which each `parent.range` contains its child's `range`. Neovim `nvim-treesitter-context` picks one line and builds a one-character range on it (`{ row, col0, row, col0 + 1 }`). It then climbs parents into a chain. It trims that chain to a line budget, and its default `trim_scope = 'outer'` discards from the outer end. Neither tool would answer "what am I looking at" with the enclosing class.

## Decision

We will anchor the note on the window's first line and name the enclosing chain as a breadcrumb.

1. **The anchor is a point, not a range.** The provider is asked what encloses `window.offset`. A read has no cursor, so the top line is the analogue of Neovim's `'topline'` mode. `findEnclosingScope(root, start, end, kinds)` becomes `findEnclosingChain(root, line, kinds)`. `SpanProvider.enclosingSpan` becomes `enclosingChain`.
2. **The answer is a chain.** It carries every scope-like node whose line range contains the anchor line, innermost first. The file root is excluded, because it is the whole file. Ordering by extent is sound. Two nodes containing the same line are necessarily nested, so the shorter is the inner one.
3. **The breadcrumb carries at most three levels**, outermost first, joined by ASCII ` > `. It is trimmed from the **outer** end, keeping the innermost. That is Neovim's default `trim_scope = 'outer'`, adapted from a line budget to a one-line clause.
4. **The extent is the innermost span's.** On a straddle that extent is *smaller* than the window, so the escape is visible from the two extents already on the header. Point 9 states it in words as well.
5. **A straddle is no longer silence.** ADR-0012 made the note silent unless the span was strictly larger than the window. Under a point anchor that rule would silence the case this record exists to fix. Silence now means only that the innermost span equals the window exactly.
6. **Silence, restated.** A missing note still means one of four things. Either the innermost span equals the window, or nothing encloses the anchor line, or the pre-lookup gate declined, or the lookup failed. Only the fourth is a fault, and only it is logged.
7. **The kind vocabulary is unchanged.** It stays the 26 lowercase LSP 3.17 `SymbolKind` names plus the six documented extensions. Every level of the breadcrumb is sanitized by the rule that sanitized the single span.
8. **The note stays chrome.** It changes no served line, carries no lease and no anchor, and the read payload shape `{file, windows?, mode?}` is untouched.
9. **The rendered clause binds the extent to its name.** It is `; <preposition> <breadcrumb> (span <start>-<end>)`. Parentheses bind the extent to the innermost name where a comma bound it to the whole compound chain, and the word `span` separates it from the window's own `lines a-b of N total`. The preposition is `in` when the innermost span contains the window's last line, and `starts in` otherwise, so a straddle states the escape instead of denying it. The clause stays one bracket inside the page header.

### Considered Options

- **Keep the whole-window containment rule** (ADR-0012's anchor) — rejected. It was measured to name a span covering over half the file in roughly four firings out of ten. In zero of twenty cases did a follow-up act on the named span. The rule is not merely imprecise. It degrades to the outermost container in exactly the exploratory case the note exists to serve.
- **Anchor on the window's last line** — rejected. It names whatever the window ends *inside*. On a read that is scrolling down, that is the region the model has not yet examined. The first line is what the model sees first, and it is what Neovim's `'topline'` mode uses.
- **Name both ends of a straddle** — deferred, not rejected. A window from method A into method B could name both. That would help when the model's target is the later one. It is deferred because neither reference model has a form for it. Inventing a separator for sibling spans is a presentation decision, and it deserves its own evidence rather than being settled inside an anchor fix. The extent on the header already exposes the escape.
- **Give every chain level its own extent** — rejected. It is what LSP's `selectionRange` shape implies, and it removes the attachment ambiguity. A three-level clause grows by roughly 14 characters, the header then wraps in a terminal, and the outer extents carry no actionable information for a reader inspecting the innermost block. Parenthesized binding removes the same ambiguity at no character cost.
- **Drop the note now that the anchor is precise** — rejected. The note is cheap chrome on an existing header. The provider layer already exists for every source. A precise name is actionable where a class name was not, even though the behavioural effect remains unmeasured.
- **Return the whole chain with no cap** — rejected. A deeply nested anchor would print a clause longer than the header it sits on. Neovim caps the same chain at a line budget for the same reason.

## Consequences

- A straddling window names the method it starts in. The measured failure mode is gone. That mode was a note saying "you are inside a class that is 94 % of the file".
- The note is now **not** silent on a straddle, so it fires at least as often as before on the same corpus. The measured 51.4 % and 56.2 % firing rates are a floor for the new form, not a prediction of it.
- The provider seam changed shape. Every provider must answer a chain. Markdown, paragraph and bash return a one-element chain and behave exactly as they did. A future provider author implements `enclosingChain`, not `enclosingSpan`.
- **The refined form is measured, structurally.** Two `micro-swe` legs of 16 tasks each ran on the same harness. They produced 18 notes in 33 windowed reads and 31 in 43. The named span covered over half its file in **2 of 18** and **1 of 32** firings. The old anchor measured **8 of 19** and **7 of 18** on the same suite. The coarse share therefore fell from **15 of 37 (41 %)** to **3 of 50 (6 %)**. The fix moved the metric it was aimed at. The score comparison remains invalid, because provider drift moved one arm by 8 points between runs.
- **The old preposition was false in 23 of the 45 recorded single-window notes.** 51 % of them named a span the window escapes while the clause asserted `in`. The preposition is now chosen from the window's last line, so no rendered note asserts something the tool does not know to be true. A contained read pays nothing; a straddle pays 7 characters on a clause whose median is 57, inside a note that costs 0.348 % of the characters a page already serves.
- **Load-bearing assumption:** that a tighter name is more useful than a coarse one. Nothing here measures that. If a future corpus shows a precise name does not change model behaviour either, the note itself becomes the question, not its anchor.
- ADR-0012 stands as written for the decision it recorded. That decision was to stop widening and serve a note instead. This record changes the note's anchor and its form, and leaves that decision intact.
