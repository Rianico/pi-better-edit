# Rot Audit

Read only when auditing architecture drift, recurring bypass, exception growth, or the long-lived health of boundaries and guards.

## Route

Declare the audit scope, selected indicators, evidence window, exception baseline, and negative-control evidence. Close when every in-scope indicator has grounded evidence, an explicitly unavailable source, or a reasoned exclusion. Return findings, justified no-action or subtraction candidates, accountable owners, the next review trigger, and any next snapshot.

## Indicators

Lagging symptoms such as incidents and rewrites arrive late, so use leading indicators only where they earn their cost. Interpret level and direction against repository context: expected product growth can raise a healthy count. Reuse a repository-defined review trigger when present; otherwise a concerning trend creates a finding for its owner, not an automatic work item.

| Indicator | How to read it |
| --- | --- |
| Suppression count — lint disables, unchecked casts, skipped tests, baseline entries | Default the trend and baseline to shrink-only. A justified increase is a visible decision with authority, reason, narrow scope, date, and removal condition; unreviewed growth is exception accretion. |
| Negative-control freshness | Track the last time a planted or known violation was detected. Staleness questions the guard mechanism even when the repository is clean. |
| Observed violation history | Track real violations separately as pressure on the boundary. A long quiet period does not by itself justify retiring a falsifiable guard. |
| Public surface growth | Compare exports, fields, and options added per period with delivered behavior or outcomes. Surface outgrowing delivery means promises may be minted as a side effect. |
| Concept count | Compare new nouns—services, managers, layers, configuration keys—with retired concepts or explicitly accepted net growth. |
| Ambiguous authority | The same fact is independently editable through multiple routes without the applicable section 3 dimensions needed to reconcile them. Deliberate federation and replicas are not defects when those dimensions are explicit. |
| Boundary or accountability divergence | Code widens or crosses a declared boundary without corresponding contract and decision-right evidence. Internal churn behind an unchanged contract is not drift. |
| Bypass frequency | Track how often the governed path is skipped. After controlling policy is accounted for, a rising rate may expose avoidable route cost; it is not evidence of individual misconduct. |
| Undeclared cross-boundary imports | Count imports that violate declared dependency direction or bypass a public surface, not directory kinship by itself. |
| Hand-edited derived files | Diffs touching declared generated files suggest the generator costs more than a direct edit; improve that path before normalizing hand edits. |

## Evidence Retention

Prefer existing version-control history, automated-check artifacts, and metrics over a new Keel-owned store. If a new snapshot is justified, declare its scope, cadence, retention, owner, and deletion condition. Do not append unbounded history or build a second source of truth merely to measure drift.

Indicators are projections of health, not health itself. Declare each scope, evidence window, and known blind spots. Validate a quiet signal before treating it as proof of health or as grounds for retirement.
