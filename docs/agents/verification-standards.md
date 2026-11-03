# Verification Standards

How this repo decides whether a check is worth anything. Every rule below carries the evidence that established
it, because a rule without its reason becomes folklore the first time it is inconvenient.

The spine: **a check corroborates only if it can fail for the reason it exists.** Its corollary is why this file
exists — *a check that cannot fail for the reason it exists is worse than no check*: no check leaves a gap someone
notices, a check that cannot fail leaves a number someone trusts. The five instances below are that one
requirement seen from five sides, each with a #90 worked example and its **enforcement site**.

## 1 · Checks

### (a) Independence of knowledge

A second measurement must not **know** the first. Pre-register the prediction — the expected reconciliation, the
rung you expect to fire — *before* you measure, because **a reconciliation found after a disagreement is
indistinguishable from a rationalisation, while one written before is a hypothesis with a test.**

> **Honest accounting, from #90.** The tranche pre-registered a reconciliation ladder that never fired: zero
> divergences, so its measured return was zero. What it did return was the artifacts the protocol forced —
> symbol-only citations, checkable phrasing, a bound beside its reason. A pre-registered rung that never fires is
> a cost whose measured return was zero, and saying so is part of the rule.

**Enforcement: convention.** Nothing in the tree can observe the order of a prediction and its measurement.

### (b) Independence of instrument

A second measurement must not read through the same **layer**: two runs of the same command through the same
renderer agree perfectly and prove nothing. The rows below are **axes** — command resolution, the write path, the
formatting path, the pattern, the oracle — the layers an artifact can enter.

| axis | route | second route | the artifact that separates them |
|---|---|---|---|
| **command resolution** — **binary** (native vs proxy) × **output class** (porcelain vs plumbing) × **mode** (piped vs redirected) | **native**: the absolute path (`/usr/bin/git`, `/opt/homebrew/bin/git`) | **proxy**: `rtk git`, or a bare `git` where the harness rewrites the command word | a `Changes:` trailer the proxy appends to otherwise-correct output — and this row's own pass condition: **a route pair is a control only if it differs in exactly one of those three columns**, varied one column at a time in the blockquote below. |
| pattern | a text filter over a rendered diff (`grep -c '^+[^+]'`) | `git diff --numstat` | 91 vs 94 added lines |
| oracle | reading the ignore rule | `git check-ignore`, `git status --untracked-files=all` | a symlinked path |

> **Measured in one shell on `git diff --name-only 733003b..8c2504a`, one variable at a time — four commands × two modes.**
> `git`, as `PATH` resolves it (`/opt/homebrew/bin/git`, git 2.55.0), in a shell whose command word is not
> rewritten: 578 bytes piped, 578 redirected, no trailer.
> `/opt/homebrew/bin/git` by absolute path: 578 / 578, no trailer. `/usr/bin/git` by absolute path: 578 / 578, no
> trailer. `rtk git`: 589 / 589, **with** the trailer — both tails ending `…config.test.ts`, then a blank line,
> `Changes:`, a blank line, the 11 appended bytes being `\nChanges:\n\n`. The trailer is the **proxy's**, in both
> modes; the native binaries append it in neither, and redirection moves no number on any of the four. Through the
> proxy the filter is format-dependent — porcelain `rtk git diff --name-only` carries it, plumbing `rtk git
> diff-tree -r --name-only --no-commit-id` passes through — so a porcelain/plumbing pair separates the trailer only
> while a proxy is in the path. Counting added lines in `d13a2f6..b95f7b7` by `grep -c '^+[^+]'` gives 91,
> `git diff --numstat` gives 94 — the gap is the three added blank lines the pattern cannot see. `.gitignore`'s
> `node_modules/` is a directory-only pattern: it matches the real directory and `git check-ignore` exits 1 on a
> symlink named `node_modules`, which `git status` reports untracked.

**Why the artifact was visible where it was.** A harness that rewrites the command word puts the proxy in the path of
a bare `git diff` — `rtk rewrite 'git diff --name-only HEAD~1'` answers `rtk git diff --name-only HEAD~1` — so in such
a shell the trailer reaches rendered output, while a file written by a native binary under redirection never carries
it, because redirection writes that binary's bytes and bypasses the filter. The provenance is that mechanism, not an
anecdote: the artifact lives in the **filtered stream**, so the example reproduces wherever the stream is filtered
(`rtk git diff --name-only 733003b..8c2504a` = 589 bytes carrying the trailer, against 578 from `\git` or an absolute
path) and a redirected file is its null.

