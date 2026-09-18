# Error-code consistency audit

This audit covers commit `7990a91`. It checks model-emitted error codes against message prose and docs. It assembles the payload, served-state, and io/undo/misc family reports. It proposes only doc or prose edits.

**Reviewer verification (the session that commissioned this audit re-checked the high-severity claims against the working tree instead of accepting them):**

| Finding | Verdict | Evidence checked |
| :--- | :--- | :--- |
| F1 — glossary routes a no-lease anchor to `[E_UNSERVED_RANGE]` | **confirmed, scope corrected** | `src/hashline/lease-resolve.ts:150-155`: `if (!fromLease \|\| !toLease) throwStaleAnchor(...)` → `[E_STALE_ANCHOR]`; the module comment at `:22-24` and `:133-134` says the same. `[E_UNSERVED_RANGE]` is for a line **inside** the span (`src/hashline/served-verification.ts:265`, `:276`) and, on the content path, for a boundary anchor with no served position (`:678`, `:683`). The glossary sentence is wrong for the lease path only, so the fix scopes it — it does not swap the code |
| F2a — `[E_UNSERVED_RANGE]` carries opposite read advice | **confirmed**, severity HIGH → **MED** | `src/hashline/served-verification.ts:690-693` really does say a full read is needed, while the other variants append `retryHint()`. A model acting on the failure message is correct; the *docs* promise the no-read remedy universally |
| F2b — README promises `details.unservedKind` | **confirmed, HIGH** | `rg -n unservedKind` over the tree returns only `README.md:197`, `docs/adr/0014-user-model-audience.md:21` and `:33` — no producer in `src/` |
| F3a — `[E_NOOP_LOOP]` rejects lack `[MODEL]` | **confirmed, LOW** | `src/noop-guard.ts:82-83` (bare); the notice variants at `:89-90` correctly stay `[USER]`-dimmed |
| F3b — "the batch" on a single-item call | **confirmed, LOW** | `src/mutation-engine/pipeline.ts:821` passes `batch: true` unconditionally inside the item loop, and that same loop serves single-item calls (`if (items.length === 1) throw error` in its `onRejected`), so the single-item wording at `src/noop-guard.ts:83` is production-unreachable |
| F2c — README boundary scope | **resolved — not an open question** | README's boundary clause is right for the content path (`src/hashline/served-verification.ts:678`, `:683`); the wrong artifact is `CONTEXT.md:70`, i.e. F1's fix |
## Scope and method

Scope included `src` producers. Scope included message prose. Scope included `README.md`. Scope included `CONTEXT.md`. Scope included `prompts`. Scope included ADRs. Scope included the two `docs/spec` staleness specs.

A claim was accepted only with `file:line` evidence. A verbatim quote was required. An adversarial re-check was required. Severity was downgraded where model action was unchanged. An item was refuted where the mandate was misread. An item was marked needs-human where files underdetermine governance.

## Summary

Codes scanned: 16 model-emitted codes. Auxiliary items examined: 2. Total examined: 18. Distinct codes with confirmed flags: 8. Distinct codes with no finding: 8. Needs-human items: 2. Refuted items: 4.

Confirmed flag findings: 10. Consistent confirmations: 3. The gap is docs or prose only. One needs-human item is behavioral governance.

Flagged codes in severity order:

- `E_UNSERVED_RANGE` — HIGH: the phantom `details.unservedKind` promise (F2b).
- `E_STALE_ANCHOR` — MED: `CONTEXT.md:70` routes a no-lease anchor to the wrong code (F1).
- `E_TARGET_LOST` — HIGH needs-human.
- `E_BAD_PAYLOAD` — LOW.
- `E_BAD_ANCHOR` — LOW.
- `E_UNSUPPORTED_FILE` — LOW.
- `E_NOOP_LOOP` — LOW.
- `E_ACCESS` — LOW.
- `E_UNDO_UNAVAILABLE` — LOW.
- `E_UNSERVED_RANGE` prose split (F2a) — MED, reviewer-adjusted.

## Per-code table

