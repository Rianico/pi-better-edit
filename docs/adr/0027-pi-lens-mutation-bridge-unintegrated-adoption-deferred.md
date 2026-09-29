# ADR-0027 — The pi-lens mutation bridge stays unintegrated; adoption deferred

Date: 2026-09-30

## Status

accepted — required by issue [#6](https://github.com/Rianico/pi-better-edit/issues/6) (question). States the current posture and defers the adoption question; it does not decide against adopting. The read half is shipped ([#5](https://github.com/Rianico/pi-better-edit/issues/5), `src/integrations/pi-lens/read-bridge-adapter.ts`) and stays the whole integration.

Clarifies [ADR-0023 — Lease lineage is the span verification authority; served canons retire](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md)

## Context

pi-lens publishes an in-process producer at `Symbol.for("pi-lens:mutation-bridge")` (`clients/mutation-bridge.js`, `MUTATION_BRIDGE_KEY`). One `recordMutation({filePath, kind, touchedLines, editRanges, consumer, deferAutofix})` call turns on its module-documented bookkeeping: a read-guard staleness stamp, turn-state modified ranges, an attributed change-log receipt, and a **deferred autofix and format pass at `agent_settled`** — the last gated by `entry.deferAutofix !== false` (pi-lens 4.3.0, `mutation-bridge.js:200`).

The two sides do not share an identity model. pi-lens re-hashes the lines it recorded at read time and resolves bare anchors through its pinned content-hash port; our authority is lease lineage plus `line_lineage` ([ADR-0023](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md)), which is finer: identity survives content drift, and the whitespace-insensitive canon absorbs reformatting ([ADR-0005](0005-whitespace-insensitive-anchors.md)).

Nothing is broken by leaving the bridge unintegrated. Its path resolver takes `path` / `filePath` / `file_path`, never our `file`, and its shape adapters recognize `set_line` / `replace_lines` / `operations` / `ops` / `remove_from` + `remove_to` + `replacement_lines`, none of which our payload matches — classification ends at `unknown_edit_schema` and the guard allows with `reasonKind: "no_line_info"`. Those key sets are pinned on our side (issue [#3](https://github.com/Rianico/pi-better-edit/issues/3), `test/tools/edit-contract.test.ts`) so the mismatch cannot drift silently. pi-lens' own format and autofix writes are already handled fail-closed by leases: a whitespace-only rewrite is absorbed by canon, a real fix retires the affected identities and rejects with `[E_STALE_RANGE]` / `[E_TARGET_LOST]` while serving the current rows.

What is missing is evidence, not a verdict: how often its passes touch files we edited (issue [#7](https://github.com/Rianico/pi-better-edit/issues/7)), and the ordering between our `tool_result` handling and its synchronous per-edit autofix (issue [#4](https://github.com/Rianico/pi-better-edit/issues/4)).

## Decision

1. No `recordMutation` call is wired: the write half stays unintegrated while that evidence is missing. This is a deferral — adoption remains open, and a later record that adopts supersedes this one.
2. Record the constraints any adoption must meet, so a later record tests them instead of re-deriving them: its verdicts stay **advisory** and never block an apply our own verification accepts; pass the ranges we already resolved rather than omitting them (omission over-approximates the whole file as changed); and pass `deferAutofix: false` for anchor-sensitive paths.
3. What settles it: the [#7](https://github.com/Rianico/pi-better-edit/issues/7) probe answers whether pi-lens rewrites files we edited, how often, and whether a recorded range ever changes its diagnosis of our next edit; the [#4](https://github.com/Rianico/pi-better-edit/issues/4) ordering question answers whether our `tool_result` handling runs before its autofix. With those answered, a follow-up record adopts under the constraints above — or restates this posture with the evidence attached.

### Considered Options

- **Adopt now with `deferAutofix: false` and resolved ranges** — deferred, not rejected. Pros: gives pi-lens line-level attribution and closes its `unknown_edit_schema` blind spot. Cons: it arms a third party whose model is cruder, and nothing reconciles a disagreement today — its verdict could reject an edit lease lineage accepts; the frequency of the problem it fixes is unmeasured.
- **Adopt now with defaults (`deferAutofix` on)** — rejected for any adoption: the deferred pass rewrites the file right after we served its post-edit diff, so the model's fresh anchors for the reformatted lines can go stale immediately, a self-inflicted `[E_STALE_RANGE]`.
- **Keep the bridge unintegrated (chosen for now)** — the blind spot costs nothing today (see Context), and the option to adopt stays open with the constraints recorded.
- **Event-based advisory flag instead of recording mutations** ([#4](https://github.com/Rianico/pi-better-edit/issues/4)) — open, independent of this record: it needs no mutation-bridge call, and its ordering question is the same one in Decision item 3.

## Consequences

- Editing keeps exactly one authority: leases and `line_lineage`. No third-party verdict can block, delay, or rewrite an edit we resolved.
- pi-lens keeps its blind spot for our edits: its read guard cannot see them, so its own diagnostics stay advisory and we never arm its guard.
- Load-bearing assumption: pi-lens keeps refusing `file` and our item key names. Our side is pinned by `test/tools/edit-contract.test.ts`; their side would surface first in the [#7](https://github.com/Rianico/pi-better-edit/issues/7) probe.
- Adoption stays open and unconstrained beyond Decision item 2 — this record is the baseline a later adoption must meet, not a ban.
