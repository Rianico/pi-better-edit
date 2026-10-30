# Error and Warning Contract

`pi-better-edit` enforces a strict, machine-actionable diagnostic contract ([ADR-0021](../adr/0021-unified-error-and-warning-contract.md), [ADR-0034](../adr/0034-message-convergence-supersedes-adr-0021-decisions-3-and-4.md), [ADR-0047](../adr/0047-remediation-options-are-refusal-scoped-and-neutral.md)):
- **`[E_*]` (Domain Rejections)**: Marks an aborted call from `read`, `edit`, or `undo_last_edit`. No file bytes are written to disk; the served state is updated only by reject-and-serve rows.
- **`[W_*]` (Informational Warnings)**: Indicates a **successful call** that executed, accompanied by diagnostic feedback (e.g. inverted anchor bounds corrected automatically, literal token detection, or zero-byte no-op insertions).
- **Facts by Default**: A rejection reports exactly what failed and the relevant state. An `Options:` list is served only when two or more neutral moves preserve the model's agency ([ADR-0047](../adr/0047-remediation-options-are-refusal-scoped-and-neutral.md)). Exactly three codes emit runtime `Options:` lists (`E_SUSPICIOUS_TEXT`, `E_BATCH_ABORT`, `E_UNDO_UNAVAILABLE`); all others report facts only.
- **Structured Diagnosis (`details.cause`)**: Range-family rejections carry machine-actionable `details.cause` values:
  - `retirement`: Target line identity was retired by an external modification or preceding edit.
  - `never-served`: Target boundary anchor was never served to this session. (Unread interiors between two leased boundaries are accepted per [ADR-0024](../adr/0024-narrow-p2-interior-exposure-cap-removed-diffs.md)).
  - `served-range staleness`: A line within the targeted range moved or changed on disk since it was served.
- **Self-Healing Reject-and-Serve**: For same-file edits, contested spans (`[E_STALE_RANGE]`, `[E_UNVERIFIED_RANGE]`) immediately return the current on-disk lines with fresh, valid leases, enabling exact 1-turn recovery without an extra `read` call (battery verified in `test/e2e/tool-battery.test.ts`). Foreign-source edit rejections render without fresh rows to avoid cross-file leakage.

---

## Domain Rejections (`[E_*]`)

> [!NOTE] Runtime Options vs Remediation Guidance
> Only three error codes emit machine-parsed runtime `Options:` lists (`E_SUSPICIOUS_TEXT`, `E_BATCH_ABORT`, `E_UNDO_UNAVAILABLE`). For all other codes, the table provides actionable remediation advice for agents and developers while the runtime error returns facts only.

