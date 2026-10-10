import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readUndo,
  writeUndo,
  removeUndo,
  readUndoTransaction,
  saveCutIntent,
  dropCutIntent,
  clearUndoTransaction,
  type UndoRecord,
} from "./undo-store.js";
import { withSortedMutationQueues } from "./mutation-queue.js";
import { adoptPinnedSnapshotFor, anchorsForSnapshotHash, snapshotHashFor } from "./snapshot-store";
import { sessionKeyFor } from "./served-session/session.js";
import { readBytes, resolveTarget, writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { DEFERRED_STORE_SYNC_WARNING } from "./constants.js";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./edit-diff.js";
import { visLines, splitLines, errCode } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { buildMetrics, type EditDetails } from "./edit-response.js";
import { DomainError, withPayloadSubject } from "./domain-errors.js";
import { ANCHOR_GENERATION, changedRange, lineHashes } from "./hashline/index.js";
import { denseServeRows, type ServedRow } from "./hashline/served.js";
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: LineEnding;
  hashes: string[];
  resultContent: string;
  /**
   * The committed `file_snapshots.snapshot_hash` of `content` — the restored target pinned for
   * vacuum retention and adopted by the undo revert (spec §3.1.2, issue #82).
   */
  snapshotHash?: string | null;
  /**
   * (ticket-04b §4) Correlation id of a multi-file cut transaction; `null`/absent is an ordinary
   * single-file edit. Undo of a file whose row carries an id reverts EVERY file of the
   * transaction or fails closed with no partial revert.
   */
  transactionId?: string | null;
  /**
   * (04b-rem P2-2) The RAW pre-transaction text, captured by the cut transaction before its
   * first rename. A correlated revert writes these bytes back when present — a revert is not a
   * re-serialization — and the admission round-trip guard makes the write byte-identical by
   * construction. Absent/NULL on ordinary single-file rows: the canonical fold is restored.
   */
  rawPre?: string | null;
  /** The anchor generation the stored hashes were derived under (0 = pre-generation). */
  anchorGeneration?: number | null;
}

export async function saveUndo(
  path: string,
  entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
  let previous: UndoRecord | undefined;
  try {
    previous = await readUndo(path);
    await writeUndo(path, {
      content: entry.content,
      bom: entry.bom,
      ending: entry.originalEnding,
      hashes: entry.hashes,
      resultContent: entry.resultContent,
      // WHY: the restored content is the pre-edit bytes the read-path materialized; pinning its
      // WHY: canonical hash lets the revert adopt that snapshot verbatim (zero counter ids) instead
      // WHY: of re-deriving it, and keeps the target pinned against vacuum (spec §3.6.1).
      snapshotHash: entry.snapshotHash ?? snapshotHashFor(entry.content),
      transactionId: entry.transactionId ?? null,
      rawPre: entry.rawPre ?? null,
      // WHY: ADR-0031 §4 — forward the payload generation so the store stamp (upsertUndo)
      // WHY: can preserve it on replay; absent (ordinary edit) defaults to ANCHOR_GENERATION there.
      anchorGeneration: entry.anchorGeneration ?? ANCHOR_GENERATION,
    });
  } catch (error) {
    // SAFETY: typed error handling — persist failure returns { persisted: false } and caller throws E_UNDO_UNAVAILABLE; logging preserves cause, not silent undefined, downstream handles rejection.
    console.error("Failed to persist undo entry:", error);
    return { persisted: false, restore: async () => undefined };
  }
  return {
    persisted: true,
    restore: async () => {
      try {
        if (previous) await writeUndo(path, previous);
        else await removeUndo(path);
      } catch (error) {
        // SAFETY: best-effort undo restore — failures to restore previous undo entry after persist failure are ignored; edit already failed and will report E_UNDO_UNAVAILABLE, stale undo state is recoverable on next edit.
        console.error("Failed to restore previous undo entry:", error);
      }
    },
  };
}

