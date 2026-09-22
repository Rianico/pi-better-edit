import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_HASH_LINES } from "./hashline/index.js";
import { loadHashStore } from "./hash-store.js";
import { sessionFromContext } from "./served-session/index.js";
import { contentChecksum } from "./hashline/hasher.js";
import { abortIf, isRec, normalizeFilePath } from "./utils.js";
import { splitLines, visLines } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { prepareFile } from "./file-content/index.js";
import { DomainError } from "./domain-errors.js";
import { fileSnap } from "./file-reader.js";
import { snapshotHashFor, upsertSnapshotFor } from "./snapshot-store";
// WHY: Facade re-export for callers still importing preview directly
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
}

export function regRead(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: readGuide(),
    prepareArguments: (args: unknown) => {
      if (!isRec(args)) return args as never;
      const record = { ...args } as Record<string, unknown>;
      normalizeFilePath(record);
      return record as never;
    },
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to read (relative or absolute)",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Line number to start reading from (1-indexed)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      ),
      windows: Type.Optional(
        Type.Array(
          Type.Object({
            offset: Type.Integer({
              minimum: 1,
              description: "Line number to start reading from (1-indexed)",
            }),
            limit: Type.Integer({
              minimum: 1,
              description: "Maximum number of lines to read",
            }),
          }),
          {
            description:
              "Optional array of disjoint line windows to read in a single turn; every window's rows are served, so anchors from all of them are usable in one edit",
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path;
      abortIf(signal);
      // WHY: Deep seam: one call handles kind detection, decode, normalize, hash, preview.
      // WHY: `noPersist` defers the authoritative materialization until the served window is
      // WHY: known, so the snapshot + lineage + retirement + lease grant below commit as the ONE
      // WHY: transaction spec §3.1.2 mandates instead of materializing first and leasing a
      // WHY: transaction later.
      const prepared = await prepareFile(rawPath, ctx.cwd, {
        signal,
        offset: params.offset,
        limit: params.limit,
        windows: params.windows,
        maxLines: MAX_HASH_LINES,
        store: await loadHashStore(),
        noPersist: true,
      });

      if (prepared.kind === "image") {
        const builtinRead = createReadTool(ctx.cwd);
        // SAFETY: pi-coding-agent's createReadTool returns untyped execute; cast narrows to typed signature validated by runtime params and is only used to delegate with same args.
        const executeBuiltinRead = builtinRead.execute as unknown as (
          toolCallId: string,
          input: typeof params,
          abortSignal: typeof signal,
          onUpdate: typeof _onUpdate,
          context: typeof ctx,
        ) => ReturnType<typeof builtinRead.execute>;
        // WHY: an image has no line address space, so `windows` is meaningless here; the delegated
        // WHY: builtin read ignores fields it does not read and returns the image itself.
        return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
      }
      if (prepared.kind !== "text") {
        if (prepared.kind === "directory") {
          throw new DomainError("E_UNSUPPORTED_FILE", { path: rawPath, kind: "directory" });
        }
        if (prepared.kind === "binary") {
          throw new DomainError("E_UNSUPPORTED_FILE", {
            path: rawPath,
            kind: "binary",
            description: prepared.description,
          });
        }
        throw new DomainError("E_UNSUPPORTED_FILE", { path: rawPath, kind: "image" });
      }

      const session = sessionFromContext(
        ctx as { sessionManager?: { getSessionId(): string } },
        prepared.absolutePath,
      );
      const lineCount = visLines(prepared.normalized).length;
      const isFullRead =
        params.offset == null &&
        params.limit == null &&
        params.windows === undefined &&
        !prepared.truncation;
      let snapshotId: string | undefined;
      const contentHash = snapshotHashFor(prepared.normalized);
      try {
        snapshotId = (
          await fileSnap(
            prepared.absolutePath,
            contentChecksum(prepared.normalized),
            prepared.stats,
          )
        ).snapshotId;
      } catch {
        snapshotId = undefined;
      }
      // WHY: the read-path materialization (spec §3.1.2 steps 4-6): snapshot + lineage +
      // WHY: retirement + the served window's leases share one `BEGIN IMMEDIATE`. Best-effort —
      // WHY: a store failure never fails the read; the next call re-materializes from disk.
      try {
        await upsertSnapshotFor(
          {
            path: prepared.absolutePath,
            snapshotHash: contentHash,
            lineCount: splitLines(prepared.normalized).length,
            hashes: prepared.fileHashes,
            content: prepared.normalized,
          },
          {
            retireLeases: true,
            leases: { sessionKey: session.sessionKey, rows: prepared.served },
          },
        );
      } catch (error) {
        // SAFETY: best-effort post-read materialization — the preview rows are already computed
        // SAFETY: and the served mirror below still records them; a missed snapshot/lease degrades
        // SAFETY: to the fail-closed path the next edit would take anyway.
        console.error("Failed to commit read-path snapshot materialization:", error);
      }
      // WHY: mirror-only — the leases already committed in the transaction above, so no
      // WHY: `contentHash` is passed and no third transaction remains on the read path. Canon
      // WHY: evidence needs no write at all: it is derived from those leases (#151).
      await session.recordEpoch({
        rows: prepared.served,
        lineCount,
        fullReadHashes: prepared.fileHashes,
        snapshotId: isFullRead ? snapshotId : undefined,
        isFullRead,
      });
      if (isFullRead) await session.clearDrift();
      return {
        content: [{ type: "text", text: prepared.preview }],
        details: {
          truncation: prepared.truncation,
          snapshotId,
          ...(prepared.nextOffset !== undefined ? { nextOffset: prepared.nextOffset } : {}),
          metrics: {
            truncated: Boolean(prepared.truncation),
            ...(prepared.nextOffset !== undefined ? { next_offset: prepared.nextOffset } : {}),
          },
        },
      };
    },
  });
}
