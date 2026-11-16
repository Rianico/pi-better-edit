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
import {
  adoptPinnedSnapshotFor,
  anchorsForSnapshotHash,
  snapshotHashFor,
  snapshotIOFor,
} from "./snapshot-store";
import { loadHashStore } from "./hash-store.js";
import { sessionKeyFor } from "./served-session/session.js";
import { readBytes, resolveTarget, writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { DEFERRED_STORE_SYNC_WARNING } from "./constants.js";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./edit-diff.js";
import { visLines, splitLines, errCode } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { buildMetrics, type EditDetails } from "./edit-response.js";
import { DomainError, withPayloadSubject } from "./domain-errors.js";
import { ANCHOR_GENERATION, lineHashes } from "./hashline/hash-identity.js";

/**
 * Derives a row's anchors and persists the snapshot through the named store (arch-03).
 *
 * The store is passed in rather than resolved through the retired process-global IO, so the
 * restore write is visible at the call site and still lands where the default resolves.
 */
async function restoreHashes(content: string, path: string): Promise<string[]> {
  return lineHashes(content, path, undefined, snapshotIOFor(await loadHashStore()));
}
import { changedRange } from "./hashline/apply.js";
import { denseServeRows, type ServedRow } from "./served-session/serve-render.js";
import { reportDiagnostic } from "./diagnostics.js";
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
      snapshotHash: entry.snapshotHash ?? snapshotHashFor(entry.content),
      transactionId: entry.transactionId ?? null,
      rawPre: entry.rawPre ?? null,
      // Ref: docs/.archive_adrs/0031-file-scoped-anchors-residual-and-generation-discipline.md
      anchorGeneration: entry.anchorGeneration ?? ANCHOR_GENERATION,
    });
  } catch (error) {
    reportDiagnostic("edit-undo", "Failed to persist undo entry:", error);
    return { persisted: false, restore: async () => undefined };
  }
  return {
    persisted: true,
    restore: async () => {
      try {
        if (previous) await writeUndo(path, previous);
        else await removeUndo(path);
      } catch (error) {
        reportDiagnostic("edit-undo", "Failed to restore previous undo entry:", error);
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
    reportDiagnostic("edit-undo", "Failed to load undo entry:", error);
    return undefined;
  }
}

export async function clearUndo(path: string): Promise<void> {
  try {
    await removeUndo(path);
  } catch (error) {
    reportDiagnostic("edit-undo", "Failed to clear undo entry:", error);
  }
}

/**
 * `content` is the pre bytes (`resultContent` the post), and the row keeps `bom` and `ending`
 * apart so a revert rebuilds bytes through the same fold as every other write.
 */
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
 * (ticket-04b section 4, remediated by 04b-rem P2-1) Undo of one correlated cut transaction is a DURABLE TRANSACTION, mirroring the
 * forward cut: freshness of all members is validated FIRST by BYTES; a `revert`-direction intent record lands BEFORE the first write;
 * the undo rows are cleared ONCE after the last write; and a write that fails partway COMPLETES the revert over the remaining members
 * instead of escaping raw. A completion that is itself defeated refuses with the typed `E_UNDO_REVERT_FAILED` (MODEL audience, remedy
 * names the repair) and clears NOTHING — the intent plus the intact rows let the next run's `repairCutIntents` finish the revert. A
 * stale or deleted member fails the whole undo closed with `E_UNDO_STALE` naming THAT member, before the intent exists, and no undo row
 * is cleared: clearing one row of a correlated set would silently degrade a future undo into a partial revert. Reverts run under the
 * same sorted multi-path queues the cut transaction itself used.
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
              : await restoreHashes(member.content, member.absolutePath));
        } catch (error) {
          reportDiagnostic("edit-undo", "Failed to load anchors for undo restore:", error);
          restoredHashes = storedIsCurrentGeneration
            ? member.hashes
            : await restoreHashes(member.content, member.absolutePath);
        }
        const currentHashes = await restoreHashes(currentNormalized, member.absolutePath);
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

      await saveCutIntent(txnId, requestedAbsolutePath, "revert");

      const undoCtx = ctx as { onBeforeUndoWrites?: () => void | Promise<void> };
      if (undoCtx?.onBeforeUndoWrites) await undoCtx.onBeforeUndoWrites();

      const reverted = new Set<string>();
      let defeated: UndoMember | undefined;
      for (const plan of plans) {
        try {
          await writeAtomic(plan.member.absolutePath, plan.restoreBytes);
          reverted.add(plan.member.absolutePath);
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
              reportDiagnostic(
                "edit-undo",
                "Failed to complete the interrupted revert:",
                completionError,
              );
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
          // Ref: docs/spec/content-addressed-line-identity-mvcc.md
          reportDiagnostic("edit-undo", "Failed to commit the undo restore transaction:", error);
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
        reportDiagnostic("edit-undo", "Failed to clear the revert intent after commit:", error);
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

        if (undo.transactionId !== null && undo.transactionId !== undefined) {
          try {
            return await undoCorrelatedTransaction(
              undo.transactionId,
              mutationTargetPath,
              path,
              ctx,
            );
          } catch (error) {
            reportDiagnostic("edit-undo", "Unexpected failure in correlated undo:", error);
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
          const sessionKeyForUndo = sessionKeyFor(
            // SAFETY: the pi context is typed for the extension host, which exposes `sessionManager`
            // SAFETY: beyond the hook's declared context; a missing manager falls back to the literal key.
            ctx as unknown as { sessionManager?: { getSessionId(): string } },
          );
          const storedIsCurrentGeneration = (undo.anchorGeneration ?? 0) === ANCHOR_GENERATION;
          const restoredContentHash = storedIsCurrentGeneration
            ? (undo.snapshotHash ?? snapshotHashFor(undo.content))
            : snapshotHashFor(undo.content);
          const restoredLineCount = splitLines(undo.content).length;
          // Ref: docs/.archive_adrs/0013-pos-free-roundtrip-optimization.md
          let restoredHashes: string[];
          try {
            restoredHashes =
              (await anchorsForSnapshotHash(mutationTargetPath, restoredContentHash)) ??
              (storedIsCurrentGeneration
                ? undo.hashes
                : await restoreHashes(undo.content, mutationTargetPath));
          } catch (error) {
            reportDiagnostic("edit-undo", "Failed to load anchors for undo restore:", error);
            restoredHashes = storedIsCurrentGeneration
              ? undo.hashes
              : await restoreHashes(undo.content, mutationTargetPath);
          }
          const currentHashes = await restoreHashes(currentNormalized, mutationTargetPath);
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
          const curSet = new Set(currentHashes);
          const restoredSet = new Set(restoredHashes);
          const displacedAnchors: string[] = [...curSet].filter((h) => !restoredSet.has(h));

          const deferredSyncWarnings: string[] = [];

          await writeAtomic(
            mutationTargetPath,
            undo.bom + restoreEndings(undo.content, undo.originalEnding),
          );

          try {
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
                leases: { sessionKey: sessionKeyForUndo, rows: undoDenseRows },
                servedMirror: {
                  sessionKey: sessionKeyForUndo,
                  rows: undoDenseRows,
                  shape: { lineCount: restoredLineCount, clearFrom: 0 },
                  retireAnchors: displacedAnchors,
                },
              },
            );
          } catch (error) {
            reportDiagnostic("edit-undo", "Failed to commit the undo restore transaction:", error);
            deferredSyncWarnings.push(DEFERRED_STORE_SYNC_WARNING);
          }

          await clearUndo(mutationTargetPath);

          const parts: string[] = [`Undone last edit on ${path}.`];
          if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
            parts.push(
              `Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
            );
          }
          parts.push(
            deferredSyncWarnings.length > 0
              ? "File reverted; store synchronization is deferred (see the warning below), so the diff rows are not anchored for follow-up edits until the next read."
              : "File reverted; diff rows carry fresh anchors for follow-up edits.",
          );
          parts.push(...deferredSyncWarnings);

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
