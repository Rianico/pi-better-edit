import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_READ_WINDOWS, SERVED_MAX_LINES } from "./constants.js";
import { loadHashStore } from "./hash-store.js";
import { sessionFromContext } from "./served-session/index.js";
import { contentChecksum } from "./hashline/hasher.js";
import { abortIf, assertNever } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { prepareFile } from "./file-content/index.js";
import { DomainError } from "./domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "./served-spans.js";
import { fileSnap } from "./file-reader.js";
import { snapshotHashFor, upsertSnapshotFor } from "./snapshot-store";
// WHY: Facade re-export for callers still importing preview directly
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
}

// WHY: the builtin renderers read `file_path ?? path`; our payload is `file`, but a legacy
// WHY: `path` caller must still render, so the seam accepts either key.
type ReadRenderArgs = { file?: string; path?: string };

export function regRead(pi: ExtensionAPI): void {
  // WHY: pi falls back to the builtin `read` renderer by tool name, but that renderer reads
  // WHY: `file_path ?? path`. Our payload field is `file`, so re-map it for rendering only —
  // WHY: the call line and expanded output keep the filename, and `args` is never mutated.
  const builtinReadDef = createReadToolDefinition("");
  const builtinRenderCall = builtinReadDef.renderCall as any;
  const builtinRenderResult = builtinReadDef.renderResult as any;
  pi.registerTool({
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: readGuide(),
    // SAFETY: the builtin renderers are keyed on `file_path ?? path`; the spread re-maps our
    // SAFETY: `file` payload onto `path` for rendering without mutating the caller's `args`.
    renderCall: (args: ReadRenderArgs, theme, context) =>
      builtinRenderCall({ ...args, path: args?.file ?? args?.path }, theme, context),
    renderResult: (result, options, theme, context) => {
      // SAFETY: renderers receive raw call args, not the validated payload, so `context.args` may
      // SAFETY: carry a legacy `path` that `Static<TParams>` does not model; this cast reads only
      // SAFETY: `file`/`path`, both of which the renderers below already key on.
      const args = context.args as ReadRenderArgs;
      return builtinRenderResult(result, options, theme, {
        ...context,
        args: { ...args, path: args?.file ?? args?.path },
      });
    },
    parameters: Type.Object({
      file: Type.String({
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
            maxItems: MAX_READ_WINDOWS,
            description:
              "Optional array of disjoint line windows to read in a single turn; in the default `served` mode every window's rows are served, so anchors from all of them are usable in one edit",
          },
        ),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("served"), Type.Literal("verbatim")], {
          description:
            'Render mode: "served" (default) returns each line as a 3-char anchor plus content; "verbatim" returns plain text with no anchor prefix.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.file;
      const mode = params.mode ?? "served";
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
        // WHY (merge provisional, S3 open): the served cap stays `SERVED_MAX_LINES` (lane #20)
        // WHY: while verbatim skips the store (main #44) — the budget name/justification post-paging
        // WHY: is undecided; see the merge commit.
        maxLines: SERVED_MAX_LINES,
        store: mode === "served" ? await loadHashStore() : undefined,
        noPersist: true,
        render: mode,
      });

      if (prepared.kind === "image") {
        const builtinRead = createReadTool(ctx.cwd);
        // SAFETY: pi-coding-agent's createReadTool returns untyped execute; cast narrows to typed signature validated by runtime params. The builtin read names the file `path`, so forward our `file` under its name.
        const executeBuiltinRead = builtinRead.execute as unknown as (
          toolCallId: string,
          input: typeof params,
          abortSignal: typeof signal,
          onUpdate: typeof _onUpdate,
          context: typeof ctx,
        ) => ReturnType<typeof builtinRead.execute>;
        // WHY: an image has no line address space, so `windows` is meaningless here; the delegated
        // WHY: builtin read ignores fields it does not read and returns the image itself.
        // SAFETY: spread keeps offset/limit/windows; `path` fills the builtin's filename slot (ours is `file`). Cast through unknown: the shapes agree at runtime, only the key name differs.
        const builtinInput = { ...params, path: rawPath } as unknown as typeof params;
        return executeBuiltinRead(_toolCallId, builtinInput, signal, _onUpdate, ctx);
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

      switch (mode) {
        case "verbatim": {
          // WHY: a verbatim read shares admission/normalization but must not touch served state —
          // WHY: no lease, snapshot, epoch, drift clear, or span notification. Return before any of it.
          return {
            content: [{ type: "text", text: prepared.preview }],
            details: {
              truncation: prepared.truncation,
              ...(prepared.nextOffset !== undefined ? { nextOffset: prepared.nextOffset } : {}),
              metrics: {
                truncated: Boolean(prepared.truncation),
                ...(prepared.nextOffset !== undefined ? { next_offset: prepared.nextOffset } : {}),
              },
            },
          };
        }
        case "served":
          break;
        default:
          return assertNever(mode);
      }

      const session = sessionFromContext(
        ctx as { sessionManager?: { getSessionId(): string } },
        prepared.absolutePath,
      );
      // WHY: the read's count-only walk already counted the lines, so the epoch takes its count instead of
      // WHY: a second split of the normalized text; retiring leases is `upsertSnapshotFor`'s, below.
      const lineCount = prepared.lineTotals.visible;
      // WHY: `windows: []` falls back to a full read in the preview, so the full-read contract has to
      // WHY: follow the same rule — otherwise an empty array silently withholds the snapshot id and
      // WHY: skips the drift clear that a full read owes.
      const hasWindows = Array.isArray(params.windows) && params.windows.length > 0;
      const isFullRead =
        params.offset == null && params.limit == null && !hasWindows && !prepared.truncation;
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
            lineCount: prepared.lineTotals.split,
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
      // WHY: fire-and-forget by design — the seam snapshots its observers and isolates each one, so
      // WHY: this read's return value and timing are unchanged whether or not an observer is attached.
      notifyServedSpans({
        filePath: prepared.absolutePath,
        spans: servedRowsToSpans(prepared.served),
        source: "read",
      });
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