export async function getUndo(path: string): Promise<UndoEntry | undefined> {
  try {
    const record = await readUndo(path);
    if (!record) return undefined;
    const originalEnding = record.ending;
    if (originalEnding !== "\r\n" && originalEnding !== "\n" && originalEnding !== "\r") {
      await removeUndo(path);
      return undefined;
    }
    return {
      content: record.content,
      bom: record.bom,
      originalEnding,
      hashes: record.hashes,
      resultContent: record.resultContent,
      snapshotHash: record.snapshotHash ?? null,
      transactionId: record.transactionId ?? null,
      anchorGeneration: record.anchorGeneration ?? 0,
    };
  } catch (error) {
    // SAFETY: best-effort undo load — failures return undefined (no history) and caller reports "No undo history"; stale or corrupt store is recoverable on next edit, not silent undefined without log.
    console.error("Failed to load undo entry:", error);
    return undefined;
  }
}

export async function clearUndo(path: string): Promise<void> {
  try {
    await removeUndo(path);
  } catch (error) {
    // SAFETY: best-effort undo cleanup — clearUndo failures are ignored; stale undo entry will be overwritten on next edit or pruned, file content already correct.
    console.error("Failed to clear undo entry:", error);
  }
}

// WHY: (ticket-04b §4) the correlated member of one cut transaction, normalized from its
// WHY: `file_undo` row: the pre bytes (`content`) and the post bytes (`resultContent`) plus the
// WHY: serialization the revert shares with every other write (`bom + restoreEndings(...)`).
interface UndoMember {
  absolutePath: string;
  displayPath: string;
  content: string;
  bom: string;
  ending: LineEnding;
  hashes: string[];
  resultContent: string;
  snapshotHash: string | null;
  rawPre: string | null;
  /** The anchor generation the stored hashes were derived under (0 = pre-generation). */
  anchorGeneration: number;
}

function toMember(row: UndoRecord & { path: string }, displayPath: string): UndoMember | undefined {
  const ending = row.ending;
  if (ending !== "\r\n" && ending !== "\n" && ending !== "\r") return undefined;
  return {
    absolutePath: row.path,
    displayPath,
    content: row.content,
    bom: row.bom,
    ending,
    hashes: row.hashes,
    resultContent: row.resultContent,
    snapshotHash: row.snapshotHash ?? null,
    rawPre: row.rawPre ?? null,
    anchorGeneration: row.anchorGeneration ?? 0,
  };
}

/**
 * (ticket-04b section 4, remediated by 04b-rem P2-1) Undo of one correlated cut transaction is a
 * DURABLE TRANSACTION, mirroring the forward cut: freshness of all members is validated FIRST by
 * BYTES; a `revert`-direction intent record lands BEFORE the first write; the undo rows are
 * cleared ONCE after the last write; and a write that fails partway COMPLETES the revert over the
 * remaining members instead of escaping raw. A completion that is itself defeated refuses with the
 * typed `E_UNDO_REVERT_FAILED` (MODEL audience, remedy names the repair) and clears NOTHING — the
 * intent plus the intact rows let the next run's `repairCutIntents` finish the revert. A stale or
 * deleted member fails the whole undo closed with `E_UNDO_STALE` naming THAT member, before the
 * intent exists, and no undo row of the transaction is cleared: clearing one row of a correlated
 * set would silently degrade a future undo into a partial revert. Reverts run under the same
 * sorted multi-path queues the cut transaction itself used.
 */
