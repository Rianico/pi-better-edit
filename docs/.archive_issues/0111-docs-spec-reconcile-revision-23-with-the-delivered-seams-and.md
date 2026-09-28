# docs(spec): reconcile Revision 23 with the delivered seams and uniqueness equation

> **Archived from pre-migration issue #111.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-14T14:42:54Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC).

**Operator decision Q1 = yes**: the spec is the document the review process reads, so drift between its normative wording and the delivered code is fixed *in the spec*. ADR-0017 recording the vacuum ownership did not stop review 4 from re-flagging it — that is the evidence for amending the source of truth instead of adding another ADR.

Docs-only change: **no code, no test, no behaviour change.** Every edit below is a reconciliation of the spec with code that is already delivered, tested and reviewed; the one requirement-level clarification (item 1) is the semantics the delivered oracle already implements and that the operator confirmed in review 3 Q3.

## Edits (make exactly these; nothing else)

**1. §3.4.4 item 4 (lines 298-299) — uniqueness is embedding-level, not raw-path counting.**

Replace the sentence `A pairing $(p, c)$ is optimal-path unique iff it lies on **every** maximal traceback path. If multiple traceback paths exist (ambiguous duplicate lines), lines in that interval are marked **UNPAIRED / RETIRED**.` with (transcribe verbatim):

> A pairing $(p, c)$ is optimal-path unique iff it lies on **every** maximal optimal **pairing** (embedding) of the interval's LCS. Distinct DP traceback walks that only permute down/right skips around identical matches yield the *same* pairing and are therefore not ambiguous — e.g. `[A, X, B]` vs `[A, Y, B]` has exactly one embedding $\{(1,1),(3,3)\}$, so `A` and `B` stay paired (raw traceback-path counting would wrongly retire them). If two or more distinct optimal pairings exist (ambiguous duplicate lines, e.g. `[A, B]` vs `[B, B]`, where the single `B` could pair with either duplicate), lines in that interval are marked **UNPAIRED / RETIRED**.

**2. §5.3 decision table (line 642) — overlap attribution + item-error propagation.**

- Change the seam cell of the `Overlapping/nested spans in multi-edit batch` row from `pipeline.ts` (`parseEdits`) to `pipeline.ts` (`assertBatchSpansDisjoint`, on lease-resolved baseline spans).
- Add this row immediately after it (transcribe verbatim):

> | Malformed payload or apply-time failure inside a multi-item batch | `pipeline.ts` | the item's **own** code (`E_BAD_ANCHOR`, `E_REVERSED_ANCHORS`, `E_SERVED_ECHO`, `E_STALE_RANGE`, …) | Rejects the whole call — nothing was written; the message carries the atomicity trailer |

**3. Seam lists — the delivered module layout.**

- Stage 1 seams (line 665) and the `Re-architect src/snapshot-store.ts` bullet (line 668): name the package `src/snapshot-store/{index.ts,vacuum.ts,migrate.ts}` instead of the monolithic `src/snapshot-store.ts` (`index.ts` re-exports, so every existing import path still resolves).
- Stage 2 seams (line 690): add `src/hashline/lease-resolve.ts`.
- Stage 3 seams (line 705): vacuum ownership is `src/snapshot-store/vacuum.ts` (LRU eviction policy, global budget, per-path retention and the pinning rules), alongside `src/served-session/session.ts` and `src/lifecycle-hooks/index.ts`.
- Architecture boxes: line 343 `src/hash-store.ts & src/snapshot-store.ts` → the package form; line 362 should name the delivered resolution modules, including `src/hashline/lease-resolve.ts`. Preserve each box's right border column exactly.

**4. Stage deliverables — record the seam guards (operator decision Q2 = keep).**

Add one bullet to the Stage 1 test-deliverable list naming the seam guards that now accompany these seams: `test/arch/snapshot-store-module-boundary.test.ts` (the package split), `test/arch/serve-recording-seam.test.ts` and `test/arch/undo-schema-seam.test.ts` (the shared serve writer and the dropped undo-schema forwarder), `test/arch/terminology-synonyms.test.ts` (the `serve` vocabulary rule). State that they are deliverables of these stages, not incidental extra suites.

**5. Revision bump.**

Title (line 1) and the `Revision:` line (line 4): 22 → 23, with the revision blurb extended by a clause recording what changed — reconciliation of the normative text with the delivered implementation: embedding-level optimal-pairing uniqueness, batch-overlap and item-error attribution, and the delivered module layout. Leave the `Supersedes:` line (line 7) untouched.

## Acceptance criteria

- The diff is confined to `.scratch/mvcc-sparse-dense-anchors/spec.md`; `git diff --stat` shows nothing else.
- No probe expectation, no error-code attribution, no equation and no Stage-0 statement changes other than the four edits above. In particular the Stage-0 harness path references (#94) and the four fail-closed probe statements (lines 333, 651-661) are untouched.
- The outdated phrases are gone: no occurrence of `every** maximal traceback path` remaining unqualified, no `src/snapshot-store.ts` seam entry, no `parseEdits` overlap attribution.
- The clarification in edit 1 describes the delivered behaviour: `test/hashline/lcs-path-uniqueness.test.ts` (the brute-force oracle) and the `[A, B]` → `[B, B]` regression both still pass unchanged, and the `[A, X, B]` vs `[A, Y, B]` case is documented in the amendment exactly as the code's doc comment describes it.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green (this is a docs-only change; a red here means the edit leaked into code).
- Commit type `docs`.


## Comments

### @Rianico — 2026-09-15T07:40:39Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
