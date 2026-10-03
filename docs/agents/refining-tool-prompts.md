# Refining a tool's prompts

A tool's prompts — its description, snippet and guidelines — are **model-facing API text**. They are as load-bearing as the
code, and they fail differently: code fails loudly at a call site, a prompt fails quietly as a call a model never made, or made
wrongly. This document is the method this repo uses to change them, and the principles that method rests on.

It is written for an agent. Every rule below is stated with the evidence that established it, because a rule without its reason
becomes folklore the first time it is inconvenient.

---

## 1 · Map the surfaces before you touch anything

A tool may present **three surfaces** to a model, and they have different lifespans:

| surface | when it is read | budget |
|---|---|---|
| **description** | every turn, always loaded | expensive — `edit`'s is capped under 800 chars by a test |
| **guidelines** | a conditional reminder block | cheap — no cap |
| **snippet** | compact listings | must stand alone if it can be shown alone |

**Find the source of truth for each.** In this repo there are two architectures and they are not interchangeable:

- **Constant-is-source.** `edit`'s three surfaces live in `src/payload-contract.ts`; `loadP`/`loadGuide` intercept the prompt
  paths and return the constants; the `prompts/*.md` files are **generated mirrors** with a parity test. Edit the constant, then
  regenerate — editing the mirror alone leaves the served text unchanged and reddens the parity test.
- **File-is-source.** `read`, `read_skill` and `undo_last_edit` load their mirror files directly with no interception set.
  **Editing the mirror IS editing the served text** — no generator step, no parity test, and no `src/` change permitted.

```bash
grep -n 'loadP\|loadGuide\|_PROMPT_FILES\|_GUIDE_FILES' src/prompts.ts
```

## 2 · Map the pins first — BOTH kinds

Before proposing a single edit, extract every assertion that reads the text. There are **two** kinds and they fail differently:

```bash
# the exact-string assertions
grep -o 'toContain(\s*"[^"]*"' test/extension/prompts.test.ts
# the regex assertions — DO NOT SKIP THIS ONE
grep -n 'toMatch(' test/extension/prompts.test.ts
```

> **Why both.** A filter that read only `toContain` reported a change "pin-safe"; a `toMatch` regex on the same file required
> the very phrase the change deleted. The block came from the writer, not the audit. **An audit of one assertion kind is not an
> audit of the file.**

Bans count as pins. Some are the point of the surface — `read`'s guidelines **must not** contain `re-read`, because that
surface is required to frame reading as on-demand recovery rather than a per-edit ritual.

**A recommendation that breaks a pin is not a finding — it is a contract violation.** Say so, and filter the reviewer's output
against the map before acting on it.

## 3 · Probe behaviourally — the instrument that reads cannot replace

Reading the text tells you what it says. **A probe tells you what it does.** Give an agent **only** the prompt text, plus
scenarios in a fixed shape, and have it emit the call it would make:

```
scenario: <what the agent observes>
desire:   <what must be true afterwards>
```

Then compare its call against the desire. Ask for `CONFIDENCE`, `MISSING` (the exact sentence the text does not contain), and
an `AMBIGUITIES` section. **A `CANNOT DETERMINE` is a finding, not a failure.**

Two rules make the probe honest:

- **Withhold the source and tests, and run the probe outside the repo.** The isolation is the instrument. A reader who can read
  the implementation is not testing the prompt.
- **Ask it to name the tool as well as the call** (`TOOL:` and `CALL:`). A probe that returns only the arguments cannot tell
  `read` from `read_skill`.

> **Why this earns its keep.** A probe reproduced the `edit` contract correctly 11 times out of 11 — and then, on three other
> tools, emitted the wrong parameter for every one of them. The tool family is split (`file` for `edit`, `path` for the rest) and
> **no prompt named its parameter at all**. No pin check, linter, or careful reading surfaces that. Only *using* the text does.

## 4 · Measure every ambiguity against the artifact

A probe reports ambiguity; it does not resolve it. Resolve each one from the source of truth, with the command that settles it:

- a **behaviour** → run it (a scratch clone is enough);
- a **schema fact** → read the schema (parameter names, `minimum`, `description`);
- an **error path** → trigger it and read the message.

> **Why.** A probe assumed rewriting a row with its identical text would be refused. It is not — the refusal fires on the
> served-row *form*. The probe's reading was right and the desire was wrong, and only executing settled it.

## 5 · Review against the writing methodology

Run an independent review against `ai-engineering-expert` → `writing-for-agents`, including the Machine-Targeted STE flavour
(`references/agent-command-grammar.md`). Audit by its levers, not by taste:

