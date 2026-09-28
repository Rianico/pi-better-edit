# Add reproducible cross-engine token and correctness benchmark

> **Archived from pre-migration issue #37.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-17T10:39:12Z · state CLOSED · labels: enhancement, ready-for-agent

## Body

## Goal

Add a reproducible benchmark for one complex, error-prone edit scenario across:

- `str_replace` payloads used by Claude/Codex-style tools;
- `pi-hashline-edit`;
- `pi-hashline-edit-pro`;
- `@oh-my-pi/hashline`;
- this project (`edit` and `batch_edit`).

## Scenario

Use a multi-edit refactor with an externally changed interior line between read and apply. The scenario must expose partial-write, stale-range, and batch-atomicity differences. Final correctness is the exact expected file content, not merely whether a call returned success.

## Required output

For every arm, report:

- exact tokenizer and version (`cl100k_base` initially);
- serialized payload token count;
- saved rate versus the same `str_replace` baseline;
- call count;
- final correctness and failure mode;
- exact fixture and reproduction command.

Do not reuse the sibling 12-edit numbers as this project's measurements. Keep the existing correctness batteries separate from this scenario benchmark, and write dated result artifacts.