| Code | Producer(s) (file:line) | Remedy prose | README row | CONTEXT.md | Verdict |
|---|---|---|---|---|---|
| `E_BAD_PAYLOAD` | `src/utils.ts:59`, `src/payload-contract.ts:327`, `src/mutation-engine/pipeline.ts:661`, `src/mutation-engine/pipeline.ts:1010`, `src/edit-tool.ts:138`, `src/paths.ts:19`, `src/paths.ts:21`, `src/fs-write.ts:19`, `src/fs-write.ts:122`, `src/hashline/resolve.ts:287` | Varies by layer | `README.md:180-199` table entry | Not cited | confirmed |
| `E_BAD_ANCHOR` | `src/hashline/resolve.ts:343`, `src/hashline/resolve.ts:351`, `src/hashline/resolve.ts:353`, `src/hashline/resolve.ts:355`, `src/hashline/parse.ts:10`, `src/hashline/parse.ts:14`, `src/hashline/parse.ts:34` | Varies; full retry only on some paths | `README.md:184-185` | Not cited | confirmed |
| `E_STALE_ANCHOR` | `src/hashline/lease-resolve.ts:155` | Re-read for fresh anchors | `README.md:180-199` table entry | `CONTEXT.md:70` routes no-lease to wrong code | confirmed |
| `E_SERVED_ECHO` | `src/hashline/served-guard.ts:258-264` | Remove anchors and retry, or use `mode: "literal"` | `README.md:187` | `CONTEXT.md:141-142` | consistent |
| `E_REVERSED_ANCHORS` | No producer cited in source reports | Swap and retry, or healed `[USER]` | `README.md:180-199` table entry | Not cited | consistent |
| `E_EMPTY_RANGE` | No producer cited in source reports | Use `write` instead | `README.md:180-199` table entry | Not cited | consistent |
| `E_NOT_FOUND` | `src/validation.ts:17` | Check `file`, use ls, retry | `README.md:190` omits remedy by design | Not cited | consistent |
| `E_ACCESS` | `src/validation.ts:28`, `src/validation.ts:32` | Retry with real location; verify reachability | `README.md:191` coarse row | Not cited | confirmed |
| `E_UNSUPPORTED_FILE` | `src/read.ts:87`, `src/read.ts:91`, `src/read.ts:95`, `src/validation.ts:43`, `src/validation.ts:48`, `src/validation.ts:53` | Rich on edit path; bare on read path | `README.md:180-199` table entry | Not cited | confirmed |
| `E_UNDO_STALE` | `src/edit-undo.ts:151`, `src/edit-undo.ts:164` | Terminal; no retry sentence | `README.md:180-199` table entry | Not cited | refuted — not a finding |
| `E_UNDO_UNAVAILABLE` | `src/mutation-engine/pipeline.ts:1048` | Retry edit, or use write | `README.md:194` omits remedy | Not cited | confirmed |
| `E_LARGE_FILE` | No producer cited in source reports | Not cited | `README.md:180-199` table entry | Not cited | consistent |
| `E_STALE_RANGE` | `src/hashline/served-verification.ts:401`, `src/hashline/served-verification.ts:449`, `src/hashline/served-verification.ts:469`, `src/hashline/served-verification.ts:632`, `src/hashline/served-verification.ts:644` | Retry with served anchors; no read needed | `README.md:196` | `CONTEXT.md:44-46`, `CONTEXT.md:89-90` | consistent |
| `E_UNSERVED_RANGE` | `src/hashline/served-verification.ts:619`, `src/hashline/served-verification.ts:690-693`, `src/hashline/lease-resolve.ts:133-134`, `src/hashline/lease-resolve.ts:155` | No-read vs must-read variants disagree | `README.md:197` | `CONTEXT.md:48-49`, `CONTEXT.md:70` | confirmed |
| `E_NOOP_LOOP` | `src/noop-guard.ts:82`, `src/noop-guard.ts:83`, `src/noop-guard.ts:89`, `src/noop-guard.ts:90`, `src/mutation-engine/pipeline.ts:821` | Resend warning; batch noun misfires | `README.md:180-199` table entry | Not cited | confirmed |
| `E_BATCH_ABORT` | `src/mutation-engine/pipeline.ts:619-623` | Fix real cause; atomicity trailer | `README.md:199` | `CONTEXT.md:51-53` | refuted — not a finding |
| `E_UNKNOWN` | `src/mutation-engine/engine.ts:25`, `src/mutation-engine/engine.ts:30` | Internal fallback only | Correctly absent from `README.md:180-199` | Correctly absent | refuted — not a finding |
| `E_TARGET_LOST` | No `src` producer; `grep -rn E_TARGET_LOST src/` is 0 hits | Proposed only | Correctly absent | Correctly absent | needs-human |

## Flagged findings

### 1. `E_BAD_PAYLOAD` — audience prefix and remedy variance

