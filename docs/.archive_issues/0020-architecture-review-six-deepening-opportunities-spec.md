# Architecture review: six deepening opportunities (spec)

> **Archived from pre-migration issue #20.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-15T03:43:04Z · state CLOSED · labels: ready-for-agent

## Body

Map for the 2026-08-15 architecture review of Hashline Edit. Six deepening candidates, each with its own ticket, dispatched to pi agents in isolated worktrees (worktrunk), merged to `main` in dependency order. All respect ADR-0001 (model–tool boundary, reject-and-serve) and ADR-0002 (session-keyed served state, global undo/snapshots) — nothing re-litigates them.

- [x] #21 Arch C1: Restore the hashline purity seam — stop store I/O leaking into hashline/ (no deps) — merged 2026-08-15, commit a11a833
- [x] #22 Arch C6: Split buildToolDef — extract the debounced-preview controller (no deps) — merged 2026-08-15, commits 8937060/5de2db8
- [x] #23 Arch C3: Serve recording after success leaves the tool_result handler — one recordDiffServes helper (blocked by #21) — merged 2026-08-15, 394b9ad
- [x] #24 Arch C5: hash-store per-domain statement slices — drop the re-export facade (blocked by #21) — merged 2026-08-15, 2cea04f
- [x] #25 Arch C4: Consolidate served state — one module instead of three with two names (blocked by #21, #23) — merged 2026-08-15, a550e07
- [x] #26 Arch C2: One apply-one-edit composition — execPipeline and processFile share a per-edit primitive (blocked by #21, #22, #23) — merged 2026-08-15, c0c4ee0

Top recommendation: #21 first (cheapest, verified cycle, zero behavior change); #23 is the bug-class follow-up.


## Comments

### @Rianico — 2026-08-16T04:08:40Z

All six deepening opportunities merged to main in dependency order: #21 (a11a833), #22 (8937060/5de2db8), #23 (394b9ad), #24 (2cea04f), #25 (a550e07), #26 (c0c4ee0). Map complete.
