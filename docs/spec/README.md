# Specification Index & Architectural Roadmap

This directory houses the formal engineering specifications for `pi-better-edit`.

---

## Authoritative Specification

> [!IMPORTANT] Precedence & Normative Authority
> Section §9 of [`content-addressed-line-identity-mvcc.md`](content-addressed-line-identity-mvcc.md) constitutes the sole normative text for Revision 25. The standalone documents `stale-identity-reject-and-serve.md` and `mvcc-session-failure-handoff.md` are retained as non-normative historical analysis and triage records.

- **[`content-addressed-line-identity-mvcc.md`](content-addressed-line-identity-mvcc.md)**
  **Status:** Authoritative (Revision 24 with §9 proposed Revision 25 appendix)
  **Implementing ADRs:** [ADR-0016](../adr/0016-content-addressed-line-identity-supersedes-healing.md), [ADR-0017](../adr/0017-lru-vacuum-supersedes-epoch-concurrency.md), [ADR-0023](../adr/0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md)
  **Scope:** The definitive specification for (File, Content)-Addressed Line-Identity MVCC, CAS snapshots, monotonic `line_id` allocation, $O(m \log m)$ Patience LIS pin backbones, and working buffer delta rebasing.

---

## Active Component Specifications

| Specification | Status | Scope & References |
| :--- | :--- | :--- |
| **[`search-and-read-evolution.md`](search-and-read-evolution.md)** | **ACTIVE** | Multi-window disjoint reads, window-level admission, and verbatim rendering modes. Cited by `src/file-content/detection.ts` and `src/edit-response.ts`. Implementing ADRs: [ADR-0033](../adr/0033-bash-view-interception.md), [ADR-0040](../adr/0040-read-payload-single-shape.md), [ADR-0041](../adr/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md). |
| **[`boundary-duplication-removal.md`](boundary-duplication-removal.md)** | **ACTIVE** | Sole rationale and invariants for skipping boundary line pairing and retiring boundary duplication heuristics (no separate ADR). |
| **[`stale-identity-reject-and-serve.md`](stale-identity-reject-and-serve.md)** | **ANALYSIS RECORD** | Detailed analysis and rationale for the Revision 25 stale identity rejection and recovery payload (normative text lives in `content-addressed-line-identity-mvcc.md` §9). Linked by [ADR-0018](../adr/0018-region-scoped-rejection-serves.md) and [ADR-0020](../adr/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md). |
| **[`mvcc-session-failure-handoff.md`](mvcc-session-failure-handoff.md)** | **TRIAGE RECORD** | Triage findings and failure handoff analysis for the Revision 25 patch (non-normative). Linked by [ADR-0018](../adr/0018-region-scoped-rejection-serves.md). |

---

## Historical & Milestone Specifications

These documents record early engineering iterations. Their decisions have been incorporated into accepted ADRs and the authoritative MVCC spec:

| Specification | Historical Status | Successor ADRs / Specifications |
| :--- | :--- | :--- |
| **[`served-state-range-verification.md`](served-state-range-verification.md)** | Milestone | Accepted in [ADR-0001](../adr/0001-served-state-range-verification.md); deepened in [ADR-0023](../adr/0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md). |
| **[`session-keyed-served-state.md`](session-keyed-served-state.md)** | Milestone | Accepted in [ADR-0002](../adr/0002-session-keyed-served-state.md). |
| **[`unified-error-and-warning-contract.md`](unified-error-and-warning-contract.md)** | Milestone | Accepted in [ADR-0021](../adr/0021-unified-error-and-warning-contract.md); amended in [ADR-0022](../adr/0022-file-scoped-canons-and-fresh-read-stale-range.md), [ADR-0034](../adr/0034-message-convergence-supersedes-adr-0021-decisions-3-and-4.md), [ADR-0035](../adr/0035-estaleanchor-remedy-status-supersedes-adr-0022-remedy.md), and [ADR-0047](../adr/0047-remediation-options-are-refusal-scoped-and-neutral.md). |
| **[`binary-selection-remediation.md`](binary-selection-remediation.md)** | Milestone | Adopted in [ADR-0036](../adr/0036-optional-wire-fields-declared-nullable.md). |
| **[`merged-edit-payload.md`](merged-edit-payload.md)** | Milestone | Predecessor merged payload format; superseded by [ADR-0007](../adr/0007-merged-edit-payload-hoisted-path.md) and [ADR-0015](../adr/0015-named-object-edit-payload.md). |
| **[`compact-json-edit-payload.md`](compact-json-edit-payload.md)** | Milestone | Predecessor compact tuple payload; superseded by [ADR-0006](../adr/0006-compact-json-edit-payload.md), [ADR-0015](../adr/0015-named-object-edit-payload.md), and [ADR-0032](../adr/0032-flat-wire-item-contract.md). |
| **[`error-code-consistency-audit.md`](error-code-consistency-audit.md)** | Milestone | Historical consistency audit of commit `7990a91`. Decisions incorporated into ADR-0020 and ADR-0021. |