| Error Code | Category | Cause & Diagnostic Details | Remediation Guidance / Runtime Options |
| :--- | :--- | :--- | :--- |
| `[E_BAD_PAYLOAD]` | Schema | Payload fails schema validation (missing fields, wrong types, empty `edits` array, specifying both or neither of `text` and `text_ref`). | Fix payload structure to match tool schema. |
| `[E_MALFORMED_ANCHOR]` | Schema | Anchor string is invalid — not a bare 4-char base62 token (e.g., contains delimiter `│`, line number prefix, or diff marker). | Pass bare 4-character anchor hashes (e.g. `"szJx"`). |
| `[E_STALE_ANCHOR]` | Resolution | The anchor was served in this session, but the line identity no longer resolves to a valid position in the current file snapshot. | Re-read the target section or use the fresh rows served in error. |
| `[E_UNKNOWN_ANCHOR]` | Leases | The anchor was never served for this file in the current session. Leases are strictly session-keyed and path-scoped. | Read the file first to acquire valid leases. |
| `[E_FOREIGN_ANCHOR]` | Leases | Anchor belongs to a different file and was not served for the target file. | Ensure anchors match the file specified in `file`. |
| `[E_STALE_RANGE]` | Verification | A line within the targeted range changed on disk since it was served, or a boundary line was never served. (Unread interiors between leased bounds are accepted per [ADR-0024](../adr/0024-narrow-p2-interior-exposure-cap-removed-diffs.md)). | **Reject-and-Serve**: Fresh rows are returned directly in the error. Target the updated anchors without re-reading. |
| `[E_UNVERIFIED_RANGE]` | Verification | One boundary lease was retired (e.g. modified by external writer) while the surviving bound remains live and unshifted ([ADR-0020](../adr/0020-unverified-range-replaces-unserved-range-boundary-rule-for-retired-identities.md)). | Fresh rows returned directly. Inspect the updated span and retry. |
| `[E_TARGET_LOST]` | Lineage | Detected a single retired line identity with no identifiable surviving anchor bounds. | Read the enclosing function/symbol and re-anchor. |
| `[E_SUSPICIOUS_TEXT]` | Safety | Replacement text (or `write` content) starts with a served `HASH│` anchor prefix (preventing accidental double-prefix insertion). | 1. Omit anchor prefixes from `text` (or `content`) and retry with same anchors.<br>2. Set `mode: "literal"` to write lines verbatim. |
| `[E_BATCH_ABORT]` | Concurrency | Two or more items in an edit batch target overlapping or nesting spans. Multi-item batches abort atomically before touching disk. | 1. Merge overlapping edit items into a single span.<br>2. Split edits into separate consecutive calls. |
| `[E_NOOP_LOOP]` | Convergence | The identical edit was submitted 3 consecutive times with zero textual change; the range already contains the desired content. | Inspect diff; verify if subsequent edits are needed. |
| `[E_EMPTY_RANGE]` | Safety | Edit would result in an invalid empty state on a non-empty file target. | Verify anchor bounds and payload text. |
| `[E_NOT_FOUND]` | Filesystem | Target file does not exist on disk. | Verify file path. |
| `[E_ACCESS]` | Filesystem | Permission denied, unwritable file, or circular symlink loop detected. | Check file permissions and filesystem state. |
| `[E_UNSUPPORTED_FILE]` | Filesystem | Target path is a directory, binary file, image, or UTF-16/32 text. | Only UTF-8 text files are supported. |
| `[E_LOSSY_TEXT]` | Encoding | File bytes do not round-trip clean UTF-8 decoding. A line-addressed rewrite would corrupt original bytes. | Edit binary or non-UTF-8 files with external tools. |
| `[E_UNDO_STALE]` | Undo | Target file was modified or deleted externally after the last edit. Undo refused to prevent clobbering newer work. | Inspect current file state; re-read before modifying. |
| `[E_UNDO_UNAVAILABLE]` | Storage | Undo snapshot could not be persisted to the CAS store during edit application. Edit was refused and disk left untouched. | Retry the edit; or use `write` if the store stays unavailable. |
| `[E_UNDO_REVERT_FAILED]`| Undo | Correlated foreign-source cut transaction was interrupted mid-revert. Undo history retained for safety. | Inspect both files; repair remaining inconsistencies. |
| `[E_LARGE_FILE]` | Admission | File exceeds admission budget (200,000 lines `SERVED_MAX_LINES`) or anchor address space ($14,766,336$ lines). | Fact-only: no options rendered (per [ADR-0047](../adr/0047-remediation-options-are-refusal-scoped-and-neutral.md)). |
| `[E_INTERNAL_INVARIANT]`| Invariant | An internal MVCC or CAS store invariant failed. | Check error message details; report issue if persistent. |
| `[E_UNKNOWN]` | Runtime | Unexpected filesystem or runtime exception. | Inspect raw error string. |

---

## Applied Warnings (`[W_*]`)

Warnings accompany successful tool executions (`status: "applied"`). They inform the model or user of non-fatal adjustments made during execution.

| Warning Code | Audience | Trigger Condition | Engine Action |
| :--- | :--- | :--- | :--- |
| `[W_NEVER_SERVED_SHAPE]` | `[MODEL]` | Replacement line starts with an anchor-shaped token (4 alphanumeric chars followed by `│`) never served in this session. | Applied verbatim (assumed intentional syntax or comment). |
| `[W_SERVED_PREFIX_MISMATCH]` | `[MODEL]` | Replacement line starts with a served anchor prefix, but subsequent text differs from original content. | Applied verbatim. |
| `[W_REVERSED_ANCHORS]` | `[USER]` | `anchor_from` occurs after `anchor_to` in file lineage. | Range automatically swapped and applied cleanly. |
| `[W_UNICODE_LITERAL]` | `[USER]` | Replacement text contains literal `\uDDDD` escape sequences. | Applied verbatim without unescaping. |
| `[W_LITERAL_BYPASS]` | `[USER]` | Edit specified `mode: "literal"`, bypassing served-echo anchor checks. | Applied verbatim. |
| `[W_NOOP]` | `[USER]` | Identical edit submitted a second consecutive time without changing range text; file was left unmodified. | Warning emitted; a third consecutive submission triggers `[E_NOOP_LOOP]`. |
| `[W_NOOP_INSERT]` | `[MODEL]` | Empty insertion (`text: ""`) placed with `at: "before"` or `at: "after"`. | No bytes written; call succeeds with diagnostic warning. |
