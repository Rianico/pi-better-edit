# ADR-0029 — Widen anchors from 3 to 4 characters for tokenizer-stable references

Date: 2026-10-04

## Status

accepted — supersedes the 3-char statements in [ADR-0013](0013-pos-free-roundtrip-optimization.md), [ADR-0016](0016-content-addressed-line-identity-supersedes-healing.md), [ADR-0019](0019-served-hash-echo-refusal-and-literal-escape.md), [ADR-0022](0022-file-scoped-canons-and-fresh-read-stale-range.md), [ADR-0023](0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md) and any other record asserting 3-char; those ADRs stay byte-identical as historical records. No other ADR is touched.

## Context

3-char anchors over base62 merge unpredictably under BPE: the same anchor tokenizes as 2–4 tokens depending on surrounding context, fragmenting the exact reference pattern the model must copy out of a served row. 4-char mixed-case anchors tokenize as exactly 3 tokens ~99%+ across the measured families, so the copy target is stable no matter where the row sits.

Stated limits of that measurement: the framing is raw BPE (no chat-template or tool-envelope effects measured); gated families are unmeasured; GPT-2-era measurements are modest in effect size. The rationale stands on the published tokenizer-stability literature ([TokDrift, arXiv:2510.14972](https://arxiv.org/abs/2510.14972)), not on a project harness — no measurement harness ships as an artifact of this decision.

## Decision

1. **Width 3 → 4 end to end.** `HASH_LEN` (`src/hashline/alphabet.ts`) is the single owner of the anchor width and shape; every producer, consumer, regex, and count word derives from it.
2. **No compatibility shim.** A 3-char token is rejected through the malformed-anchor path (`E_MALFORMED_ANCHOR`, "Pass the bare 4-char anchor and retry") — there is no legacy-width acceptance anywhere.
3. **Anchor space 62^4 = 14,776,336.** The `E_LARGE_FILE` hash-space ceiling follows the width; the probe stride stays `62^2 + 62 + 1 = 3,907` (width-independent, coprime with the space).

## Consequences

- `README.md`, `CONTEXT.md`, `docs/spec/*`, `prompts/*`, and the worked examples are rewritten to the 4-char contract; this ADR is the live width record.
- Anchors for identical content change (every anchor is re-served at the new width); leases, snapshots, and lineage written at width 3 do not transfer.
- ADR-0023 quotes a pre-retitle test title verbatim that names the old width; per the historical-records rule it stays byte-identical — this ADR's declared supersession covers that stale wording (accepted deviation, no edit).
