# Changelog

## [Unreleased]

### Features

* **config:** relocate user-level settings and all persistent state out of `~/.config/pi-better-edit`: global settings move to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-better-edit/settings.json`, the project file to `<cwd>/.pi/agents/pi-better-edit/settings.json`, and the store, the pre-SQLite `hash-store.json` and `diagnostics.log`/`.1` to `${XDG_STATE_HOME:-~/.local/state}/pi-better-edit/`. `XDG_CONFIG_HOME` leaves resolution, a relative `XDG_STATE_HOME` counts as unset, and an unusable state root fails store-dependent calls closed with `[E_ACCESS]` instead of forking a fallback. (ADR-0050) (#190)
* **config:** adopt user settings from the retired locations once, in the order new file → `<PI_BETTER_EDIT_CONFIG_DIR>/pi-better-edit.json` (only when that variable is set) → `$XDG_CONFIG_HOME/pi-better-edit/pi-better-edit.json` → `~/.config/pi-better-edit/pi-better-edit.json` → `~/.pi/agents/pi-better-edit.json` (project: new file → the flat `.pi/agents/pi-better-edit.json`): the bytes are written through the atomic writer, verified by parse, and only then is every retired source renamed `.bak`. A failed adoption still serves the keys it read, project adoption is skipped — without a warning — when the tree is unwritable, and `.bak` files are never warned about or deleted. `XDG_CONFIG_HOME` is read only to find those retired sources. (ADR-0050) (#190)
* **config:** start the store fresh under the new state root: the old `hash-store.sqlite` is left untouched and its path logged once per session, because an un-restarted older session may own it, while `hash-store.json` and the diagnostics logs move in and `.corrupt-*` dumps are deleted. Retired roots are searched in one order — the override, `$XDG_CONFIG_HOME/pi-better-edit`, `~/.config/pi-better-edit` — and a failed move withholds the `.migration-v1` marker so the next session retries. `PI_BETTER_EDIT_CONFIG_DIR` keeps its verbatim meaning, remains the only thing that can move the store, and now owns `<override>/settings.json` and `<override>/state/`. (ADR-0050) (#190)

### Bug Fixes

* **config:** carry an override or `XDG_CONFIG_HOME` user's settings and state across the relocation instead of abandoning them: the retired-source lists become one ordered set (override root, XDG config root, `~/.config`), so `<override>/pi-better-edit.json` is adopted into `<override>/settings.json` and `<override>/hash-store.json` plus the logs move into `<override>/state/`. A `rename` across filesystems now copies and unlinks instead of losing the move, the migration marker is written only when no move failed, and project adoption skips an unwritable tree before attempting the write. (ADR-0050) (#190)

### Documentation

* **adr:** land ADR-0050 recording the split of settings (pi agent dir) from state (XDG state dir), the verbatim override that now owns `<override>/state` and is still the only mover of the store, the fresh-store policy with the abandoned-store log, the artifact move/delete table, the settings adoption precedence with `.bak` retirement, the `[E_ACCESS]` fail-fast and the MINOR classification; point ADR-0037's store-directory paragraph at it rather than rewriting the record, and update the README, the schema prose and the MVCC spec's path mention. Docs only; the behaviour ships in the `config` entry above. (#190)

## [2.14.0] - 2026-10-28

### Features

* **bash:** admit an inert `wc -l`/`-c` count tail after the last verified block of a multi-block, statically glued compound (ADR-0048 D4): the verified blocks keep their banners, anchors and per-block leases, and the count's already-observed bytes ride through raw and unleased. Only `wc` with `-l`/`-c` and file operands qualifies; a tail before any block or before a later block, stdin, a redirect, a pipeline, another command, a glued single-block chain, and any post-block `cd` still decline with their original reasons, and D10's single-leading-block behaviour is unchanged. (#185) (#186)
* **bash:** serve context searches (ADR-0048 D3): admit `grep -A/-B/-C`, long context flags, and `rg -C` on single-file searches; match and context rows around `--` are re-read, byte-compared, and leased under the existing key. `SEARCH_MAX_TOTAL_ROWS` bounds total rows independently; recursive/multi-file context, attached short spellings, mixed options, and `-c`/`-o`/`-l` stay refused. (#183) (#188)
* **bash:** serve multi-file views (ADR-0049): admit `cat`, `cat -n`, `nl -ba`, and numeric `sed -n` over two or more newline-terminated files as per-file page sections; line-count boundaries, per-file leases, zero-row pages only inside a served result, and whole-command raw on any failed proof. Configurable `bash.multiFile.maxFiles` / `maxRows` (defaults 10 / 2,000) via `/pi-better-edit bash-view multi-file`. (#183) (#188)
* **bash:** serve terminal display tails (ADR-0048 D2): `cat -A`, `cat -vet`, `od -c`, `xxd`, and `hexdump -C` over raw-slice views are proved by re-running the transform on a temporary copy of the exact re-read slice, then serving the raw anchored rows with a disclosure. Transform bytes are never served or leased; unsupported heads, missing transforms, lone-CR files, and over-cap output pass through raw. (#176) (#189)


### Documentation

* **adr:** land the bash serve admission record as ADR-0048 with an explicit accepted/deferred split (D1 accepted and implemented by #175, PR #177; D2 tracked by #176; D3/D4/D5 tracked by #183) together with its corpus analysis, and retarget the #175 serve-seam comments to cite ADR-0048. Comments and docs only; no behavior change. (#178)
* **adr:** record ADR-0048 D4 as accepted and implemented by #185 instead of deferred, extending the D1 amendment note and splitting the tracking bullet so #183 covers D3/D5 only. Docs only; the behaviour itself ships in the #185 feature entry above. (#185)
* **adr:** propose ADR-0049 for multi-file bash views: per-file page sections, line-count boundaries, zero-row pages, cross-file `sed` ranges, configurable 10/2,000 caps, and a real-workload evidence gate; implementation remains deferred. (#183)
* **adr:** record ADR-0048 D3 as accepted and implemented by #183 instead of deferred, adding the amendment note, the tracking split, and an "As implemented" paragraph that pins the admitted spellings, the leased-context geometry, the independent total-row cap and the compound boundary. Docs only; the behaviour itself ships in the #183 feature entry above. (#183)
* **adr:** accept ADR-0049 and record the M7 evidence gate as met, with the captured real-workload shapes, the limitation that only plain `cat` over 2+ files is attested, the twelve-fixture matrix, the implementation notes (numbering conventions, zero-row page literal, stream-leading BOM, no compound envelope, caps as policy); mark ADR-0048 D5 as landed through ADR-0049. Docs only; the behaviour ships in the #183 feature entry above. (#183)

## [2.13.4] - 2026-10-24

### Bug Fixes

* **bash:** refuse ambiguous `FILE:LINE:content` splits and non-monotone search rows at the serve seam, so every served row is byte-verified and its interval is ordered; add a real-binary attribution property suite. (#175) (#177)
* **prompts:** state what the tools actually do: bash-view and auto-read rows count as served, `[W_*]` is informational and `[E_*]` retries, `cut` removes the source span, undo names its scope and `E_UNDO_STALE` invariant, and a `-` diff row is not served. Read's description drops 2494 → 1377 chars; the guidelines become plain procedural English with glossary terms. The `mode: "literal"` escape stays refusal-only per ADR-0021, now pinned by a test. (#179) (#180)
* **errors:** replace the never-rendered per-code `remedy` with a refusal-scoped `Options:` list on the three codes whose evidence admits two neutral moves (`E_SUSPICIOUS_TEXT`, `E_BATCH_ABORT`, `E_UNDO_UNAVAILABLE`); every other rejection states facts only. `E_SUSPICIOUS_TEXT` branches `text`/`content`, discloses `mode: "literal"` once, and counts one submission as `1 time`. Fact-only producer messages, foreign-reference headlines and batch trailers lose their embedded imperatives; a wrapped item's options are indented under its bullet. (ADR-0047) (#181)

## [2.13.3] - 2026-10-22

### Features

* **store:** adopt an unchanged file from its `stat(2)` identity instead of re-deriving every line: stamp `ino:size:mtimeMs:ctimeMs` on the materialized snapshot and resolve only the kept page's lineage, verifying each served line against its committed canon hash. Any mismatch falls back to the content-hash path; touch, atomic rename, and same-size/same-mtime rewrites are covered. (store version 11, ADR-0043) (#166)
* **hashline:** pair a one-region change without scanning the unchanged boundary: zip the prefix/suffix whose canon is globally unique on both sides, then run patience pairing only on the changed middle. Duplicated or mismatched boundaries fall back to the full scan; untouched lines keep their anchors. (ADR-0044) (#166)
* **store:** end a served lease's authority at the 7-day TTL (hard expiry, ADR-0045): an un-retired lease older than `SERVED_TTL_MS` no longer resolves, and the janitor deletes expired active leases in bounded off-path batches. Resolution and vacuum share one expiry predicate; a lease exactly at the TTL still resolves, while retirement keeps its own 1-hour grace. Anchors older than the TTL fail closed and need a fresh read. (#166)
* **store:** reclaim the file space lease GC frees: run one gated `VACUUM` after a maintenance sweep (ADR-0046), only when free pages are at least a quarter of the file and at least 1 MB, and only on lifecycle events. A contended rewrite waits briefly and defers with a reason; the outcome reports reclaimed bytes and failures never escape the hook. (#166)

### Bug Fixes

* **store:** keep cache-hit reads off the LRU vacuum's store-wide pin scan by running retention only when a materialization inserts a fresh snapshot; add the covering `(file_path, served_snapshot_hash)` lease index (store version 10) so a fresh commit's sweep stays cheap on a large lease table. (#166)

### Code Refactoring

* **architecture:** reorganize internal module seams with no behavior change: delete the hashline barrel and retarget its importers, move serve rendering into served-session, fold the hash facade into snapshot-store/snapshot-io, move read admission into file-content/admission, sever the ambient IO fallback, and move store open/busy/janitor policy into store-kernel. (#167)
* **read:** make the page header the only chrome: it states the file's total line count, the shown range, and — for a byte-truncated page — the budget it stopped at. Remove the pagination footer and unify auto-read, bash-view, search and file-list banners into the same bracket grammar; `verbatim` is the sole mode marker. (#173)

## [2.13.2] - 2026-10-21

### Features

* **diagnostics:** internal failures are recorded in `<configDir>/diagnostics.log` (JSONL, 1 MiB cap with one rotated generation) instead of being written to the terminal Pi's renderer owns; `/pi-better-edit` reports the log path, size and last write. (#164)
* **config:** the global settings file moves from `~/.pi/agents/pi-better-edit.json` to `<configDir>/pi-better-edit.json`; a file left at the retired location is adopted on first read, written to the new path and renamed `.bak`. (#164)

### Bug Fixes

* **bash-view:** a `&&` chain whose operand is a compound statement (`for`, `if`, `while`, `time`, `{ …; }`, `( … )`, `case`, a function definition, `[[ … ]]`) no longer crashes the conversion; the chain fails closed and the raw output passes through. (#164)

## [2.13.1] - 2026-10-19

### Bug Fixes
* **read:** keep multi-window TUI call titles within their render width, preserve stable cached output across repeated renders, and retain builtin component reuse and invalidation instead of falling back after a `setText` error. Narrow titles truncate the count rather than overflowing. (#158)

## [2.13.0] - 2026-10-18

### Features
* **bash-view:** admit the Tier-3 interception surface (#82): `grep`/`rg` as downstream filter stages (`cat f | grep -v x`) and an unnumbered search source translated into a `keep` filter, multi-file `grep`/`rg PATTERN FILE...` served as per-file `FILE:LINE:content` sections, `grep -r`/`rg` directory walks that never descend into hidden or `node_modules` directories, an anchorless existence-checked `rg --files` list, and the `sort -u`/`uniq`/`wc -l` line-set consumers. Every bound fails closed to raw output with zero leases, and numbered sources and views still compose with nothing downstream. (#82) (#121)
* **bash-view:** admit Tier-2 view spellings to interception: explicit `-e` search patterns (separate, attached, cluster-close; exactly once), multi-range `sed -n -e RANGEp` merged at parse, and numbered `cat -n` / `nl -ba` sharing one full-file renderer. Malformed shapes fail closed to raw bash. (#82) (#120)
* **bash-view:** give `sed`/`cat`/`head`/`tail` views the same bracketed file banner the search and filter pipelines already use — `[<path> (lines X-Y of Z)]` for a slice and `[<path> (N lines)]` for a whole file — in place of the `<read>` tool's `=== Lines X-Y of Z ===` section header, which the read tool keeps. (#134) (#136)
* **bash-view:** admit a numbered `grep`/`rg` search piped into `head`/`tail` as a search with the slice applied to the resolved matches — only surviving rows are leased, rendered and counted under their original file line numbers, and a slice that removes every row declines. (#135) (#138)
* **bash-view:** intercept multi-statement compounds that combine literal banner prints with admitted views or searches — each segment's expected bytes are verified left to right against re-read disk, verified blocks anchor with leases for survivors only, and the peel halts with the verified prefix plus raw remainder at the first mismatch. (#135) (#138)
* **read:** the payload collapses to one canonical shape — the schema accepts only `{ files: [{ file, windows?, mode? }], mode? }`, the admission fold and its `legacyPage` support structure are deleted, and the repo's own call sites are migrated. Legacy-only payloads are rejected with the same error a file-less call gets; recorded transcripts still render via the projection fallback. Single-window reads using the preferred `files` shape now carry the §4.4 continuation footer they previously lacked. (#142) (#145)
* **read:** the payload is one flat target — the schema accepts `{ file, windows?, mode? }`, one file per call with parallel calls for fan-out; the outer `files` array, per-file `mode`, and the multi-file caps are deleted, and the repo's own call sites are migrated. Retired shapes are rejected; recorded transcripts still render via the projection fallback, single-window reads keep their §4.4 page chrome, and multi-window calls show `(N windows)`. (#147) (#148)
* **bash:** admit a compound with a single leading view/search block and an inert `wc` tail — no glue required (relaxation A, ADR-0039 D10): the block renders with its standard banner and anchors, then the tail’s raw bytes. Second blocks, non-first blocks, post-view/post-block `cd`s, and unsafe tails still decline with their original reasons. (#152) (#156)

### Bug Fixes
* **lifecycle:** the bash conversion chain is now data — an ordered `RULES` table with one `decide` walk owns precedence, and a single `renderDecision` routes by `decision.kind`. No behavior change. (#151) (#155)
* **lifecycle:** the four bash banners live behind one `bashBanner(kind)` builder — the frozen text is byte-identical, only the definition site moved. (#150) (#154)
* **read:** the served file header names the shown range a single windowed read actually rendered — `[f (lines a-b of N)]`, matching the bash view — while whole-file and multi-window reads keep the bare total. (#149) (#153)
* **errors:** drop the "Pass a plain file string and retry." tail from the three `fs-write` null-byte invariants: they raise `E_INTERNAL_INVARIANT`, which carries no remedy, so its message states the fact alone. The arch oracle now also reads the messages real producers pass — the code set derived from the registry's remedy-free entries — so a planted tail at any site fails the suite. It had checked only each code's declared format against its own example payload, which is how the tails survived #93. (#125) (#129)
* **store:** quarantine and rebuild the hash store on the first statement that fails with a corruption error, instead of leaving the damage for the next open or janitor run. The guarded handle rethrows the original error, so callers still fail loud. (#100)
* **read:** the TUI call line again shows the target file and line range for the canonical multi-file payload: one projection derives the display path (first target) and range (single file, single offset/limit window) for both renderers, while legacy shapes render exactly as before. (#141) (#144)

### Code Refactoring
* **config:** re-home the three config setters' enum guards off `E_BAD_PAYLOAD` onto the remedy-free `E_INTERNAL_INVARIANT`, since a typed slash command cannot reach them: every handler narrows its tokens and the overlay offers only enum choices. Their messages state the fact and name the offending value with no retry tail, and the command handler no longer renders a DomainError's `[MODEL] [E_…]` envelope into the user channel — the envelope goes to the log while the user sees a plain failure notice. (#94) (#126)

## [2.12.0] - 2026-10-13

### Features
* **store:** render the store's own section in `/pi-better-edit lens status` with configuration ladder provenance (`default` | `global` | `project` | `env`) and resolved path. The settings resolve through `resolveStoreJanitorSettingsWithSources` per key, while `isHealthy` and `shutdownDb` retain their explicit health check and checkpoint boundaries. (#90) (#103)
* **store:** run the store janitor on non-hot-path lifecycle events (`session_start`, `session_shutdown`) with batched deletes and deep quick_check recovery. Foreign generation and expired rows are purged in statements bounded by `store.janitorBatchSize` under the throttled `janitor_at` timestamp. (#90) (#103)
* **store:** resolve janitor settings from `.pi/agents/pi-better-edit.json` via a unified configuration ladder. Extracted `src/json-config.ts` handles atomic reads and writes across both lens bridge and store janitor settings, falling back safely to defaults on warnings. (#90) (#103)
* **bash-view:** admit the five Tier-1 `grep`/`rg` flag shapes (`-w`/`--word-regexp`, `-x`/`--line-regexp`, `-m N`, bundled clusters, and trailing flags) to intercepted search (#82). Flags before `--` are honoured while malformed counts or unsupported options fail closed to raw bash. (#83)
* **read:** recover PNG/JPG image reads by delegating to the builtin read tool (PR #52). A lone image returns the builtin's image block; a multi-file call with an image aggregates the blocks into `content` in request order while text targets keep the served and anchor path. Image bytes never enter served, hash, snapshot, or lease state. (#52) (#114)
* **bash-view:** gate interception behind a default-on `bash.view` option in `.pi/agents/pi-better-edit.json`, resolved per key through `PI_BETTER_EDIT_BASH_VIEW` over project file over global file with rung-source reporting. `/pi-better-edit bash-view [on|off|status] [project|global]` (alias `bash`) writes the switch with a five-option picker or the combined status; effective `off` passes views and searches through raw, and the first interception of each session warns once with the off-ramp. (#115) (#116)
* **pi-lens:** review every setting in one headed overlay: bare `/pi-better-edit` or the `settings` token opens target scope, lens bridge, bash view and store janitor rows with effective-source diagnostics, while headless hosts keep the combined status text. The scope switch steers later saves without persisting; each row saves through its matching saver and refreshes. (#117) (#118)

### Tests
* **harness:** harden the vitest harness against host-load timer lateness (#84) — a new `vitest.config.ts` raises `testTimeout` to 20s and `hookTimeout` to 30s, because the observed failures are a 5526ms test body against the 5000ms default and ~14s module-level `beforeAll(initHasher())` hooks against the 10000ms hook default; this is the lever the measurements support, since `isolate: false` fails 19 tests, `maxWorkers: 4` costs +33s wall without removing the failure mode, and `initHasher()` is already a module-level singleton with nothing to hoist. (#88)
* **harness:** isolate the hash store from the developer's real one using a per-worker temp directory under `PI_BETTER_EDIT_CONFIG_DIR`. Tests no longer touch `$HOME/.config` or race concurrent live sessions, with explicit opt-out support for fixed-path fixtures. (#89) (#92)
* **store:** assert the contention episode's structure instead of an exact attempt count (#87b). Added an optional `now` clock parameter to `BusyBudget` to evaluate deadline exhaustion deterministically without host load interference. (#96)

### Bug Fixes
* **errors:** attribute `E_BAD_PAYLOAD` to the registered tool that raised it (`read`, `edit`, `undo_last_edit`) via a typed `subject` field and `withPayloadSubject` helper (#86). Refusals without a stamped tool fall back to neutral phrasing. (#95)
* **store:** budget hash store lock contention explicitly with 250ms internal wait and 8 retry attempts with jittered exponential backoff (#87). Wall-clock deadlines bound contention episodes to 4300ms without waking contending processes in lockstep. (#96)
* **store:** gate store open on a two-part stamp (`PRAGMA user_version` and metadata table stamp) so healthy opens avoid write locks (#87). The generation sweep and version updates run only when store provenance changes. (#99)
* **store:** defer open stamp write to the open's final step so it certifies all registered lifecycle hooks (#87). Stamp writes are retried under the open retry budget if the store is briefly contended. (#99)
* **store:** check stamp-matching opens with a read-only 100-byte SQLite header smoke check rather than full `PRAGMA quick_check` (#87). Validates file magic, page size, and page count in sub-millisecond time while deferring full checks to periodic maintenance. (#101)

### Code Refactoring
* **read:** name the file-count cap's refusal in one constant (`MAX_READ_FILES_MESSAGE`) (#85) instead of an inline template, and pin the 10/11 boundary on both enforcement points — the registered `files`-array `maxItems` that an over-cap tool call actually hits and the admission guard that backstops a caller skipping the schema; the two wordings diverge by construction, because the runtime validates `parameters` before `execute` and builds its message from `maxItems`. (#88)
* **errors:** re-home tool-facing invariant guards onto a new remedy-free `E_INTERNAL_INVARIANT` code — path, snapshot-generation, unknown-fields, anchor-derivation and engine-only seams stop rendering the model-facing payload remedy; the payload keeps its optional subject and the same boundary helper stamps both codes, so model-wire `E_BAD_PAYLOAD` refusals stay byte-identical. (#93)

### Documentation
* **store:** record the janitor's maintenance model (#90) as [ADR-0037](docs/adr/0037-store-janitor-lifecycle-maintenance-model.md), covering the lifecycle triggers (`session_start`, `session_shutdown`), throttle settings, batched deletes, and quarantine recovery architecture. (#103)

## [2.11.0] - 2026-10-10

### Features
* **edit:** declare the optional wire fields (`text`, `text_ref`, `at`, root `mode`, and `text_ref.file`) nullable so the served schema admits the `null` that admission already reads as absent, and reframe both XOR refusals as an explicit binary field choice — the flat wire contract, the required fields, and admission behaviour are unchanged. (ADR-0036) (#81)
* **edit:** return the anchored post-edit diff in the model-visible text — `content[0].text` is now the summary line, a blank line, then the same collapsed #174 single-projection diff, while `details.diff` stays byte-identical for TUI clients, so the summary the `tool_result` hook previously discarded and the diff the model edits against now travel together; a follow-up edit anchors on a row the previous edit modified with no intermediate `read`. (#79)
* **read:** disclose non-printable control characters under the verbatim rows (C0 minus tab/LF/CR, plus DEL and the C1 block) instead of escaping the bytes, so the model is warned about characters it cannot see without tokenizer-hostile escapes. (#79)
* **read:** serve many files and many windows in one call — `files: [{ file, windows: [{ offset, limit } | { around_anchor, radius }], mode }]` replaces the single-file shape (legacy `{ file/path, offset, limit }` and `windows: []` still fold, while the prompts publish only `files`), windows merge by interval and each file is walked once, a call carries at most 16 windows across all files and at most 10 files, every file draws on one shared `SERVED_MAX_LINES` budget, and an anchor resolves against the target file's active session lineage whether or not a sibling served rows — unknown/expired/foreign warns inline and the siblings still render, `mode: "verbatim"` renders a resolved window as plain rows and leases nothing, one failing file (or a failing mirror phase) is an inline section rather than a failed call, and each section carries its own `[path (N lines total)]` / `[path (verbatim, N lines, no anchors)]` header with a copy-pasteable `Use windows: [{ offset, limit }]` footer. (#79)
* **bash-view:** intercept pure `grep`/`rg` searches — a strict eight-flag allowlist (`-n|--line-number`, `-i|--ignore-case`, `-F|--fixed-strings`, `-E|--extended-regexp`) over exactly one file operand, with `-n`/`--line-number` injected before execution and before any `--` separator, serves the matched lines as `HASH│content` rows under the frozen `--- Bash search (hashline anchors) ---` header and leases exactly the matched lines, and witnesses every match against a disk re-read, so a non-zero exit, an unparsable line, a forged or stale disk line, or more than `SEARCH_MAX_MATCHES` matches all fail closed to byte-identical raw output — every other flag, pipeline, redirection, compound, glob, tilde, directory and multi-file shape passes through untouched. (#79)

### Build System
* **deps-dev:** import and pin knip 6.40.0 for dead code and export hygiene, and prune unused semantic-release dependencies. (#79)

## [2.10.1] - 2026-10-09

### Bug Fixes
* **edit:** read a null in the nested `text_ref.file` as absent and name the fields that are genuinely required, so a harness using strict structured output is no longer refused for a call it has no way to spell differently. (#77)

## [2.10.0] - 2026-10-09

### Features
* **pi-lens:** retire the frozen v1 bridges and mirror through the unified v2 File I/O Lifecycle Bridge — a single `io-bridge` adapter records served spans (caller content sliced per single-range span, disk evidence only when the notification carried no bytes) and file mutations (whole-file authorship as `write`) via structural `Symbol.for("pi-lens:io-bridge")` detection with no pi-lens import; mutated-file notifications precede served-span notifications so facet-split records reflect post-mutation state; the integration stays optional (only the entry point wires it, removal recipe in README) with the boundary test pinning the v2 surface. (#66)

### Code Refactoring
* **errors:** revise all `E_*`/`W_*` refusal texts to concise single-fact STE100 sentences with structured bullets for batch failures and overlaps, and teach `mode: "literal"` on the refusal surface — no behavior change. (#61)

### Bug Fixes
* **edit:** fall back to git worktree root when outside git repository. (#59)
