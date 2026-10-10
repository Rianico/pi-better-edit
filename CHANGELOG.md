# Changelog

## [Unreleased]

### Features
* **edit:** declare the optional wire fields (`text`, `text_ref`, `at`, root `mode`, and `text_ref.file`) nullable so the served schema admits the `null` that admission already reads as absent, and reframe both XOR refusals as an explicit binary field choice — the flat wire contract, the required fields, and admission behaviour are unchanged. (ADR-0036) (#81)

## [2.10.1] - 2026-10-09

### Bug Fixes
* **edit:** read a null in the nested `text_ref.file` as absent and name the fields that are genuinely required, so a harness using strict structured output is no longer refused for a call it has no way to spell differently. (#77)

## [2.10.0] - 2026-10-09

### Features
* **pi-lens:** retire the frozen v1 bridges and mirror through the unified v2 File I/O Lifecycle Bridge — a single `io-bridge` adapter records served spans (caller content sliced per single-range span, disk evidence only when the notification carried no bytes) and file mutations (whole-file authorship as `write`) via structural `Symbol.for("pi-lens:io-bridge")` detection with no pi-lens import; mutated-file notifications precede served-span notifications so facet-split records reflect post-mutation state; the integration stays optional (only the entry point wires it, removal recipe in README) with the boundary test pinning the v2 surface. (#66)

### Code Refactoring
* **errors:** revise all `E_*`/`W_*` refusal texts to concise single-fact STE100 sentences with structured bullets for batch failures and overlaps, and teach `mode: "literal"` on the refusal surface — no behavior change. (#61)

### Bug Fixes

* **bash-view:** normalize CRLF line endings and strip BOM from observed `bash` stdout before the D9 byte-equality gate, and admit semicolon-chained deterministic silent prefixes (literal-operand `cd`, `pwd`, `true`, `:`) before a terminal view — fail-closed on all other output preserved. (#68)
* **edit:** read explicit `null`/`undefined` in `text`/`text_ref`/`at`/`mode` as absent at admission, and name the field to drop in the doubly-specified refusal — XOR contract stands, no structural schema change. (#74)

## [2.9.0] - 2026-10-08

### Features
* **bash-view:** intercept pure file views in `bash` results and replace them with anchored slice previews — `cat`/`head`/`tail`/`sed -n` single-file views (incl. single pre-view `cd`-prefixed `&&` chains, sanctioned `cat | head/tail` pipelines, and a leading `rtk` transparent wrapper in source positions) are classified by AST span kinds (`silent` | `view` | `unsafe`, undetermined is `unsafe`) via `unbash`, slice-computed by exact interval arithmetic, verified byte-for-byte against the observed stdout (trailing-newline leniency only; filtering wrappers, drift, and encoding skew fail closed), and swapped wholesale for the canonical disk re-read with leases on exactly the served lines; every other shape (search, mutations, multi-file, `;`/`||`, flags like `cat -A`, `cd -`, post-view or multi-`cd` chains, truncation, errors) passes through byte-unmodified. Recorded as ADR-0033 with glossary (`pure view`, `slice view`, `silent segment`, `span kind`, `view replacement`, `interval algebra`, `transparent wrapper`) for issue #28. Test scope: `test/tools/bash-classifier.test.ts` (span matrix, algebra, R4 guards) + `test/tools/bash-rtk-wrapper.test.ts` + `test/tools/bash-view-lifecycle.test.ts` (replacement, slice leases, verification gate, session isolation). (#54)

## [2.8.0] - 2026-10-06

### Features
* **read:** drop image support and state the plain-text-only contract — image files are no longer delegated to the builtin reader and fail with `E_UNSUPPORTED_FILE` like other non-text kinds; the description leads with plain text, keeps the batched `windows` example with the `served`-mode anchor qualifier, and retains the UTF-8 BOM/encoding notes pending multi-encoding support. (#52)

* **hashline:** adopt 4-char anchors for tokenizer-stable references. `HASH_LEN` flips 3 to 4; every shape, regex and count word derives, so no other `src/` numeric change was needed and the stride stays `62^2 + 62 + 1 = 3907`. A 3-char token is now `E_MALFORMED_ANCHOR` with no compatibility path. The `E_LARGE_FILE` hash-space limit is scale-tested via a bounded uniqueness run plus a directly constructed error, and new-width coverage pins echo refusal, lease materialization, lineage anchors and resolve-seam rejection. (#49)
* **hashline:** reserve all-digit anchor spellings from allocation — a served one would be indistinguishable from a line number, so the 10,000-strong digit subcube is pre-marked in the allocation bitset and never served; usable space is `62^4 − 10^4 = 14,766,336` (a 0.0677 % shrink, alphabet unchanged), the stride stays coprime with both spaces, and digit-shaped spellings keep the ordinary unserved-lease refusal with the line-number note. (#49)
* **hashline:** derive anchors from (path, content) — allocation seeds xxh32 with the canonical absolute path, so byte-identical files at different paths serve disjoint anchor sets and an anchor served by another file is refused as foreign; content-only derivation remains available only through the explicit `contentOnlyHashes` seam, and `ANCHOR_GENERATION` starts at 1 so pre-change snapshots miss and recompute. (#49)
* **read:** decouple the served admission budget from the anchor-space ceiling — `SERVED_MAX_LINES` (200,000 lines ≈ 14.9 MB marginal worst case over the loaded text: ~6.1 MB of retained walked anchors post-paging plus the ~7.0 MB spelling-memo entry overhead over the same strings plus the fixed ~1.76 MB allocator bitset, probe-measured via `node --expose-gc scripts/measure-served-budget.mjs`, against the ~15 MB target) replaces the `MAX_HASH_LINES` alias on every served-cap seam, so a width change can never move the memory budget; the streaming refusal reports an honest lower bound ("more than N") while the preloaded gate reports the exact count. (#49)
* **hashstore:** refuse cross-generation anchors after the `ANCHOR_GENERATION` split — `file_undo` carries `anchor_generation` (legacy rows read as never-current; the pre-rename `canon_version` column is renamed in place, with a SAFETY note for the both-columns DROP fallback and the fail-closed concurrently-open pre-rename process), undo restores re-derive file-scoped anchors for stale rows instead of adopting them, and foreign-generation snapshot descriptors are rejected rather than written; the 3-part cache key (`CANON_VERSION:ANCHOR_GENERATION:checksum`) makes every existing `3:`-prefixed row unreachable (safe miss) and supersedes the 2-part shape ADR-0029 §1 describes; recorded as ADR-0031 with the accepted file-scope residual. (#49)
* **hashstore:** gate leases and snapshot hits on the anchor generation — the lease source skips pre-bump leases, snapshot lookups treat unknown-generation rows as misses that delete, and an open-time sweep drops snapshot/lineage/lease rows whose generation is unknown or foreign (leases orphaned by the snapshot sweep go in the same open); the served mirror is TTL-pruned, never swept; `file_snapshots` carries `anchor_generation` so the next bump sweeps mechanically. (#49)

### Bug Fixes

* **hashstore:** harden the open-time generation sweep — the orphan-lease delete is path-scoped (a lease naming a hash that survives only in a foreign path's row is now dropped), the four sweep deletes commit as one `BEGIN IMMEDIATE` unit with rollback on error, and the lease-names-live-snapshot invariant is scoped to the sweep point (the open-hook vacuum can strand a retired-past-grace lease until the next open). (#49)
* **hashstore:** close the sweep-hardening residuals — the orphan-lease delete now matches the grant's `committed = 1`, so a lease naming only an uncommitted row is swept with the other orphans while live leases are kept, and the caller-transaction guard plus the rollback-failure path are pinned by tests. Test scope: `test/integration/undo-generation-bump.test.ts` (3 new: uncommitted-lease sweep with live-lease control, caller-owned-transaction join with caller-rollback restore, rollback failure preserves the original error). Note: `engines.node` is now `>=24.0.0` and CI exercises 24 and 26, so the `isTransaction` guard is unconditional on every supported runtime. (#49)
* **hashstore:** stop the undo failure replay from laundering pre-generation rows — `upsertUndo` stamps from the payload (`entry.anchorGeneration ?? ANCHOR_GENERATION`, forwarded by `saveUndo`) instead of hard-coding current, so a replayed pre-generation row still reads as generation 0 and the restore gates re-derive file-scoped anchors rather than adopting its foreign hashes. Test scope: `test/integration/undo-generation-bump.test.ts` (1 new: failed-write replay preserves generation 0 and the served restore equals the current derivation, reddened by mutant flip). (#49)

* **hashline:** bound the anchor memo from the domain — `HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES` declared beside the WHY in `src/hashline/hash-identity.ts` (no product materialization hashes more than one served budget per call, so the memo stays fully effective in-budget while sitting ~40x below V8's smallest per-Map cap and the RangeError can no longer pre-empt `E_LARGE_FILE`); CI pins the exact floor `24.0.0`, the `isTransaction` SAFETY note names the experimental field, and a TARGET-coupling arch test pins the build target to `engines`. (#49)

### Documentation

* **read:** correct the served-budget magnitude note and harden the budget probe — the anchor-space comparison now names its axis (`~74x` in line count, `~32x` in bytes, not two orders of magnitude), and `scripts/measure-served-budget.mjs` asserts its width/alphabet literals against `src/hashline/alphabet.ts` and echoes the ~15 MB target from `SERVED_MAX_LINES`. Comment and probe only; no behaviour change. (#49)

### Miscellaneous Chores

* **scaffold:** refresh git and CI scaffolding contracts to the current generation (#51)

## [2.7.0] - 2026-10-05

### Features

* **canon:** **breaking** — the anchor whitespace class bumps to version 3: a frozen 28-code-point set (C0 whitespace except the U+001C–U+001F separators, SP, NEL, NBSP, OGHAM SPACE, U+2000–U+200A, U+2028/U+2029, U+202F, U+205F, U+3000, LRM, RLM, BOM) replaces the v2 ASCII-only strip; ZWSP/ZWNJ/ZWJ, SOFT HYPHEN, WORD JOINER, MONGOLIAN VOWEL SEPARATOR and the other C1 controls stay significant (ADR-0029, issue #22). Upgrading rotates anchors on lines containing newly-normalized code points exactly once: old `2:`-prefixed snapshot rows become unreachable and are reclaimed by the LRU vacuum, `file_undo` pins written under v2 keep resolving their own lineage (undo serves the stored v2 anchors verbatim — never re-derived), and live v2 leases may emit one bounded false drift signal before short-lived served state clears. (#45)
* **read:** add `mode: "verbatim"` for plain, anchor-free file text that writes no served state; the default `"served"` render is byte-identical to before. (#44)
* **tools:** remove the deprecated `file_path` payload alias, with no compatibility window. `read` no longer rewrites it to `file`, and `undo_last_edit` no longer rewrites it to `path` -- their `prepareArguments` seam existed only for that rewrite and is gone -- and the `write` hooks no longer read it. A `file_path` payload is now an unknown field on every surface and is refused; `edit` was already strict. (#40)

### Bug Fixes

* **read:** one row budget and a hashless verbatim path. The read row cap now derives from pi's `DEFAULT_MAX_BYTES` (50KB); the dead 200KB `MAX_READ_LINE_BYTES` default that only tests exercised is gone. `mode: "verbatim"` no longer applies the 238,328-line anchor-space cap or allocates line hashes: a file too large to anchor is still a readable, pageable file through the same `offset`/`limit`/`windows` machinery, the same 50KB per-line withhold, and the same silence on served state. The `served` path stays byte-identical and keeps the cap and its refusal message. (#44)

### Performance Improvements

* **read:** page a file instead of materializing it. A read walks the lines it needs — the page, and on the served path every row's anchor in that same walk — instead of building one heap string per line for the whole text (`split("\n")` costs ~50 B per line: 47.2 MB of heap for a 29.9 MB, one-million-line file). Verbatim pages the same bytes as before and builds no line array to slice a page out of — though an unbounded verbatim read still holds the lines it shows, since its page is the whole file — and a served read still holds one line array, in the snapshot store's own lineage write, bounded by the anchor-space ceiling. One refusal moves closer to the load: a file whose line count only crosses the cap after CR normalization now refuses there with the counted message, instead of passing the cap and dying inside the anchor space (that was #43's own regression, fixed before release). Otherwise served is byte-identical: same anchors, same order, same pages, hints and refusals, and the same 238,328-line cap. (#47)

### Code Refactoring

* **read:** remove the `read_skill` tool; `read` with `mode: "verbatim"` is the reference read. (#44)
* **read:** reshape the anchor seam the served read walks through. `AnchorWalk` (the new `src/hashline/index.ts` export) is assignment-only: it carries `assign` or `cached` and no persist hook, because the read path passes `noPersist` and the authoritative snapshot write is `upsertSnapshotFor`. The whole-content `hashesFor`/`readNormFile` seam is unchanged for the edit pipeline. (#47)

### Documentation

* **readme:** cite external evidence for hash-anchored lines — token-bleed reduction (Lamberti 2026) and subword-tokenizer drift (TokDrift) — under the failure-modes table and the anchor-hash space explanation. (#41)
* **readme:** state the 4-char anchor contract end to end — width words, worked `HASH│content` examples, the 62^4 space with the TokDrift citation, and ADR-0030 as the live width record. (#20)
* **docs:** rewrite CONTEXT.md, the live specs, the hash-anchors article, the absorption plan, the benchmarks anchor statement and the archive width mentions to the 4-char contract. (#20)
* **readme:** re-source token economics to Lamberti 2026 (22–58% repair-token cuts), removing the project-derived 40–60% claims. (#20)

### Code Refactoring

* **hashline:** make `HASH_LEN` the single owner of the anchor width — served-guard parse, domain-errors/payload-contract copy, resolve/parse reasons, and the probe stride all derive from it; behaviour and model-visible bytes unchanged at width 3, pinned by a new single-owner arch guard. (#20)

### Tests

* **hashline:** complete the 4-char fixture migration and re-pin capacity bindings. Half-migrated never-served fixtures move to live-width tokens with premise guards; the space-exhaustion payload and read-seam cap become exported constants pinned by binding tests; the edge script joins the width-consistency surface. No shipped logic changed. (#20)
* **hashline:** make the all-digit reservation refutable — duplicate-heavy pure and delta samples carry in-regime pins so the zero-digit assertions cannot go vacuous, the production probe is pinned directly from reserved and top starts, and served anchors resolve for real through the leased seam. Both reservation-site mutants redden exactly their test, then revert. Test-only, `src/` behaviour unchanged. (#20)
* **hashline:** correct the reservation WHY arithmetic — the subcube start is `52 × (62^3 + 62^2 + 62 + 1) = 12,596,220`, and the comment records the measured tops (distinct-line neighbourhood, shipped mixed sample) that keep the qualitative claim. Comment and ADR text only. (#20)
* **hashline:** harden the anchor-width guard to refute numeric and cross-surface drift — leaf walker sees re-exports and dynamic imports (with positive control), exact-line allowlists, a numeric-shape arm on `src/hashline/**`, derived shape samples, and a width-consistency check over `src/**`, `prompts/**` and the package description; `prompts/read.md` presence assertions become width-consistent. Test-only, behaviour unchanged. (#20)
* **hashline:** close the T1b guard gaps — one-arg numeric slice arm, space-form count words, derived foreign-width control, non-vacuous walk pins, dead allowlist entry removed, and dispatch refutation through the shared walk helper. Test-only, `HASH_LEN` stays 3. (#20)
* **hashline:** restore measured width-3 evidence with revision scope instead of repainting it, drive fixture differentials from the fixture token with width-5 tripwires, comment-proof the capacity source pins, generalize the class-quantifier arm past `3|4`, and fix the ADR-0019 supersession link. Docs plus tests only; no shipped logic changed. (#20)
* **hashline:** restore three revision-pinned archive quotes verbatim, record the width-3 digit rate beside its derived live figure, caveat token claims via ADR-0030, and pin the quantifier off-width filter with a live-width control. Docs plus tests only. (#20)
* **benchmarks:** remove the in-repo benchmark suite and its wiring — `benchmarks/`, eval/compare scripts, package scripts, config entries and the README project-benchmark surfaces. The independent third-party benchmark keeps its own section. (#20)
* **e2e:** re-home the deterministic edit battery out of the eval gate — the same 27 local scenarios run counted in `pnpm test` through the validated registry; the package/upstream comparison target is dropped with the benchmark suite. (#20)
* **e2e:** restore per-scenario verdicts in the re-homed battery — outcome, rejection code and preserved content asserted from the recovered comparator table; both accept-where-reject and wrong-content mutants redden. (#20)
* **readme:** drop the unbacked project-battery row and the stale scope comment — the battery cell now names the live `test/e2e` artifact. (#20)
* **e2e:** pin noop byte-identity and fix the T4b review residuals — B11/B12 assert `finalContent` equals the captured pre-edit bytes instead of an inert substring, the battery row fills its fourth cell, and the scope comment drops its duplicated clause. (#20)

* **hashline:** make the file-scope guarantees refutable — C1 asserts a measured intersection bound plus a deterministic same-position guard with a fixed colliding pair, a runtime shared spelling is shown resolving lease-scoped, C4 pins content-keyed verification against file-scoped allocation, and the tautological probe is deleted. Test-only plus a trailing-separator seed fix. (#20)
* **hashstore:** cover pre-bump leases and poisoned snapshots — pre-bump lease sets plus mirrors refuse cold and after a fresh read (with a positive control that the file still edits), poisoned current-generation rows are not served and are swept, planted foreign-generation rows miss both lookups, and the C1 cap WHY states the zero regime with the companion carrying refutability. (#20)
## [2.6.0] - 2026-10-03

### Features

* **edit:** flat wire item replaces the op-bearing shape. `replace_with`, the positional tuple form, and the legacy item keys are removed: sends using them now refuse with `unknown or unsupported fields` naming the replacement -- change `replace_with` payloads to `text` (or `text_ref` with `mode`), tuples to named-key items, and legacy keys to `anchor_from`/`anchor_to`. `file_path` remained a deprecated alias (warns, maps to `path`) on the non-edit tools only -- `edit` has always refused it; it was removed outright afterwards with no compatibility window. (#39)
* **edit:** ship the flat wire item -- exactly one payload per item (`text` for hand-written bytes, `text_ref{mode}` for served-span bytes with strictly required `mode: "copy" | "cut"`), optional `at` (`"in-place"` default; `"in_place"` refused), and `text: ""` in-place delete. Replace, insert-before, insert-after, delete, copy and move are each expressible (ADR-0027). Wording kept strictly additive in evidence. (#39)
* **edit:** `resEdit` barrel signature change -- the internal rename reaches the public barrel (`src/hashline/index.ts`): an internal rename that reaches a public barrel is consumer-visible even when no model sees it. (#39)

### Documentation

* **agents:** add `docs/agents/refining-tool-prompts.md` — the method for refining a tool's prompts (map the surfaces, map the pins, probe behaviourally, measure every ambiguity, review, ticket, verify the served text) and the principles behind it; linked from `AGENTS.md`. (#39)

## [2.5.0] - 2026-10-02

### Bug Fixes

* **release:** stop clearing the ledger before semantic-release (#36)

### Build System

* **build:** ship the prebuilt bundle as the extension entry on both install surfaces (#38)

## [2.4.0] - 2026-09-30

### Features

* **lens:** report served rows to pi-lens' read bridge through a domain-neutral observer seam (#29)
* **lens:** add the /pi-better-edit lens command and the .pi/agents/pi-better-edit.json config with env, project and global precedence (#29)
* **lens:** ship schemas/pi-better-edit.json for editor validation of the config (#29)
* **lens:** mirror landed mutations (edit, write, undo) to pi-lens' mutation bridge through a domain-neutral mutated-file seam (#33)

### Bug Fixes

* **lifecycle:** resolve the write tool's target from file before path and file_path (#29)

* **edit-undo:** derive undo-summary counts from source inputs, not rendered rows (#9)
* commit the edit and undo store state in one transaction, so a store failure can no longer leave the leases and the served mirror disagreeing (#16)
* **preview:** keep the debounced preview bound to the session that armed it across a session switch (#16)
* **drift:** key drift-notice episodes on the drifted line's position, so distinct lines sharing an anchor are no longer collapsed into one silent notice (#16)
* **packaging:** declare typebox as a peer dependency so host-provided copies cannot bypass the extension loader (#34)
* **deps:** pin undici, brace-expansion, fast-uri and esbuild to patched releases via pnpm override so the audit gate clears the transitive DoS and TLS-bypass advisories
### Documentation

* **readme:** record pi-lens interoperability and the read-expansion contract (#29)
* **prompts:** note that served rows may cover an expanded window without naming a provider (#29)
* **readme:** name the read-expansion workarounds and the deferred format interaction (#30)

### Tests

* **edit:** pin the payload wire shape against pi-lens' third-party shape adapters (#31)
* **lens:** pin the mutation-bridge entry shape, the drop accounting and the write-only notification invariant (#33)

### Code Refactoring

* **identity:** rename tombstone vocabulary to blockedHashes, cause contract to blocked-hash (#18)
* **identity:** retire the unused blocked-hash library-seam signal (no live callers), keeping the allocation guard (#25)

## [2.3.0] - 2026-09-27

### Features

* **edit-diff:** formalize the single-projection contract with counted span markers (#174)

### Bug Fixes

* verify preview against the session that served the anchors (#168)
* **edit-diff:** render small middle gaps whole, keep anchors aligned (#172)
* **edit-diff:** render ctx-0 middle gaps marker-only with correct skip (#175)

### Miscellaneous Chores

* **scaffold:** refresh the git contract to the current generation (#167)

## [2.2.0](https://github.com/Rianico/pi-better-edit/compare/v2.1.0...v2.2.0) (2026-09-22)

### Features

* **edit:** accept unread interior rows and cap applied-diff removals ([2e93732](https://github.com/Rianico/pi-better-edit/commit/2e93732e02f4af9d8ec99de1eeae4585ae3782e5)), closes [#149](https://github.com/Rianico/pi-better-edit/issues/149)
* **read:** add multi-window reads and consolidate the read path's stats ([2334352](https://github.com/Rianico/pi-better-edit/commit/2334352206adcf2c5c2cb0d3beaa1eae7ea8f0c4))

## [2.1.0](https://github.com/Rianico/pi-better-edit/compare/v2.0.0...v2.1.0) (2026-09-22)

### Features

* **errors:** diagnose numeric anchors in E_UNKNOWN_ANCHOR to steer away from line numbers ([#158](https://github.com/Rianico/pi-better-edit/issues/158)) ([33ccb0d](https://github.com/Rianico/pi-better-edit/commit/33ccb0da0ce524bd9aeffa6413d3912434c431ab))
* **mutation-engine:** aggregate multi-edit batch errors instead of failing fast on first error ([#159](https://github.com/Rianico/pi-better-edit/issues/159)) ([2217810](https://github.com/Rianico/pi-better-edit/commit/2217810c4f57e9f799ae8954b1b6181b3d0cd05d))
* ship a pre-bundled dist/index.js to cut extension startup latency ([#160](https://github.com/Rianico/pi-better-edit/issues/160)) ([8cdc716](https://github.com/Rianico/pi-better-edit/commit/8cdc7163d6eeb3c7da314c583b6acbbcba866605)), closes [#157](https://github.com/Rianico/pi-better-edit/issues/157) [#156](https://github.com/Rianico/pi-better-edit/issues/156) [#157](https://github.com/Rianico/pi-better-edit/issues/157) [#156](https://github.com/Rianico/pi-better-edit/issues/156) [GH#157](https://github.com/Rianico/GH/issues/157)

### Documentation

* add independent explicit edit benchmark section ([2db15fc](https://github.com/Rianico/pi-better-edit/commit/2db15fc9c155e4d89d3ed71cd7ea75fc4f34ac3e))
* **readme:** rewrite for v2 line-identity mvcc architecture ([b4bd3cb](https://github.com/Rianico/pi-better-edit/commit/b4bd3cb2a49998d8965425a1876623499aad40aa))

## [2.0.0](https://github.com/Rianico/pi-better-edit/compare/v1.7.0...v2.0.0) (2026-09-21)

### ⚠ BREAKING CHANGES

* the tool contract changed for a 1.x consumer. The
`[E_UNSERVED_RANGE]` code no longer exists: a retired bound with a live,
unshifted survivor is `[E_UNVERIFIED_RANGE]`. Edits that 1.x silently
healed -- an interior that shifted under the same 3-char anchor, or a
freed anchor re-used by a byte-identical line -- are now rejected as
`[E_STALE_RANGE]` / `[E_TARGET_LOST]` with the current range served as a
fresh read. A consumer branching on the old code, or relying on a healed
apply, must branch on the new codes and follow the served rows. No data
migration is required: the store migrates additively (HASH_STORE_VERSION
6 to 7) and stays readable by 1.x; anchors served before the upgrade need
one fresh read.

### Features

* **edit:** adopt line-identity MVCC with leases ([bd3a8f2](https://github.com/Rianico/pi-better-edit/commit/bd3a8f221cd7e3acf8c410a3d37237dba0c5201b))
* **edit:** gate reproduced served rows behind a literal declaration ([#134](https://github.com/Rianico/pi-better-edit/issues/134)) ([ba7c8d2](https://github.com/Rianico/pi-better-edit/commit/ba7c8d2ad41262ebf52f402f588f194f18f40323)), closes [#61](https://github.com/Rianico/pi-better-edit/issues/61) [#62](https://github.com/Rianico/pi-better-edit/issues/62) [#63](https://github.com/Rianico/pi-better-edit/issues/63) [#124](https://github.com/Rianico/pi-better-edit/issues/124) [#125](https://github.com/Rianico/pi-better-edit/issues/125) [#126](https://github.com/Rianico/pi-better-edit/issues/126) [#127](https://github.com/Rianico/pi-better-edit/issues/127) [#128](https://github.com/Rianico/pi-better-edit/issues/128) [#129](https://github.com/Rianico/pi-better-edit/issues/129) [#130](https://github.com/Rianico/pi-better-edit/issues/130) [#131](https://github.com/Rianico/pi-better-edit/issues/131)
* **errors:** unify the error and warning contract (E_*/W_* tiers) ([#148](https://github.com/Rianico/pi-better-edit/issues/148)) ([3b22008](https://github.com/Rianico/pi-better-edit/commit/3b22008f9bbb8dd57f82ad0646ef4680b3f0b4ed)), closes [#136](https://github.com/Rianico/pi-better-edit/issues/136) [#138](https://github.com/Rianico/pi-better-edit/issues/138) [#144](https://github.com/Rianico/pi-better-edit/issues/144) [#145](https://github.com/Rianico/pi-better-edit/issues/145) [#146](https://github.com/Rianico/pi-better-edit/issues/146) [#147](https://github.com/Rianico/pi-better-edit/issues/147)
* **hashline:** unify span verification on lease lineage ([#154](https://github.com/Rianico/pi-better-edit/issues/154)) ([65af962](https://github.com/Rianico/pi-better-edit/commit/65af96236f7d0e2f15b1775a2eabd6796ac70750)), closes [#151](https://github.com/Rianico/pi-better-edit/issues/151) [pre-#151](https://github.com/Rianico/pre-/issues/151)

### Bug Fixes

* **hashline:** scope served canons per file and serve fresh read ([#152](https://github.com/Rianico/pi-better-edit/issues/152)) ([47a04f7](https://github.com/Rianico/pi-better-edit/commit/47a04f7ce055d82c517ba00257b8ef921735ad8d)), closes [#149](https://github.com/Rianico/pi-better-edit/issues/149) [#149](https://github.com/Rianico/pi-better-edit/issues/149)

### Documentation

* declare the 2.0 tool-contract break ([#155](https://github.com/Rianico/pi-better-edit/issues/155)) ([ee74c91](https://github.com/Rianico/pi-better-edit/commit/ee74c912ffe46f33c0debf3962805a410190b4d1)), closes [#154](https://github.com/Rianico/pi-better-edit/issues/154) [#148](https://github.com/Rianico/pi-better-edit/issues/148) [#154](https://github.com/Rianico/pi-better-edit/issues/154)

All notable changes to this project will be documented in this file.

## [1.7.0](https://github.com/Rianico/pi-better-edit/compare/v1.6.0...v1.7.0) (2026-09-09)

### Features

* **edit:** adopt named-object payload with file and anchor fields ([#77](https://github.com/Rianico/pi-better-edit/issues/77)) ([741be22](https://github.com/Rianico/pi-better-edit/commit/741be220571e9d5a249a5dd035fb59297c41fe0b))

## [1.6.0](https://github.com/Rianico/pi-better-edit/compare/v1.5.0...v1.6.0) (2026-09-05)

### Features

* **edit:** user/model audience split and glossary-aligned error codes ([dd1a779](https://github.com/Rianico/pi-better-edit/commit/dd1a779b5a5c2ecddd486a49eff9eeed1014aa48)), closes [#65](https://github.com/Rianico/pi-better-edit/issues/65)

### Bug Fixes

* **drift:** report canon deficit instead of hash rotation ([95c4703](https://github.com/Rianico/pi-better-edit/commit/95c4703f7470d651d7b2309921a125959fdf463f)), closes [#68](https://github.com/Rianico/pi-better-edit/issues/68)
* make prepare tolerant when husky not installed ([cca29d3](https://github.com/Rianico/pi-better-edit/commit/cca29d3076068b1bab832eae99da79547d5d4939))
* **served:** epoch lifecycle belongs to full reads ([3918292](https://github.com/Rianico/pi-better-edit/commit/3918292a85ad3a230b6705cf03a12e67ff04717b)), closes [#69](https://github.com/Rianico/pi-better-edit/issues/69)
* **write:** dense re-serve after write clears stale rows ([44c7664](https://github.com/Rianico/pi-better-edit/commit/44c7664e708b0aba3277754b7e80b9fff62371bf)), closes [#70](https://github.com/Rianico/pi-better-edit/issues/70)

### Documentation

* **prompts:** align tool desc and prompts with glossary (fresh anchors) ([b0bcf0b](https://github.com/Rianico/pi-better-edit/commit/b0bcf0b26cdd6a6806f85654247663a474703149))

## [1.5.0](https://github.com/Rianico/pi-better-edit/compare/v1.4.3...v1.5.0) (2026-09-03)

### Features

* consolidate architecture deepening — 6 deep modules ([#64](https://github.com/Rianico/pi-better-edit/issues/64)) ([6cbf5da](https://github.com/Rianico/pi-better-edit/commit/6cbf5da3fed20588d33c87fb05b3307c23501404))

## [1.4.3](https://github.com/Rianico/pi-better-edit/compare/v1.4.2...v1.4.3) (2026-09-01)

### Bug Fixes

* **edit:** prevent tool calling bleed on Gemma 4 ([#57](https://github.com/Rianico/pi-better-edit/issues/57)) ([e67f493](https://github.com/Rianico/pi-better-edit/commit/e67f493ab6858d26a36329fbeb08a7a3779574e8)), closes [#55](https://github.com/Rianico/pi-better-edit/issues/55)
* **hashline:** prevent freed anchor reuse via per-session tombstone and epoch (ADR-0013) ([#56](https://github.com/Rianico/pi-better-edit/issues/56)) ([79b4931](https://github.com/Rianico/pi-better-edit/commit/79b49318df992d09e2d613dbb5ebc3c39d435de1))

## [1.4.2](https://github.com/Rianico/pi-better-edit/compare/v1.4.1...v1.4.2) (2026-09-01)

### Bug Fixes

* **ci:** prevent pre-push from blocking release push ([daa3d18](https://github.com/Rianico/pi-better-edit/commit/daa3d186020df736c9724d46af3f6b16100b3ef9))

## [1.4.1](https://github.com/Rianico/pi-better-edit/compare/v1.4.0...v1.4.1) (2026-08-31)

### Bug Fixes

* **ci:** lower statements coverage threshold to 89 to match actual ([f5b58a5](https://github.com/Rianico/pi-better-edit/commit/f5b58a59d78c8e1c243642f362f995904b12eb68))
* **ci:** repair lockfile and bump node to 22 for semantic-release ([62ab62a](https://github.com/Rianico/pi-better-edit/commit/62ab62a78bf95a598671d3848aa59dec1f902fb7))
* **hashline:** remove boundary-dup auto-fix, keep pure edit ([#54](https://github.com/Rianico/pi-better-edit/issues/54)) ([7c55b57](https://github.com/Rianico/pi-better-edit/commit/7c55b5713f43a73dc2f972e4b99050b036d2c625))

## [1.4.0](https://github.com/Rianico/pi-better-edit/compare/v1.3.0...v1.4.0) (2026-08-29)

### Code Refactoring

* consolidate architecture deepening tranche (C1–C5) into `map/architecture-deepening` — `MutationEngine`, `ServedSession`, `FileContent`, `LifecycleHooks`, `HealingStrategy` ([#53](https://github.com/Rianico/pi-better-edit/pull/53))
* add SAFETY for `x as unknown as` casts and fix unlisted/cache blockers for v1.4.0

## [1.3.0](https://github.com/Rianico/pi-better-edit/compare/v1.2.3...v1.3.0) (2026-08-28)

### Features

* **edit:** route drift signals to user-facing details ([6ec52f2](https://github.com/Rianico/pi-better-edit/commit/6ec52f2e3789b7c7d6e10c4ebcc43c4518e8d3d3))

### Documentation

* merge scaffold-git prompts into one (Obsidian flavour) ([ef613d2](https://github.com/Rianico/pi-better-edit/commit/ef613d21605149615936cce0deeadf118d68e97a))

## [1.2.3] - 2026-08-28

### Fixed

* allow _-prefixed unused exports and scoped no-comments for publish

### Changed

* wire semantic-release (conventionalcommits) with pinned release workflow

## [1.2.2] - 2026-08-28

### Fixed

* address P1 blocking — error-swallowing + SAFETY for as-unknown-as + unknown returns
* harden path traversal and ReDoS via root containment and bounded RegExp, tighten CI permissions
* propagate errors after log instead of swallowing undefined
* prune deadcode via knip whitelist and barrel dedupe
* add node: prefix and .js extensions to relative imports
* reduce complexity via helper extraction and early returns
* fix nits — console, typos (ALPH→ALPHA), prefer-at, slice-copy and style

### Changed

* remove deprecated agent skills (coding-protocol, keel, show-me) — .pi/ is source of truth
* ignore .lsz/ ephemeral artifacts