**Two routes are not a control; the matrix is the control** — a pair can carry a confound, and a confound leaves no
trace in the output to correct it. This tranche's original attribution is the instance: it named the **output layer**,
from a pair that differed in **two** layers at once — the resolved binary *and* the redirection — so the difference
landed on whichever variable was named first. That is the **diagnostic** failing for a nameable reason: **the pair did
not differ in exactly the layer under test**. Contrast the two pairs in this tranche that **held** — the mutation's
per-case identities in (c), and the 91-vs-94 recount in the pattern row above — where the routes differed in **exactly
one** layer, which is why their conclusions were entailed rather than lucky.

That is also why command resolution is the table's strongest example: its answer is available **before** the
measurement — `type -a git` / `command -v git` names the candidate binary — whereas *"would the routes diverge if the
artifact were present?"* is a **diagnostic** askable only afterwards, because you cannot know where the artifact lives
while the instrument is wrong. The resolution cell is **per-shell**: the `PATH` row of the blockquote above is that
shell's reading, not a repository fact, and the command-word rewrite is the second layer that decides which binary
actually ran. Check both before trusting a byte.

The preventive form is **structural**: routes that differ **by construction** — in command resolution, the write
path, the formatting path, the pattern, or the oracle — not two commands that happen to be different. For command
resolution the form is concrete: **invoke the native binary by absolute path, or expect a filtered stream.**
*"Redirect it and count the file"* is not enough — redirecting through the proxy still carries the trailer, and it
passed only because a shell happened to resolve `git` to the native binary. Check what the command **resolves to**,
and whether the harness rewrites it, before trusting its bytes.

**Enforcement: mixed.** The tree-residue half is mechanised as [CONTRIBUTING.md](../../CONTRIBUTING.md)'s two scans
— the repo-wide `find . -path ./node_modules -prune -o -name '*-probe*' -print` and the tracked-vs-untracked
comparison `comm -13 <(git ls-files '*.test.ts' | sort) <(find . -path ./node_modules -prune -o -name '*.test.ts' -print | sed 's|^\./||' | sort)`
— which disagree with `git status` exactly when the residue is gitignored. The route choice is otherwise **convention**.

### (c) Identity over count

A count must be able to be wrong in the way that matters. `4 failed` is not evidence; **which four, and at which
assertion** is.

> **The mutation whose target was `4 failed`.** Deregistering the lifecycle hook's `session_start` registration
> reddens `test/extension/lifecycle.test.ts` at three cases through the shared antecedent control
> (`expectSessionStartWorkRan`) and one through its positive assertion (the `notify` case), with zero extras — and
> the arming assertion in `armSessionStartControl` (`expect(getSnapshot(...)).toEqual(["abcc"])`) **passes**, which
> is what makes each failure the missing antecedent rather than collateral.

Two smaller instances: the flake protocol's *"same two tests every time"* (a deterministic failure is not a flake,
and re-running does not make it one), and the per-sha table's *"every delta accounted for"* (a test-only commit
moves the count by zero, and the table states that rather than leaving it to be inferred).

**Enforcement: convention.** The identities live in the report; no artifact holds them.

### (d) Mutation as acceptance

A test-strength fix is proved by a mutation, not by an argument. Where the change under review *is* a test, the
mutation **is** the review — no second adversarial pass is owed.

> **Two probes, not one.** The first — removing the registration — reddens the four cases (c) identifies; the second,
> removing the handler's **own work** (the prune the control observes), reddens exactly the three controlled cases and
> leaves the positive case green. The second probe is what shows the control tracks the hook rather than the event's
> arity.

**Enforcement: convention**, over the named test the mutation must redden (`test/extension/lifecycle.test.ts`).

### (e) Tip-binding

A green must be able to fail for the reason it exists — **that the tree moved**. Bind every result to
`git rev-parse HEAD` and to the tree fingerprint, which has **two halves**: the tracked tree,
`git diff-index --quiet HEAD` (exit 0 = no tracked path differs from `HEAD`, staged or unstaged), and the
untracked/ignored residue, `git ls-files --others --ignored --exclude-standard` — captured before the window and diffed
after, because `git status` reports clean exactly when the residue is gitignored. The residue's pass condition is the
**conditional** form, not emptiness: **no added line that is not an output of the gate's own commands**, attributed by
directory — `coverage/` (`test:coverage`, 93 lines), `.husky/_/` (17) and `dist/` (1) from the `prepare` lifecycle, and
the tooling's own cache under `node_modules/.cache/`. Measured in a fresh clone: the listing starts at 0,
`pnpm install` takes it to 31,677 (18 of them outside `node_modules/` — `.husky/_/` 17, `dist/` 1), the gate's own
commands add one more (the jiti cache line) and remove none, and `test:coverage` adds 93 under `coverage/`. A count
would measure that listing's size: 31,678 after the gate in the clone, 33,444 in this long-lived worktree, 33,217 of it
`node_modules` — so **emptiness measures the environment while the diff measures the window** — which is why the
instrument is a baseline diff.