async function undoCorrelatedTransaction(
  txnId: string,
  requestedAbsolutePath: string,
  requestedDisplayPath: string,
  ctx: unknown,
) {
  const rows = await readUndoTransaction(txnId);
  const members: UndoMember[] = [];
  for (const row of rows) {
    const display = row.path === requestedAbsolutePath ? requestedDisplayPath : row.path;
    const member = toMember(row, display);
    // WHY: a corrupt-ending row poisons the whole set: fail closed naming it, revert nothing.
    if (!member) {
      return {
        content: [
          {
            type: "text" as const,
            text: new DomainError("E_UNDO_STALE", {
              path: row.path,
              reason: "modified" as const,
            }).message,
          },
        ],
        isError: true,
        details: {},
      };
    }
    members.push(member);
  }
  if (!members.some((m) => m.absolutePath === requestedAbsolutePath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No undo history for ${requestedDisplayPath}. There is no previous edit to revert.`,
        },
      ],
      isError: true,
      details: {},
    };
  }

  const sessionKeyForUndo = sessionKeyFor(
    // SAFETY: ctx is untyped at the pi boundary — cast validated by pi's runtime shape
    ctx as unknown as { sessionManager?: { getSessionId(): string } },
  );

  return withSortedMutationQueues(
    members.map((m) => m.absolutePath),
    async () => {
      // WHY: validate ALL members before reverting ANY (no partial revert) — and validate BYTES
      // WHY: through the file layer's read primitive (04b-rem P2-3): the post image on disk is
      // WHY: exactly what the commit wrote, and a decode-lenient string comparison could call
      // WHY: different bytes equal.
      const currents: { member: UndoMember; raw: string }[] = [];
      for (const member of members) {
        let bytes: Buffer | undefined;
        try {
          bytes = await readBytes(member.absolutePath);
        } catch (error) {
          if (errCode(error) !== "ENOENT") throw error;
        }
        if (bytes === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: new DomainError("E_UNDO_STALE", {
                  path: member.displayPath,
                  reason: "deleted" as const,
                }).message,
              },
            ],
            isError: true,
            details: {},
          };
        }
        const expectedPost = member.bom + restoreEndings(member.resultContent, member.ending);
        if (!bytes.equals(Buffer.from(expectedPost, "utf-8"))) {
          return {
            content: [
              {
                type: "text" as const,
                text: new DomainError("E_UNDO_STALE", {
                  path: member.displayPath,
                  reason: "modified" as const,
                }).message,
              },
            ],
            isError: true,
            details: {},
          };
        }
        currents.push({ member, raw: bytes.toString("utf-8") });
      }

      // WHY: prepare every member's revert IN MEMORY before anything is written: no step of this
      // WHY: loop touches the write side, so a throw here leaves every file untouched and the
      // WHY: intent below is never recorded — the honest "any failure BEFORE the first write
      // WHY: writes nothing" half of the durable-revert story.
      const plans: {
        member: UndoMember;
        restoreBytes: Buffer;
        diff: string;
        addedByEdit: number;
        removedByEdit: number;
        servedRows: ServedRow[];
        restoredContentHash: string;
        restoredLineCount: number;
        restoredHashes: string[];
        displacedAnchors: string[];
        restoredRange: { firstChangedLine?: number; lastChangedLine?: number } | null;
      }[] = [];
      for (const { member, raw } of currents) {
        const { text: currentStripped } = stripBOM(raw);
        const currentNormalized = toLF(currentStripped);
        // WHY: a pre-generation row's stored key/anchors are a foreign anchor generation — adopt them
        // WHY: never. Fresh key + re-derivation keep the restore on the current anchors.
        const storedIsCurrentGeneration = member.anchorGeneration === ANCHOR_GENERATION;
        const restoredContentHash = storedIsCurrentGeneration
          ? (member.snapshotHash ?? snapshotHashFor(member.content))
          : snapshotHashFor(member.content);
        const restoredLineCount = splitLines(member.content).length;
        let restoredHashes: string[];
        try {
          restoredHashes =
            (await anchorsForSnapshotHash(member.absolutePath, restoredContentHash)) ??
            (storedIsCurrentGeneration
              ? member.hashes
              : await lineHashes(member.content, member.absolutePath));
        } catch (error) {
          // SAFETY: best-effort anchor recovery — the pinned snapshot lookup failed, so the undo
          // SAFETY: falls back to the stored current-generation hashes (or a fresh
          // SAFETY: file-scoped derivation for a legacy row); the file restore and diff stay valid.
          console.error("Failed to load anchors for undo restore:", error);
          restoredHashes = storedIsCurrentGeneration
            ? member.hashes
            : await lineHashes(member.content, member.absolutePath);
        }
        const currentHashes = await lineHashes(currentNormalized, member.absolutePath);
        const remainingUndoCounts = new Map<string, number>();
        for (const line of visLines(member.content)) {
          remainingUndoCounts.set(line, (remainingUndoCounts.get(line) ?? 0) + 1);
        }
        let linesAddedByEdit = 0;
        for (const line of visLines(currentNormalized)) {
          const remaining = remainingUndoCounts.get(line) ?? 0;
          if (remaining > 0) remainingUndoCounts.set(line, remaining - 1);
          else linesAddedByEdit++;
        }
        let linesRemovedByEdit = 0;
        for (const remaining of remainingUndoCounts.values()) linesRemovedByEdit += remaining;
        const restoredRange = changedRange(currentNormalized, member.content);
        const undoDiffResult = genDiff(
          currentNormalized,
          member.content,
          1,
          restoredHashes,
          currentHashes,
        );
        const undoDenseRows = denseServeRows(restoredHashes);
        const curSet = new Set(currentHashes);
        const restoredSet = new Set(restoredHashes);
        const displacedAnchors: string[] = [...curSet].filter((h) => !restoredSet.has(h));
        // WHY: (04b-rem P2-2) a revert is not a re-serialization: when the row carries the RAW
        // WHY: pre image the cut captured, those exact bytes go back; the canonical fold is the
        // WHY: fallback for pre-remediation rows without one.
        const restoreBytes =
          member.rawPre !== null && member.rawPre !== undefined
            ? Buffer.from(member.rawPre, "utf-8")
            : Buffer.from(member.bom + restoreEndings(member.content, member.ending), "utf-8");
        plans.push({
          member,
          restoreBytes,
          diff: undoDiffResult.diff,
          addedByEdit: linesAddedByEdit,
          removedByEdit: linesRemovedByEdit,
          servedRows: undoDenseRows,
          restoredContentHash,
          restoredLineCount,
          restoredHashes,
          displacedAnchors,
          restoredRange,
        });
      }

      // WHY: durable revert, STEP 1: the intent record lands BEFORE the first revert write, so a
      // WHY: crash between the writes is detectable — `repairCutIntents` completes the revert
      // WHY: from the same rows on the next run (04b-rem P2-1: durability, not reordering).
      await saveCutIntent(txnId, requestedAbsolutePath, "revert");

      // WHY: test-only observation seam (04b-rem2 R2), the revert-side mirror of
      // WHY: `onBeforeFirstCutWrite`: it fires BEFORE the first revert write, while every member
      // WHY: still sits at the cut's post bytes, so the write-ahead ordering is observable here too.
      const undoCtx = ctx as { onBeforeUndoWrites?: () => void | Promise<void> };
      if (undoCtx?.onBeforeUndoWrites) await undoCtx.onBeforeUndoWrites();

      // WHY: durable revert, STEP 2: this call owns the window it opens — a failed write first
      // WHY: COMPLETES the revert inline over the remaining members. Only a completion that is
      // WHY: itself defeated refuses: rows and intent then stay intact and the typed
      // WHY: `E_UNDO_REVERT_FAILED` hands the half-reverted state to the next-run repair.
      const reverted = new Set<string>();
      let defeated: UndoMember | undefined;
      for (const plan of plans) {
        try {
          await writeAtomic(plan.member.absolutePath, plan.restoreBytes);
          reverted.add(plan.member.absolutePath);
          // WHY: test-only fault-injection seam, the undo-side mirror of `onCutBetweenWrites`:
          // WHY: it fires INSIDE the revert window, after each member write is durable.
          const seam = (
            ctx as { onUndoBetweenWrites?: (writtenAbsolutePath: string) => void | Promise<void> }
          )?.onUndoBetweenWrites;
          if (seam) await seam(plan.member.absolutePath);
        } catch {
          for (const rest of plans) {
            if (reverted.has(rest.member.absolutePath)) continue;
            try {
              await writeAtomic(rest.member.absolutePath, rest.restoreBytes);
              reverted.add(rest.member.absolutePath);
            } catch (completionError) {
              console.error("Failed to complete the interrupted revert:", completionError);
              defeated ??= rest.member;
            }
          }
          break;
        }
      }
      if (defeated !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: new DomainError("E_UNDO_REVERT_FAILED", {
                path: defeated.displayPath,
              }).message,
            },
          ],
          isError: true,
          details: {},
        };
      }

      // WHY: durable revert, STEP 3: every byte landed. The store commit per member keeps the
      // WHY: same single-transaction shape (adopt + leases + mirror + displaced retirement) and
      // WHY: the same non-fatal deferred-sync semantics; then ONE clear retires the whole
      // WHY: transaction's rows — never member by member, the mid-loop `clearUndo` this replaces
      // WHY: is exactly what degraded the retry into "No undo history".
      const sections: {
        member: UndoMember;
        diff: string;
        addedByEdit: number;
        removedByEdit: number;
      }[] = [];
      const allServedRows: ServedRow[] = [];
      const deferredSyncWarnings: string[] = [];
      let requestedContentHash = "";
      let requestedLineCount = 0;
      let requestedRange: { firstChangedLine?: number; lastChangedLine?: number } | null = null;
      for (const plan of plans) {
        const { member } = plan;
        try {
          await adoptPinnedSnapshotFor(
            {
              path: member.absolutePath,
              snapshotHash: plan.restoredContentHash,
              lineCount: plan.restoredLineCount,
              hashes: plan.restoredHashes,
              content: member.content,
            },
            {
              retireLeases: true,
              leases: { sessionKey: sessionKeyForUndo, rows: plan.servedRows },
              servedMirror: {
                sessionKey: sessionKeyForUndo,
                rows: plan.servedRows,
                shape: { lineCount: plan.restoredLineCount, clearFrom: 0 },
                retireAnchors: plan.displacedAnchors,
              },
            },
          );
        } catch (error) {
          // SAFETY: section 3.6.2 post-write semantics — the bytes are back on disk, so the member
          // SAFETY: is never rolled forward again; the store re-materializes on the next read.
          console.error("Failed to commit the undo restore transaction:", error);
          deferredSyncWarnings.push(DEFERRED_STORE_SYNC_WARNING);
        }

        if (member.absolutePath === requestedAbsolutePath) {
          requestedContentHash = plan.restoredContentHash;
          requestedLineCount = visLines(member.content).length;
          requestedRange = plan.restoredRange;
        }
        sections.push({
          member,
          diff: plan.diff,
          addedByEdit: plan.addedByEdit,
          removedByEdit: plan.removedByEdit,
        });
        allServedRows.push(...plan.servedRows);
      }

      await clearUndoTransaction(txnId);
      try {
        await dropCutIntent(txnId);
      } catch (error) {
        // SAFETY: every byte and both row clears committed — an orphan revert intent resolves to
        // SAFETY: "every member at pre" on the next run and retires itself; the undo stands.
        console.error("Failed to clear the revert intent after commit:", error);
      }

      const names = members.map((m) => m.displayPath).join(", ");
      const parts: string[] = [`Undone last edit on ${names}.`];
      for (const section of sections) {
        if (section.addedByEdit > 0 || section.removedByEdit > 0) {
          parts.push(
            `Removed ${section.addedByEdit} line(s) that were added and restored ${section.removedByEdit} line(s) that were removed.`,
          );
        }
      }
      parts.push(
        deferredSyncWarnings.length > 0
          ? "Files reverted; store synchronization is deferred (see the warning below), so the diff rows are not anchored for follow-up edits until the next read."
          : "Files reverted; diff rows carry fresh anchors for follow-up edits.",
      );
      parts.push(...deferredSyncWarnings);

      const totalAdded = sections.reduce((sum, s) => sum + s.addedByEdit, 0);
      const totalRemoved = sections.reduce((sum, s) => sum + s.removedByEdit, 0);
      const details: EditDetails = {
        // WHY: the same `--- path ---` section convention the edit response uses for multi-file
        // WHY: batches, so the model reads a two-file revert the same way it reads a two-file cut.
        diff: sections.map((s) => `--- ${s.member.displayPath} ---\n${s.diff}`).join("\n"),
        ...(requestedRange?.firstChangedLine !== undefined
          ? { firstChangedLine: requestedRange.firstChangedLine }
          : {}),
        ...(requestedRange?.lastChangedLine !== undefined
          ? { lastChangedLine: requestedRange.lastChangedLine }
          : {}),
        resultLineCount: requestedLineCount,
        servedRows: allServedRows,
        contentHash: requestedContentHash,
        ...(deferredSyncWarnings.length > 0 ? { warnings: deferredSyncWarnings } : {}),
        metrics: buildMetrics({
          classification: "applied",
          editsAttempted: sections.length,
          noopEditsCount: 0,
          warningsCount: deferredSyncWarnings.length,
          ...(requestedRange?.firstChangedLine !== undefined
            ? { firstChangedLine: requestedRange.firstChangedLine }
            : {}),
          ...(requestedRange?.lastChangedLine !== undefined
            ? { lastChangedLine: requestedRange.lastChangedLine }
            : {}),
          addedLines: totalRemoved,
          removedLines: totalAdded,
        }),
      };
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details,
      };
    },
  );
}

export function regEditUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "undo_last_edit",
    label: "Undo Last Edit",
    description: loadP("../prompts/undo-last-edit.md"),
    promptSnippet: loadP("../prompts/undo-last-edit-snippet.md"),
    promptGuidelines: loadGuide("../prompts/undo-last-edit-guidelines.md"),
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const path = params.path;
        const absolutePath = toCwd(path, ctx.cwd);
        const mutationTargetPath = await resolveTarget(absolutePath);

        const undo = await getUndo(mutationTargetPath);
        if (!undo) {
          return {
            content: [
              {
                type: "text",
                text: `No undo history for ${path}. There is no previous edit to revert.`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        // WHY: (ticket-04b §4) a row carrying `transaction_id` is one member of a cut transaction:
        // WHY: undo of EITHER member reverts BOTH files, or fails closed with no partial revert. The
        // WHY: single-file arm below is untouched for rows without an id.
        if (undo.transactionId !== null && undo.transactionId !== undefined) {
          try {
            return await undoCorrelatedTransaction(
              undo.transactionId,
              mutationTargetPath,
              path,
              ctx,
            );
          } catch (error) {
            // SAFETY: 04b-rem P2-1 (the separate remedy defect): an unexpected failure must never
            // SAFETY: escape the tool as a raw non-[MODEL] throw — the registry's E_UNKNOWN
            // SAFETY: envelope renders it with its audience and code. Transactional state is
            // SAFETY: honest either way: the revert intent lands before the first write, so any
            // SAFETY: escape between writes leaves a half-reverted set that repair resolves.
            // WHY: the trace precedes BOTH exits, since a payload-shaped refusal returns early.
            // WHY: The operator must still see the unexpected failure that produced it.
            console.error("Unexpected failure in correlated undo:", error);
            // WHY: the subject must be stamped BEFORE the E_UNKNOWN envelope below, or that
            // WHY: conversion would replace the tool's own name and hide which call to repair.
            const stamped = withPayloadSubject(error, "undo_last_edit");
            if (stamped instanceof DomainError && stamped.code === "E_BAD_PAYLOAD") {
              return {
                content: [{ type: "text" as const, text: stamped.message }],
                isError: true,
                details: {},
              };
            }
            const err = error as { name?: string; message?: string };
            return {
              content: [
                {
                  type: "text" as const,
                  text: new DomainError("E_UNKNOWN", {
                    errorName: err.name ?? "Error",
                    message: err.message ?? String(error),
                  }).message,
                },
              ],
              isError: true,
              details: {},
            };
          }
        }

        return withFileMutationQueue(mutationTargetPath, async () => {
          // WHY: (04b-rem P2-3) the same byte-level comparison as the correlated arm — the fourth
          // WHY: restore/compare site shares the file layer's read primitive; a stale file is
          // WHY: different BYTES, not different decoded text.
          const currentBytes = await readBytes(mutationTargetPath).catch((error: unknown) => {
            if (errCode(error) === "ENOENT") return undefined;
            throw error;
          });

          if (currentBytes === undefined) {
            await clearUndo(mutationTargetPath);
            return {
              content: [
                {
                  type: "text",
                  text: new DomainError("E_UNDO_STALE", { path, reason: "deleted" }).message,
                },
              ],
              isError: true,
              details: {},
            };
          }
          if (
            !currentBytes.equals(
              Buffer.from(
                undo.bom + restoreEndings(undo.resultContent, undo.originalEnding),
                "utf-8",
              ),
            )
          ) {
            await clearUndo(mutationTargetPath);
            return {
              content: [
                {
                  type: "text",
                  text: new DomainError("E_UNDO_STALE", { path, reason: "modified" }).message,
                },
              ],
              isError: true,
              details: {},
            };
          }
          const currentRaw = currentBytes.toString("utf-8");

          const { text: currentStripped } = stripBOM(currentRaw);
          const currentNormalized = toLF(currentStripped);
          // WHY: undo_last_edit is one of the five universal serve hooks (spec §6), so it must scope
          // WHY: its served state to the SAME session key as `read`/`edit` — a literal fallback here
          // WHY: silently wrote leases and served rows under a different session id and forced the
          // WHY: model into the fail-closed retry loop this ticket removes.
          // SAFETY: the pi context is typed for the extension host, which exposes `sessionManager`
          // SAFETY: beyond the hook's declared context; a missing manager falls back to the literal key.
          const sessionKeyForUndo = sessionKeyFor(
            ctx as unknown as { sessionManager?: { getSessionId(): string } },
          );
          // WHY: a pre-generation row's stored key/anchors are a foreign anchor generation — adopt them
          // WHY: never. Fresh key + re-derivation keep the restore on the current anchors.
          const storedIsCurrentGeneration = (undo.anchorGeneration ?? 0) === ANCHOR_GENERATION;
          const restoredContentHash = storedIsCurrentGeneration
            ? (undo.snapshotHash ?? snapshotHashFor(undo.content))
            : snapshotHashFor(undo.content);
          const restoredLineCount = splitLines(undo.content).length;
          // WHY: the pinned snapshot is the authority for the restored rows (spec §3.1.4 step 4:
          // WHY: presentation anchors are never re-derived). The retired ADR-0013 blocked-hashes path used
          // WHY: to mint fresh anchors for lines the edit had displaced — anchors absent from the
          // WHY: adopted lineage, so no `served_leases` row could ever reference them and the model
          // WHY: was forced into a `read` before it could edit again (Probe §7.2.9).
          let restoredHashes: string[];
          try {
            restoredHashes =
              (await anchorsForSnapshotHash(mutationTargetPath, restoredContentHash)) ??
              (storedIsCurrentGeneration
                ? undo.hashes
                : await lineHashes(undo.content, mutationTargetPath));
          } catch (error) {
            // SAFETY: best-effort anchor recovery — the pinned snapshot lookup failed, so the undo
            // SAFETY: falls back to the stored current-generation hashes (or a fresh
            // SAFETY: file-scoped derivation for a legacy row); the file restore and diff stay valid.
            console.error("Failed to load anchors for undo restore:", error);
            restoredHashes = storedIsCurrentGeneration
              ? undo.hashes
              : await lineHashes(undo.content, mutationTargetPath);
          }
          const currentHashes = await lineHashes(currentNormalized, mutationTargetPath);
          // WHY: #173 — the summary counts come from the source line multisets, never from the
          // WHY: rendered projection: a deleted run past DIFF_REMOVED_CAP collapses behind a marker
          // WHY: row at context 0, so counting `-` rows underreported the restored lines (#169
          // WHY: projection-purity rule). A line the edit added is one present in the current file
          // WHY: beyond its occurrence count in `undo.content`; a line it removed is the converse.
          const remainingUndoCounts = new Map<string, number>();
          for (const line of visLines(undo.content)) {
            remainingUndoCounts.set(line, (remainingUndoCounts.get(line) ?? 0) + 1);
          }
          let linesAddedByEdit = 0;
          for (const line of visLines(currentNormalized)) {
            const remaining = remainingUndoCounts.get(line) ?? 0;
            if (remaining > 0) remainingUndoCounts.set(line, remaining - 1);
            else linesAddedByEdit++;
          }
          let linesRemovedByEdit = 0;
          for (const remaining of remainingUndoCounts.values()) linesRemovedByEdit += remaining;
          const restoredRange = changedRange(currentNormalized, undo.content);
          const undoDiffResult = genDiff(
            currentNormalized,
            undo.content,
            1,
            restoredHashes,
            currentHashes,
          );
          const undoDiff = undoDiffResult.diff;
          const undoDenseRows = denseServeRows(restoredHashes);
          // WHY: CAND-3 (#117 discipline): displaced-anchor retirement is a store mutation, so it
          // WHY: must not run before `writeAtomic` — a restore that never committed bytes must
          // WHY: retire nothing. The set difference below is pure computation; the retirement
          // WHY: itself rides the single restore transaction after the write, like everything else.
          const curSet = new Set(currentHashes);
          const restoredSet = new Set(restoredHashes);
          const displacedAnchors: string[] = [...curSet].filter((h) => !restoredSet.has(h));

          const deferredSyncWarnings: string[] = [];

          await writeAtomic(
            mutationTargetPath,
            undo.bom + restoreEndings(undo.content, undo.originalEnding),
          );

          try {
            // WHY: the undo revert is ONE store transaction (spec §3.1.2, CAND-3): the pinned-snapshot
            // WHY: adopt, the authoritative `served_leases.retired_at` writer (spec §3.1.3: `UPDATE
            // WHY: served_leases SET retired_at = :now WHERE file_path = :path AND retired_at IS NULL
            // WHY: AND line_id NOT IN (...)`), the restored-line lease upsert, the served mirror
            // WHY: write (the old `recordTruncated` — same clamp/clear/patch, same displaced
            // WHY: retirement) and the displaced-anchor retire all share a single `BEGIN IMMEDIATE` /
            // WHY: `withBusyRetry`. Splitting them left lease-without-mirror or mirror-without-lease
            // WHY: states whenever a later step failed; one failure now means one full rollback.
            // WHY: Naming the `file_undo.snapshot_hash` pin still adopts the canonical snapshot
            // WHY: verbatim on the cache hit — zero `line_id_counters` allocations — rather than
            // WHY: re-deriving the cache key, and the restored lines are re-leased with
            // WHY: `retired_at = NULL` inside that same transaction.
            await adoptPinnedSnapshotFor(
              {
                path: mutationTargetPath,
                snapshotHash: restoredContentHash,
                lineCount: restoredLineCount,
                hashes: restoredHashes,
                content: undo.content,
              },
              {
                retireLeases: true,
                // WHY: the restored rows are the serve this hook owes the model (spec §6 path 5): the
                // WHY: leases bind to the snapshot actually served, so the pin is named, not `S_latest`.
                leases: { sessionKey: sessionKeyForUndo, rows: undoDenseRows },
                // WHY: undo_last_edit is a serve hook (spec §6 stage 1, path 5): the restored rows are
                // WHY: presented to the model, so the served mirror is (re-)written here — it is the
                // WHY: record the reject paths serve rows from. The mirror shape reproduces the old
                // WHY: `recordTruncated(undoDenseRows, restoredLineCount, 0)` call exactly.
                servedMirror: {
                  sessionKey: sessionKeyForUndo,
                  rows: undoDenseRows,
                  shape: { lineCount: restoredLineCount, clearFrom: 0 },
                  retireAnchors: displacedAnchors,
                },
              },
            );
          } catch (error) {
            // SAFETY: §3.6.2 post-write semantics — the restore transaction failed AFTER `writeAtomic`
            // SAFETY: put the bytes back, so the file is never rolled back. The result still reports
            // SAFETY: success and names the deferred synchronization; the next call re-materializes.
            console.error("Failed to commit the undo restore transaction:", error);
            deferredSyncWarnings.push(DEFERRED_STORE_SYNC_WARNING);
          }

          await clearUndo(mutationTargetPath);

          const parts: string[] = [`Undone last edit on ${path}.`];
          if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
            parts.push(
              `Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
            );
          }
          // WHY: CAND-3 truthful degradation: the success claim is byte-identical; when the restore
          // WHY: transaction failed, the diff rows were NOT served (mirror and leases rolled back
          // WHY: together), so the claim names the warning instead of overstating fresh anchors.
          parts.push(
            deferredSyncWarnings.length > 0
              ? "File reverted; store synchronization is deferred (see the warning below), so the diff rows are not anchored for follow-up edits until the next read."
              : "File reverted; diff rows carry fresh anchors for follow-up edits.",
          );
          parts.push(...deferredSyncWarnings);

          // WHY: the restored range wins, else the rendered diff names it; either may be absent.
          const firstChangedLine =
            restoredRange?.firstChangedLine ?? undoDiffResult.firstChangedLine;
          const lastChangedLine = restoredRange?.lastChangedLine ?? undoDiffResult.lastChangedLine;
          const details: EditDetails = {
            diff: undoDiff,
            ...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
            ...(lastChangedLine !== undefined ? { lastChangedLine } : {}),
            resultLineCount: visLines(undo.content).length,
            servedRows: undoDenseRows,
            contentHash: restoredContentHash,
            ...(deferredSyncWarnings.length > 0 ? { warnings: deferredSyncWarnings } : {}),
            metrics: buildMetrics({
              classification: "applied",
              editsAttempted: 1,
              noopEditsCount: 0,
              warningsCount: deferredSyncWarnings.length,
              ...(restoredRange?.firstChangedLine !== undefined
                ? { firstChangedLine: restoredRange.firstChangedLine }
                : {}),
              ...(restoredRange?.lastChangedLine !== undefined
                ? { lastChangedLine: restoredRange.lastChangedLine }
                : {}),
              addedLines: linesRemovedByEdit,
              removedLines: linesAddedByEdit,
            }),
          };
          return {
            content: [
              {
                type: "text",
                text: parts.join("\n"),
              },
            ],
            details,
          };
        });
      } catch (error) {
        throw withPayloadSubject(error, "undo_last_edit");
      }
    },
  });
}