Artifact says nothing directly. Code emits several variants. Example: `src/utils.ts:59` `` `[E_BAD_PAYLOAD] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}` ``. Counterpart: `src/payload-contract.ts:327` `` `[MODEL] [E_BAD_PAYLOAD] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}` ``. Null-file diverges: `src/mutation-engine/pipeline.ts:661` + `:1010` `"[MODEL] [E_BAD_PAYLOAD] Edit request file could not be inferred from anchors."`. Counterpart adds remedy: `src/edit-tool.ts:138` `"[MODEL] [E_BAD_PAYLOAD] Edit request file could not be inferred from anchors. Pass the text file to edit."`. Null-byte diverges: `src/paths.ts:19` + `:21` `"[MODEL] [E_BAD_PAYLOAD] Path contains null byte"`. Counterpart adds remedy: `src/fs-write.ts:19` + `:122` `"[MODEL] [E_BAD_PAYLOAD] Path contains null byte. Pass a plain file string and retry."`.

Code path is layered. Import `src/hashline/resolve.ts:1` plus call `:287` was verified. Item-level vs root-level differ. `src/mutation-engine/pipeline.ts:635-640` calls `resEdit` with 3 keys only. `src/payload-contract.ts:136-160` `itemFrom` gate rejects earlier. The `utils` throw is unreachable via the tool path.

Disagreement is prose polish. Missing `[MODEL]` is display-layer only. ADR states this at `docs/adr/0014-user-model-audience.md:19`. Required action stays inferable. Adjacent layer carries the remedy.

Minimal fix: copy the richer remedy into the barer sibling. Or scope the README row by level. Severity: LOW.

### 2. `E_BAD_ANCHOR` — heal verbs and missing remedy on bare paths

Artifact promises full remedy. `README.md:184-185` promises `Nothing was written; pass the bare 3-char anchor and retry.` Code gives full remedy only sometimes. Example: `src/hashline/resolve.ts:351` `` `[MODEL] [E_BAD_ANCHOR] stripped diff-preview marker from anchor_from/anchor_to "${trimmed}". Nothing was written; pass the bare 3-char anchor and retry.` ``. Same pattern at `:353,:355`. Bare paths lack it: `src/hashline/parse.ts:10` `` `[MODEL] [E_BAD_ANCHOR] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").` ``. Same shape at `:14`, `:34`. Past-tense variant: `src/hashline/resolve.ts:343` `` `[MODEL] [E_BAD_ANCHOR] extracted first hash "${hash}" from ${lines}-line block — use bare "${hash}" next time` ``.

Code throws on healed input. Only `swapReversedRanges` should use healed `[USER]`. Past tense on a `throw` misstates write status. Multi-item calls add trailer at `pipeline.ts:648` and `:533`.

Disagreement is over-promised README plus past-tense throw. Model action is unchanged. Every variant names the bare 3-char correction.

Minimal fix: narrow the README sentence to covered paths. Reword `:343` to present-tense refusal plus retry verb. Severity: LOW.

### 3. `E_UNSUPPORTED_FILE` — read path lacks audience and retry

Artifact mandate is at `docs/adr/0014-user-model-audience.md:19`. It pins `error content headers are emitted as [MODEL] [E_*]`. Code splits by surface. Read path is bare: `src/read.ts:87` `` `[E_UNSUPPORTED_FILE] Path is a directory: ${rawPath}.` ``. Also `:91` `` `[E_UNSUPPORTED_FILE] Path is a binary file: ${rawPath} (${prepared.description}). Hashline edit only supports text files.` ``. Also `:95` image variant. Edit path is rich: `src/validation.ts:43` `` `[MODEL] [E_UNSUPPORTED_FILE] Path is a directory: ${path}. Pass the text file inside it (a file, never a directory) in "file" and retry.` ``. Also `:48,:53` binary/image variants.

No comment documents a read-vs-edit split. Identical triggers yield different audience plus remedy.

Disagreement is undocumented surface split. Model action is unchanged. Read path still names kind plus text-only support.

Minimal fix: document the split if intentional. Or add `[MODEL]` plus retry verb to read path. Severity: LOW.

### F1. No-lease routed to wrong code in `CONTEXT.md`

Artifact says: `CONTEXT.md:70` — `"Superseded by ADR-0016: an anchor with no lease now rejects fail-closed (\`[E_UNSERVED_RANGE]\`)"`. Code does otherwise: `src/hashline/lease-resolve.ts:155` — `"if (!fromLease \|\| !toLease) {"` → `throwStaleAnchor` (`[E_STALE_ANCHOR]`). Glossary confirms: `src/hashline/lease-resolve.ts:22-23` — `"lost identity is \`[E_STALE_ANCHOR]\` (no lease) or \`[E_STALE_RANGE]\`"`.