This one is in the list because it fails by **false attestation** rather than by a wrong number: a stale green is
not caught by the next measurement, it is *quoted* by the next reader.

**Enforcement: mechanised.** [CONTRIBUTING.md](../../CONTRIBUTING.md)'s *Gate preconditions* names the sha, both
empty-tree checks, `git diff-index --quiet HEAD`, an empty `git stash list`, and `uptime`. Push state is
`git ls-remote --heads origin <branch>` (empty = no remote ref).

**State a check as a PROPERTY of the invariant, not as a LITERAL snapshot.** A brief that required
`git log --oneline -1` to equal one sha made its own check unsatisfiable the moment the first group committed, so
the writer had to measure the check's **intent** instead — the base is an ancestor, exactly one commit sits above
it, the diff is docs-only — and ask for a ruling. A literal is a claim about a **moment** and can contradict the
design it was written to protect; a property is a claim about the **invariant** and stays true as the work grows.
Read it with §3: by §3's own 2×2 a snapshot literal is a claim **true when written and able to rot without an
edit** — the fourth cell — whose remedy is the **union**, wording (state the invariant) plus binding (the property
that stays checkable as the tranche grows). **Two sections, one rule.**

**Name the invariant before the instrument, then state the pass condition in its terms.** Three times in this
tranche a detector was right and its **pass condition** was wrong, and the three failures share one shape: the pass
condition was stated as a convenient property of the **instrument** rather than of the **invariant** being
defended. Read off them:

| invariant | pass condition | the failure it would have caught |
|---|---|---|
| **existence** — "this must not be present" | **emptiness** of a detector that names individual things | the gitignored scratch file: `git status` was empty, and the file was there |
| **invariance** — "this must not change" | a **baseline diff**, captured **before** the window | the added-line count: the pass condition was the filter's own output, not a diff against the pre-window baseline |
| **attribution** — "this difference has one cause" | a **matrix over axes**, never a pair | the `Changes:` trailer: one pair, two layers varied, the wrong variable named |

The mapping is for **reaching for** the right pass condition, not only for recognising a failed one — and the order
it implies is the actual defect: **the invariant is named before the instrument is chosen**, because the failure
mode is choosing the instrument first, for convenience, and then naming whichever invariant it happens to defend.

**Re-measurement within the same frame cannot detect a frame error; only a measurement that varies the frame can.**
The bare form — *a criterion error is invisible to re-measurement* — is true of repetition and false of variation: it
lets a reader conclude that measuring twice is safety, and skip exactly the move that exposed the `Changes:` example,
the 4 × 2 varying one column at a time. That instrument was re-measured each time and agreed with itself; only a case
that could **falsify** the frame exposed it. So the three rules are one discipline in several materials, not three
tips — independence of instrument is *vary the frame*, mutation as acceptance is *vary the case so it can falsify*,
criterion-first is *name the frame before measuring in it* — because each requires **the frame to be able to be
wrong**: the spine applied to a frame instead of a check.

## 2 · Claims

- **Reach ≤ competence.** Claim only what your artifact can see.
- **Scope + direction + safety argument.** Each part answers a different failure: the scope stops silent decay, the
  direction says which way the risk runs, the safety argument makes the divergence defensible rather than convenient.
- **A bound beside the reason it exists** — a limit with no reason beside it is the first thing an editor deletes.
- **Measure before briefing.** A figure you did not take is a figure someone else will quote.
- **Label a hypothesis as a hypothesis** in the text, not only in your head.
- **An inherited claim is an unmeasured claim.** The #90 report forwarded a child's `Changes:` attribution as a
  measured environment finding, and a two-minute probe refuted both halves of it. **An example is verifiable when the
  command that produces it can be run in this repository; a figure cited because the citer happened to be in the same
  pane is testimony, not a reproduction.**

**Scope mis-calibration runs both ways, with different symptoms and different remedies.** **Over-reach** — the
claim asserts more than the evidence supports — shows up as a claim nobody can check, and the remedy is to narrow
it (measure, then state): the byte-frozen claim and the inherited `Changes:` attribution are this tranche's
instances. **Under-scope** — the claim excludes applications that exist — shows up as a rule that reads as
**advice**, because no instance of it can be found inside the stated scope, and the remedy is to widen it to where
the rule was actually used, which may be **outside the page** — §5's Pricing row names this tranche's instance.

The spine's claims-side twin, in one line: **a check must be able to fail for the reason it exists; a rule's scope
must admit the applications that exist.** Both say the thing must be able to be right *for the reason it exists*,
so a check that cannot fail and a rule that cannot be exemplified are the same defect — one in logic, one in prose.

