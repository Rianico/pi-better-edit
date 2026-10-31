# NUMBER. TITLE

Date: DATE

## Status

STATUS

<!-- Lifecycle: Proposed | Accepted | Rejected | Deprecated | Superseded. Keep this section to the status word plus relationship lines (Supercedes, Superceded by, Amends, Amended by, Clarifies, Clarified by, Relates to) inserted by `adr new -s` / `adr link`. Rationale belongs in Context/Decision, never here. -->
## Context

The issue motivating this decision, and any context that influences or constrains the decision. Constraints, forces, measurements, and why this decision is being made now. Value-neutral facts; 1-2 paragraphs.

## Decision

State the chosen decision clearly in 1-3 sentences, active voice ("We will …").

### Considered Options

When trade-offs matter, document rejected alternatives here. Depth scales with the decision:

- **Simple / transport decisions** (1–3 alternatives, e.g. payload shape, tooling): compact bullets:

  - Rejected: Option A — Pros / Cons / Why not

- **Correctness-critical / invariant decisions** (e.g. verification model, session keying): expand each option with structured rationale so a future reader will not re-propose it:

  - **Option name** — rejected: <boundary-based reason with measurement or invariant>

Rules: options sit on the same abstraction level (never technology vs product). List the chosen option first when it clarifies comparison. If no genuine alternative existed, omit this subsection — do not invent pseudo-alternatives.

## Consequences

What becomes easier or more difficult to do and any risks introduced by the change that will need to be mitigated. Include negative and neutral consequences, not just positive ones. Record load-bearing assumptions and confidence level — anything that would require revisiting this decision if it changed. Link out to deep analysis (`docs/articles/`, `docs/spec/`, issues) instead of pasting it here.