**goal-first ordering · consumer and exclusion · leading words · negation discipline · completion criteria · no-ops ·
duplication · co-location · progressive disclosure · second-person imperative · token insulation · one term per concept.**

Two cautions learned by paying for them:

- **A source-blind review's *judgments* transfer; its *deletions* do not.** It cannot know which sentences are load-bearing for
  reasons that live in the tests. Supply the pin map with the brief and state that breaking a pin is a violation.
- **STE is a standard, not a defect.** A linter passing proves sentence length, not quality — a lint-clean draft of a prompt
  contained an illegal example. Apply STE where it costs nothing; do not rewrite pinned sentences to satisfy a linter this repo
  never adopted, and never spend a witness on cosmetics.

## 6 · Ticket the change with match discipline

Write the edit as exact `FIND`/`REPLACE` pairs, and require the writer to verify **exactly one match** per substitution and to
**STOP and report** on zero or two-or-more rather than guess.

> **Why.** Hand-written `FIND` strings were wrong repeatedly in one session — a phrase quoted from a draft rather than the file,
> a trailing `)` where the bytes were `);`, a quoted-form generalisation from a single line. **The file is the authority, not
> the ticket.** A writer that stops is worth more than one that guesses.

Also state the **blast radius** in the acceptance: `git diff --stat` must touch only the intended files, and `src/`/`test/`
counts are printed.

## 7 · Verify the SERVED text, then gate

The file is not the artifact. Verify what the loader actually returns, and run the full gate at the commit:

```bash
pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage
```

- **Print the served form.** For a constant-is-source tool, that is the constant; for a file-is-source tool, the parsed entries.
  Check the *count* of served entries, not only their content.
- **Prove the change is what you claim.** Diff each changed line by common prefix and suffix: an "insertion" claim is only true
  if there is no removal.
- **Run a positive control.** Mutate a pinned string in **both** the source and the mirror and confirm the suite goes RED.
  *A pin that cannot fail is not a pin* — and a control that reddens only a parity check has not tested the pin.

---

## The core principles

**1 · Put the artifact beside the claim.** Before writing any assertion about a file — a string, a count, a shape, a list of
files — print the file and read the line. This is free and it catches most defects. A claim about an artifact you have not
printed is a claim about your memory of it.

**2 · Execute what you assert.** Code → run it on a sample. A factual claim → measure it with the command that settles it. A
criterion → drive it in both directions: RED on the defect, GREEN on the honest state.

**3 · An example is code.** A worked example in a prompt is a claim the model will copy. Execute it against the real engine
before it is frozen — an example can be refused by a batch gate and be invisible to the loader at the same time, and neither
fault is visible by reading.

**4 · A surface is not covered because one member is.** One matched template literal does not make an array of template
literals; one checked snippet does not cover three; one assertion kind does not audit a file. **Look for the member that does
not fit** — that single move is the whole remedy.

**5 · Counts cannot audit a refactor, and a count is not a presence test.** A refactor exists to change where text lives, so
any text-derived invariant is fragile by construction. Use a mutation, or an emptiness test (`[ -z "$(…)" ]`, a clean
`--porcelain`), not a number. `grep -c` returns 1 on zero matches; `wc -l` returns 1 on empty input — both make *nothing* look
like *one thing*.

**6 · The refusal message is part of the prompt.** Before adding a rule to a surface, read what the error already says. An
escape hatch named in the failure arrives at the moment of need and costs no always-loaded tokens.

**7 · A pin is a contract; its reason must survive its removal.** A ban is half a witness — every ban needs a presence
assertion beside it. And when you remove a guard, write down the reason it existed: *a guard is a claim about the future, and
removing it is a claim about the future too — and that is the one nobody writes down.*

**8 · Freeze before you dispatch, and audit before you freeze.** Once a payload is sent it is frozen: a later edit cannot reach
a reader who has already read it, and it desynchronizes the record from what was read. Improvements go to the template, not the
sent artifact.

**9 · Budget the always-loaded surface.** The description is read every turn; the guidelines are not. Move edge cases down a
tier, and cut what a model cannot act on. Deleting one display-layer adjective bought seven characters on a string that had one
to spare.

**10 · The cross-check is a command, not a second opinion.** Reports can be self-authored; corrections cannot. Instrument
independence makes a cross-check possible; **interest independence** makes it work. And when an instrument reports a failure,
**print the artifact text beside the number** — an accuser's instrument error is indistinguishable from a finder's error and
arrives with more authority.