**Ask *is this duplicated / sufficient / present* with a table, not a verdict.** Prose invites a verdict; a table
demands a column — so tabulate the **instances** against the **criterion**, and the criterion is **named before** the
first instance is compared: §1's pass-condition mapping ordering (the invariant before the instrument), applied to a
judgement rather than a detector. This tranche's instances: the command-resolution **4 × 2** matrix (which layer
carries the trailer), the **instance → rule → claim** tabulation over this doc's own worked examples (which of the
reuses are duplication — it found one repeated pair, the mutation example under both (c) and (d)), and a **knip
composition** of this repo's own output (`pnpm exec knip --max-issues 84`: 84 findings, 24 re-export lines in an
`index.ts`, 9 symbols reported twice, at the definition and at the re-export). **Enforcement: convention** — no test
reddens on how a question was answered.

**Enforcement: mixed.** The comment gate — `harness/no-comments`, an oxlint jsPlugin configured in
`.oxlintrc.json` — forces every non-JSDoc comment to carry an allowlisted tag, so the *reason* has a place to live;
the *content* is **convention**. The tag list is not this sentence: it is `ALLOWLIST_RE` (with its Gherkin branch)
in `scripts/oxlint-plugin-comment-gate.js`, and the four tags named here — `WHY:`, `SAFETY:`, `Invariant:`, `See
ADR-` — are **among others** in it, as are `via https://`, `TODO(#<digits>):`, `HACK:` and the Gherkin keywords.
An enumeration in a doc decays; the path and the symbol do not.

## 3 · Decay

A claim must hold at the point a reader actually reads it, not only at the point it was written.

| | cannot rot | can rot |
|---|---|---|
| **true when written** | safe | bind it — a symbol, a sha |
| **false when written** | correct it | correct it **and** bind it |

The fourth cell needs the **union** of both remedies, and #90 has the instance:

> `src/store-janitor.ts`'s module header placed the #90/#100 boundary "where the deep check is scheduled" — a
> **location claim** (false: the deep check is scheduled in `runJanitor`, far from the header owning the clause text)
> that could also **rot** (the scheduling site can move). The fix re-pointed at the module's own behaviour and
> dropped the location claim — both remedies, one edit. (Pre-fix wording at `5736d71^` on `origin/feat/90-store-janitor-gc`.)

**Review cannot see decay.** Review is a **writing-time** instrument; decay fails at **reading** time, which is
why every decay instance in this tranche survived review — and why a superseded example here was replaced rather
than left beside the corrected one.

**The preventive form: bind the thing that can move.** A **symbol** rather than a line range for a dependency; a
**sha** rather than "the tip"; a **reason** beside a bound; a **superseding commit** rather than silence.

**Enforcement: convention.** The mechanised analogue is ADR numbering — `test/arch/adr-numbering.test.ts` pins
heading/filename agreement, so a renumbering cannot silently rot ([docs/agents/domain.md](domain.md)).

## 4 · Pricing

Enumerate the **obligation set** before pricing it: a cost model is a claim about the future, and the obligations
are the only part you can actually count.

Batch by **invalidation**, not by discovery. A gate is superseded by **any** commit, so the cost is per
**tip-opening event** and the lever is how many times you open one — not how many findings you collected. Two
groups land before one gate, not one gate per group.

**Enforcement: convention.**

## 5 · Self-application

**Every section should be able to point at the place where this doc applies it to itself** — a rule that cannot
point at itself is probably **advice**, and advice is the failure mode this file exists to avoid. The kind of
pointer differs, and naming the kind says more than a pass:

| section | who applies it | where |
|---|---|---|
| 1 · Checks | this doc, to itself | the command-resolution row (preventive) and the properties rule |
| 2 · Claims | this doc, to itself | the enforcement-site field — refusing to claim enforcement it cannot name |
| 3 · Decay | this doc, to itself | the allowlist snapshot in §2 and the superseded-attribution rule in §1 |
| 4 · Pricing | the author, to the work that produced this doc | *enumerate the obligation set before pricing it* (the obsolete-on-arrival stop) and *batch by invalidation* (the bundle decision) |

Both kinds are self-application; only the second lives outside the page. The test is a **convention** — no test
reddens — and a doc in which every section passes by construction is the version to distrust.

## The commands this repo's gate actually uses

`python3 scripts/changelog-gate.py ticket` (the PR-free shape floor `pnpm run verify` starts with) · `pnpm run lint` (oxlint + `knip --max-issues`) · `pnpm run format` (oxfmt `--check`) · `pnpm run typecheck` (tsc
`--noEmit`) · `pnpm run test:coverage` (vitest + thresholds) · `uv run python scripts/changelog-gate.py ledger
--landing squash` · the two residue scans, `git diff-index --quiet HEAD`, and `git ls-files --others --ignored
--exclude-standard` above · `git ls-remote --heads origin <branch>`.
