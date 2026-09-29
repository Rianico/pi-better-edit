# #171 (deferred): explicit leading/middle/trailing gap classification in `contextLinesToShow`

- **Status:** rejected as standalone work (closed as `wontfix`, 2026-09-27). Not wrong — deferred.
- **Proposal:** compute `GapKind = leading | middle | trailing` once and switch, so each kind's trim-vs-marker contract is stated once in branching, not split across branches with an inverted guard.
- **Why rejected:** the "stated once" goal is already met in prose — the `genDiff` contract comment states each kind's behavior exactly once, each branch carries `WHY:` archaeology, and two test files pin the behavior. The remaining payoff (branch structure mirrors prose) is small against churn on a stable, heavily-pinned function approved as-is twice (fix-169 review panel, fix-170 TM review).
- **Revisit trigger:** the day collapse logic gains a fourth case (new span kind, new audience with different collapse needs) — that change should carry the restructure with it instead of extending the inverted guard.
- **Related:** #166 (guard), #169 (span taxonomy, marker diction, purity rule), #170 (ctx-0 accounting).
