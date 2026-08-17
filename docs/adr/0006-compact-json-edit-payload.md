# Compact JSON edit payload

**Status:** accepted

The `edit` and `batch_edit` tools use a compact JSON payload that preserves the existing verified edit semantics: a single edit is `[path, [remove_from, remove_to], replacement_text]`, and a batch is `{ "edits": [ ...tuples ] }`. The path position is a string or `null` for existing anchor-based path inference; the two-anchor range is inclusive, and an empty replacement still means deletion. We chose a fixed tuple over a textual patch language or a full-file digest because it reduces repeated JSON keys while keeping native JSON tool calls, strict schema validation, and the model–tool boundary in which the tool owns verification. The old named-object payload is not retained, and textual formats such as unified diff remain deferred interoperability experiments rather than alternate mutation semantics.

## Consequences

- Compact JSON is the sole current payload contract; no new tool or exposed format configuration is added.
- The tuple is intentionally fixed-arity: `null` represents an inferred path rather than an omitted position.
- Both forms must normalize into the existing edit pipeline, including served-state range verification, reject-and-serve, atomic batch preflight, rollback, and persisted undo.
- Syntax-aware structural edits and file-lifecycle operations remain outside the verified line-range contract.