Two paths disagree in opposite directions. Lease path: `src/hashline/lease-resolve.ts:150-155` — `if (!fromLease || !toLease) throwStaleAnchor(…)` → `[E_STALE_ANCHOR]`. Content path: `src/hashline/served-verification.ts:678`, `:683` — `anchor_from "…" has no served position` → `[E_UNSERVED_RANGE]`. So the glossary sentence is right about a never-served *line* and wrong about a no-lease *anchor*: a model that branches on `CONTEXT.md` waits for the wrong code after a lease-path rejection.

Minimal fix: scope `CONTEXT.md:70` — "an **anchor** with no lease rejects `[E_STALE_ANCHOR]`; a line inside the span that was never served rejects `[E_UNSERVED_RANGE]`". Severity: MED (reviewer-adjusted from HIGH: the failure message itself is correct, so only a doc-reading model is misled).

### F2a. `E_UNSERVED_RANGE` carries opposite read advice

Artifact docs describe only no-read serve. See `CONTEXT.md:48-49` and `README.md:197`. Code has two variants. No-read: `src/hashline/served-verification.ts:619` — `` `"[MODEL] [E_UNSERVED_RANGE] line ${i + 1}${where} was never served.\nCurrent range:\n${rendered}\n${retryHint()}"` ``. Must-read: `:690-693` — `"A full read will re-sync the served mirror — the served range below is current content, "` + `"but retrying without re-reading cannot clear a stale duplicate outside the served window.\n"`. Selector is at `:426` — `"if (from === undefined \|\| to === undefined)"`.

Model following README no-read advice loops forever. The message itself admits this. The condition is a `throwUnverified` rejection.

