import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readUndo, writeUndo, removeUndo, type UndoRecord } from "./undo-store.js";
import { adoptPinnedSnapshotFor, anchorsForSnapshotHash, snapshotHashFor } from "./snapshot-store";
import { sessionKeyFor } from "./served-session/session.js";
import { resolveTarget, writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { DEFERRED_STORE_SYNC_WARNING } from "./constants.js";
import { toLF, stripBOM, genDiff, restoreEndings, type LineEnding } from "./edit-diff.js";
import { visLines, splitLines, errCode, isRec, normalizeFilePath } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { buildMetrics, type EditDetails } from "./edit-response.js";
import { DomainError } from "./domain-errors.js";
import { changedRange, lineHashes } from "./hashline/index.js";
import { denseServeRows } from "./hashline/served.js";
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
                text: new DomainError("E_UNDO_STALE", { path, reason: "deleted" }).message,
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
                text: new DomainError("E_UNDO_STALE", { path, reason: "modified" }).message,
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
        // SAFETY: the pi context is typed for the extension host, which exposes `sessionManager`
        // SAFETY: beyond the hook's declared context; a missing manager falls back to the literal key.
        const sessionKeyForUndo = sessionKeyFor(
          ctx as unknown as { sessionManager?: { getSessionId(): string } },
        );
        const restoredContentHash = undo.snapshotHash ?? snapshotHashFor(undo.content);
        const restoredLineCount = splitLines(undo.content).length;
        // WHY: the pinned snapshot is the authority for the restored rows (spec §3.1.4 step 4:
        // WHY: presentation anchors are never re-derived). The retired ADR-0013 blocked-hashes path used
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

        const details: EditDetails = {
          diff: undoDiff,
          firstChangedLine: restoredRange?.firstChangedLine ?? undoDiffResult.firstChangedLine,
          lastChangedLine: restoredRange?.lastChangedLine ?? undoDiffResult.lastChangedLine,
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
