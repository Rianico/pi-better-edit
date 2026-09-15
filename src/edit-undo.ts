import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readUndo, writeUndo, removeUndo, type UndoRecord } from "./undo-store.js";
import { adoptPinnedSnapshotFor, anchorsForSnapshotHash, snapshotHashFor } from "./snapshot-store";
import { createSessionHandle, sessionKeyFor } from "./served-session/session.js";
import { resolveTarget, writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { DEFERRED_STORE_SYNC_WARNING } from "./constants.js";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./edit-diff.js";
import { cntDiff, visLines, splitLines, errCode, isRec, normalizeFilePath } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { buildMetrics, type EditDetails } from "./edit-response.js";
import { changedRange, lineHashes } from "./hashline/index.js";
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

export function regEditUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "undo_last_edit",
    label: "Undo Last Edit",
    description: loadP("../prompts/undo-last-edit.md"),
    promptSnippet: loadP("../prompts/undo-last-edit-snippet.md"),
    promptGuidelines: loadGuide("../prompts/undo-last-edit-guidelines.md"),
    prepareArguments: (args: unknown) => {
      if (!isRec(args)) return args as any;
      const record = { ...args };
      normalizeFilePath(record);
      return record;
    },
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

      return withFileMutationQueue(mutationTargetPath, async () => {
        let currentRaw: string | undefined;
        try {
          currentRaw = await readFile(mutationTargetPath, "utf-8");
        } catch (error) {
          if (errCode(error) !== "ENOENT") throw error;
        }

        if (currentRaw === undefined) {
          await clearUndo(mutationTargetPath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] cannot undo on ${path}: file no longer exists.`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        if (currentRaw !== undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)) {
          await clearUndo(mutationTargetPath);
          return {
            content: [
              {
                type: "text",
                text: `[E_UNDO_STALE] cannot undo on ${path}: file modified after edit — undo would overwrite changes.`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        const { text: currentStripped } = stripBOM(currentRaw);
        const currentNormalized = toLF(currentStripped);
        // WHY: undo_last_edit is one of the five universal serve hooks (spec §6), so it must scope
        // WHY: its served state to the SAME session key as `read`/`edit` — a literal fallback here
        // WHY: silently wrote leases and served rows under a different session id and forced the
        // WHY: model into the fail-closed retry loop this ticket removes.
        const sessionKeyForUndo = sessionKeyFor(
          ctx as unknown as { sessionManager?: { getSessionId(): string } },
        );
        const restoredContentHash = undo.snapshotHash ?? snapshotHashFor(undo.content);
        const restoredLineCount = splitLines(undo.content).length;
        // WHY: the pinned snapshot is the authority for the restored rows (spec §3.1.4 step 4:
        // WHY: presentation anchors are never re-derived). The retired ADR-0013 tombstone path used
        // WHY: to mint fresh anchors for lines the edit had displaced — anchors absent from the
        // WHY: adopted lineage, so no `served_leases` row could ever reference them and the model
        // WHY: was forced into a `read` before it could edit again (Probe §7.2.9).
        let restoredHashes = undo.hashes;
        try {
          restoredHashes =
            (await anchorsForSnapshotHash(mutationTargetPath, restoredContentHash)) ?? undo.hashes;
        } catch (error) {
          // SAFETY: best-effort anchor recovery — the pinned snapshot lookup failed, so the
          // SAFETY: undo falls back to the stored hashes; the file restore and diff stay valid.
          console.error("Failed to load anchors for undo restore:", error);
        }
        const currentHashes = await lineHashes(currentNormalized, mutationTargetPath);
        const diffResult = genDiff(undo.content, currentNormalized, 0, undefined, undo.hashes);
        const linesAddedByEdit = cntDiff(diffResult.diff, "+");
        const linesRemovedByEdit = cntDiff(diffResult.diff, "-");
        const restoredRange = changedRange(currentNormalized, undo.content);
        const undoDiffResult = genDiff(
          currentNormalized,
          undo.content,
          1,
          restoredHashes,
          currentHashes,
        );
        const undoDiff = undoDiffResult.diff;
        const undoDenseRows: typeof undoDiffResult.servedRows = [];
        for (let i = 0; i < restoredHashes.length; i++) {
          undoDenseRows.push({ position: i, hash: restoredHashes[i]! });
        }
        try {
          const curSet = new Set(currentHashes);
          const restoredSet = new Set(restoredHashes);
          const toRetire = [...curSet].filter((h) => !restoredSet.has(h));
          if (toRetire.length > 0) {
            try {
              await createSessionHandle(sessionKeyForUndo, mutationTargetPath).retire(toRetire);
            } catch (error) {
              // SAFETY: best-effort retire — displaced-anchor cleanup failed; the file is still
              // SAFETY: restored and the next edit fails closed if it must.
              console.error("Failed to retire displaced anchors during undo:", error);
            }
          }
        } catch (error) {
          // SAFETY: best-effort displaced-anchor computation — Set/filter failed (defensive);
          // SAFETY: the file restore proceeds; a missed retire degrades to fail-closed.
          console.error("Failed to compute displaced anchors during undo:", error);
        }

        const deferredSyncWarnings: string[] = [];

        await writeAtomic(
          mutationTargetPath,
          undo.bom + restoreEndings(undo.content, undo.originalEnding),
        );

        try {
          // WHY: the undo revert is ONE store transaction (spec §3.1.2): the pinned-snapshot adopt,
          // WHY: the authoritative `served_leases.retired_at` writer (spec §3.1.3: `UPDATE
          // WHY: served_leases SET retired_at = :now WHERE file_path = :path AND retired_at IS NULL
          // WHY: AND line_id NOT IN (...)`) and the restored-line lease upsert share a single
          // WHY: `BEGIN IMMEDIATE` / `withBusyRetry`. Splitting them left adopted lineage (or
          // WHY: retired leases) committed for content that was already on disk whenever the later
          // WHY: step failed.
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
            },
          );
        } catch (error) {
          // SAFETY: §3.6.2 post-write semantics — the restore transaction failed AFTER `writeAtomic`
          // SAFETY: put the bytes back, so the file is never rolled back. The result still reports
          // SAFETY: success and names the deferred synchronization; the next call re-materializes.
          console.error("Failed to commit the undo restore transaction:", error);
          deferredSyncWarnings.push(DEFERRED_STORE_SYNC_WARNING);
        }

        // WHY: undo_last_edit is a serve hook (spec §6 stage 1, path 5): the restored rows are
        // WHY: presented to the model, so the legacy served mirror (still the authority the current
        // WHY: `resolve`/`verifyServedRange` path reads, until #85 lands the lease-only seam) is
        // WHY: (re-)written here. The v7 `served_leases` identities were granted in the restore
        // WHY: transaction above.
        try {
          const handle = createSessionHandle(sessionKeyForUndo, mutationTargetPath);
          await handle.recordTruncated(undoDenseRows, restoredLineCount, 0);
        } catch (error) {
          // SAFETY: best-effort serve recording after undo — the file is restored and the diff rows are valid; a missed serve degrades to the fail-closed path the next edit would take anyway.
          console.error("Failed to record undo serves:", error);
        }

        await clearUndo(mutationTargetPath);

        const parts: string[] = [`Undone last edit on ${path}.`];
        if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
          parts.push(
            `Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
          );
        }
        parts.push("File reverted; diff rows carry fresh anchors for follow-up edits.");
        parts.push(...deferredSyncWarnings);

        const details: EditDetails = {
          diff: undoDiff,
          firstChangedLine: restoredRange?.firstChangedLine ?? undoDiffResult.firstChangedLine,
          resultLineCount: visLines(undo.content).length,
          servedRows: undoDenseRows,
          contentHash: restoredContentHash,
          ...(deferredSyncWarnings.length > 0 ? { warnings: deferredSyncWarnings } : {}),
          metrics: buildMetrics({
            classification: "applied",
            editsAttempted: 1,
            noopEditsCount: 0,
            warningsCount: deferredSyncWarnings.length,
            firstChangedLine: restoredRange?.firstChangedLine,
            lastChangedLine: restoredRange?.lastChangedLine,
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
    },
  });
}