Minimal fix: document both variants in README and CONTEXT. Name when a full read is required. Severity: MED (reviewer-adjusted from HIGH: the must-read variant's own message is honest, so the model is not misled at failure time — the docs are what over-promise the no-read remedy).

### F2b. `README` promises phantom `details.unservedKind`

Artifact says: `README.md:197` — `"details.unservedKind\` is \`interior\` or \`boundary\`."`. Code emits nothing: `grep -rn unservedKind src/` → 0 hits. Origin is unimplemented ADR text at `docs/adr/0014-user-model-audience.md:21` — `` `"E_RANGE_UNSERVED"+\`E_RANGE_UNVERIFIED\`→\`E_UNSERVED_RANGE\` (with \`details.unservedKind=\"boundary\"\|\"interior\"\`)"` ``.

Docs promise a machine field. No producer emits it. Programmatic consumers branching on it fail.

Minimal fix: delete the field promise from README. Do not implement the field here. Severity: HIGH.

### F3a. `E_NOOP_LOOP` rejects lack `[MODEL]` prefix

Artifact mandate is at `docs/adr/0014-user-model-audience.md:19` — `"error \`content\` headers are emitted as \`[MODEL] [E_*] …\` normal."`. Code omits prefix: `src/noop-guard.ts:82` — `` `"[E_NOOP_LOOP] ${input.ref}: identical edit … resend will reject the batch. Current range:\n${rendered}"` ``. Same bare prefix at `:83,:89,:90`. No downstream fixup: `src/mutation-engine/pipeline.ts:828` — `"if (decision.action === \"reject\") throw new Error(decision.message);"`.

Code still carries code plus range. It carries explicit resend warning. Retry steps stay intact.

Disagreement is recognizability only. Prompt contract is at `prompts/edit-guidelines.md:6` — `"a \`[MODEL]\` line in \`content\` is your retry instruction"`.

Minimal fix: add `[MODEL]` to reject variants only. Severity: LOW.

### F3b. Batch wording fires on single-item calls

Artifact code hardcodes batch: `src/mutation-engine/pipeline.ts:821` — `"batch: true,"` in sole caller `:815-828`. Message assumes batch: `src/noop-guard.ts:82` — `"resend will reject the batch."`. Correct single phrasing exists at `:83` — `"resend will reject. Current range:"`. That variant is production-unreached.

Code misnames a single edit as batch. Retry steps are identical. Only the noun misfires.

Minimal fix: correct the caller flag or message noun. Severity: LOW.

### Flag 1. `E_ACCESS` README row is coarse

Artifact row says: `README.md:191` `` `\| \`[E_ACCESS]\` \| The path is not readable or writable. \|` ``. Code has finer triggers: `src/validation.ts:28` `` `[MODEL] [E_ACCESS] Too many symbolic links while resolving: ${path}. Retry with the real file location.` ``. Also `src/validation.ts:32` `` `[MODEL] [E_ACCESS] Cannot access file: ${path}. Verify the "file" value exists and is reachable, then retry.` ``. Per-variant remedies live at `src/validation.ts:23,28,32`.

Model follows the message. Prompt contract is at `prompts/edit-guidelines.md:6` `` `a \`[MODEL]\` line in \`content\` is your retry instruction — follow it from the message alone` ``. Recovery belongs in error text per `docs/adr/0015-named-object-edit-payload.md:28`.

Row is coarse, not false. Unresolvable path reads as not readable. No opposite remedy is stated.

Minimal fix: expand the README Meaning cell to list symlink plus access failures. Severity: LOW.

### Flag 3. `E_UNDO_UNAVAILABLE` missing prefix plus README drops remedy

Artifact producer is: `src/mutation-engine/pipeline.ts:1048` `` `` `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the edit, or use write if the store cannot be recovered.` `` ``. Siblings carry `[MODEL]`. See `src/validation.ts:17,23,28,32` and `src/mutation-engine/pipeline.ts:620,661,1010`. README drops remedy: `README.md:194` `` `\| \`[E_UNDO_UNAVAILABLE]\` \| Undo history could not be persisted to the hash store; the \`edit\` was refused and the file was left unchanged. \|` ``.

Edit path is confirmed. Flow is `pipeline.ts:1048` → `toFailure` → `src/edit-tool.ts:172` `` `throw new Error(result.message);` ``. Prefix inconsistency is real. Model action is unchanged. Message itself says retry explicitly.

README column is `Meaning`, not `Remedy`. See `README.md:190` for same pattern. Table header is at `README.md:180-182`.

Minimal fix: add `[MODEL]` to the producer line. Optionally expand README Meaning cell. Severity: LOW.

## Refuted — not a finding

### F3c. Prefix all four plus dead single variants

Claim asked to prefix notices. Evidence: `src/mutation-engine/pipeline.ts:829` — `"if (decision.action === \"warn\") warnings.push(decision.notice);"`. Rendering is at `src/edit-render.ts:102-104` — `"theme.fg(\"dim\", warnings.join(\"\\n\"))"`. ADR classifies these as `[USER]`-dimmed. See `docs/adr/0014-user-model-audience.md:19` — `"wraps \`warnings\`/\`driftNotice\` with \`theme.fg(dim, \"[USER] …\")\""`. Single variants are reachable. Re-export is at `src/edit-presentation.ts:79`. Test seam is at `test/core/edit-presentation.test.ts:6` — `"import { runNoopPolicy }"`.

Refutation reason: notices must not carry `[MODEL]`. Proposed fix would violate audience split. Only rejects at `:82,:83` are in scope.

### F4. `E_BATCH_ABORT` served but never recorded

Claim saw contradiction between README and recording. README says: `README.md:199` — `"the current range is served as fresh \`HASH│content\` rows."`. Glossary says delivered rows are serves. See `CONTEXT.md:7-8` — `"To deliver a line's \`HASH│content\` row into the model's context through tool output. … an error's fresh-anchor feedback serves its rows."`. Also `CONTEXT.md:51-53` — `"return the current range as fresh rows, which themselves count as serves"`. Serve block is at `src/mutation-engine/pipeline.ts:619-623` — `"[MODEL] [E_BATCH_ABORT] edit[${b.index}] … NOTHING was written"` plus `serveRowsForEdit`. Recording only at `:332,:557` is expected. Comment `:611-613` `"so the retry never needs a re-read."` holds via surviving leases.

Refutation reason: delivered rows are serves by definition. File is unchanged so prior leases survive. No model-action difference exists.

### Flag 2. `E_UNDO_STALE` missing `[MODEL]` prefix

Fact is true. Prefix absence confirmed at `src/edit-undo.ts:151` `` `text: \`[E_UNDO_STALE] cannot undo on ${path}: file no longer exists.\`,` `` and `:164`. Clear happens first at `:147,160`. Mandate was misread. ADR list at `0014:40` `` ``src/hashline/parse.ts`, `src/payload-contract.ts`, `src/validation.ts`, `src/file-content/*`, …` `` never lists `src/edit-undo.ts`. Undo refusals are direct `content` returns. They never pass through `engine.ts:19-30` `extractCode`. `[MODEL]` denotes retryability per `prompts/edit-guidelines.md:6`. `E_UNDO_STALE` is terminal. Its channel is at `prompts/undo-last-edit-guidelines.md:1`.

Refutation reason: prefixing would falsely promise retry. Precedent includes `src/read.ts:87` and `src/noop-guard.ts:82-83,89-90` and `src/utils.ts:59`. At most a LOW docs nicety exists.

### Flag 4. `E_UNKNOWN` undocumented

Fact is true. Fallback lives at `src/mutation-engine/engine.ts:25` `` `return m ? m[1]! : "E_UNKNOWN";` `` and `:30` `` `const code = error instanceof Error ? (errCode(message) ?? extractCode(message)) : "E_UNKNOWN";` ``. No producer emits `[E_UNKNOWN]`. Type is generic at `src/mutation-engine/types.ts:81-84`. Surface drops code at `src/edit-tool.ts:172`. README table at `README.md:180-199` holds 16 model-emitted codes.

Refutation reason: internal fallback is not model-emitted. Documenting it would teach a phantom code. Exclusion is correct.

## Open questions for a human

### F2c. `README` boundary scope for `E_UNSERVED_RANGE`

README says: `README.md:197` — `"A line inside the resolved range or a boundary anchor was never served"`. Session path reserves the code for interior. See `src/hashline/lease-resolve.ts:133-134` — `` `"[E_UNSERVED_RANGE]" stays reserved for an interior line strictly between the anchors"` ``. Boundary-no-lease goes to `E_STALE_ANCHOR` at `:155`. Content path fires `E_UNSERVED_RANGE` on boundary. See `src/hashline/served-verification.ts:542-543` plus `:674-682` — `throwUnverified` fires when `"anchor_from \"${startHash}\" has no served position"`.

Resolved by the reviewer check: README's boundary clause matches the content path (`src/hashline/served-verification.ts:678`, `:683`, where a boundary anchor with no served position does reject `[E_UNSERVED_RANGE]`). The artifact that needs the fix is `CONTEXT.md:70` — F1. No open question remains.

Fix: fold into F1's glossary scoping. Severity: not a finding.

### Flag 5. `E_TARGET_LOST` specified but unimplemented

Spec proposes D1 plus D6 plus new code. See `docs/spec/content-addressed-line-identity-mvcc.md:781` plus `:786` plus `:794` `` `\| … \| \`lease-resolve.ts\` … \| \`[MODEL] [E_TARGET_LOST]\` \|` ``. Also `docs/spec/stale-identity-reject-and-serve.md:49,54,80-81,89-90,93`. Code has no producer. Type is at `src/hashline/served-verification.ts:30` `` `export type ServedCode = "E_STALE_RANGE" \| "E_UNSERVED_RANGE";` ``. Search is empty across `src/ README.md CONTEXT.md prompts/`.

Status text conflicts. Appendix claims normative-where-contradicting. Header says `Status: **proposed**`. Companion says `Status: proposed` at `docs/spec/stale-identity-reject-and-serve.md:3`. ADR says unstarted at `docs/adr/0018-region-scoped-rejection-serves.md:8-12` — `proposed … stays \`proposed\` until the behavior changes … The implementation is deliberately not started yet`.

Human must choose implement vs downgrade. No docs-only fix suffices. Code-emitted retry prose risks overwrite. Severity: HIGH.

## Cross-report contradictions

No direct contradiction was found. All three agree on severity discipline. `[MODEL]` omission alone is LOW. README coarseness alone is LOW. Phantom machine fields are HIGH.

One apparent tension was checked. Served-state flags missing `[MODEL]` on `E_NOOP_LOOP`. Io/undo excuses missing `[MODEL]` on `E_UNDO_STALE`. Rationale is consistent. Retryable edit-path throws need `[MODEL]`. Terminal direct returns must not carry it.

One bar difference was checked. `E_NOT_FOUND` omission is consistent. `E_UNDO_UNAVAILABLE` omission was flagged. Header resolves it. Column is `Meaning` at `README.md:180-182`. Both rows match that design. Flag 3 prefix half still stands. Its README half is weak.

Spec handling is consistent. Served-state marks `E_TARGET_LOST` as open question. Io/undo marks it needs-human. Payload report does not scope it. No conflict exists.
