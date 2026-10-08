/**
 * Unified pi-lens File I/O Lifecycle Bridge v2 — the only place that knows the
 * `pi-lens:io-bridge` mount exists.
 *
 * WHY a separate module: the observer seams (`src/served-spans.ts`,
 * `src/mutated-files.ts`) are domain-neutral and must not reference any
 * extension, while this module is the integration edge that turns served and
 * mutated notifications into `record` calls. Detection is structural (a global
 * symbol key plus a version and shape check), so nothing here imports pi-lens.
 * When the bridge is absent, or the mode is `off`, every notification is a
 * no-op.
 *
 * The structural copies below are the v2-native subset this integration sends —
 * no `v1-compat` fields, which exist only for the frozen v1 shims. The pi-lens
 * contract file (`clients/io-bridge-contract.ts`) is authoritative when this
 * module and the migration guide disagree.
 *
 * Silence is the contract: the observers run inside core tool execution, so
 * nothing here logs and nothing throws — a broken bridge degrades to "no I/O
 * mirrored", never to a failed read, edit or write.
 */

/** Stable symbol key — identical across module reloads in one process. */
export const IO_BRIDGE_KEY = "pi-lens:io-bridge";

/** Bridge API version this integration speaks. A mismatch means unsupported. */
export const IO_BRIDGE_VERSION = 2;

/** Caller identity for logging and telemetry on the pi-lens side. */
export const IO_BRIDGE_CONSUMER = "pi-better-edit";

/** One 1-indexed closed line interval: `[start, end]` with `end >= start`. */
export type IOBridgeRange = [start: number, end: number];

/** Read facet this integration sends: caller evidence, never `disk` by default. */
export interface IOBridgeRead {
  ranges: IOBridgeRange[];
  content?: string;
  evidence?: "caller" | "disk";
}

/** Mutation facet this integration sends. `delete` has no producer here. */
export type IOBridgeMutate = { kind: "edit"; ranges: IOBridgeRange[] } | { kind: "write" };

/** One `record` entry: at most one facet of each kind. */
export interface IOBridgeEntry {
  filePath: string;
  consumer?: string;
  mutate?: IOBridgeMutate;
  read?: IOBridgeRead;
}

/** One facet outcome. `record` never throws; refusals arrive as outcomes. */
export type IOBridgeOutcome = { accepted: true } | { accepted: false; reason: string };

/** Per-facet outcomes of one `record` call. */
export interface IOBridgeResult {
  read?: IOBridgeOutcome;
  mutate?: IOBridgeOutcome;
}

/** Structural view of the bridge published by pi-lens; only `record` is read. */
export interface IOBridge {
  readonly version: number;
  record(entry: IOBridgeEntry): IOBridgeResult;
}

/**
 * SAFETY: resolved per call rather than captured at module load, so a bridge
 * mounted after the adapter is attached is still found, and a bridge swapped
 * by another extension is honoured. A version mismatch means "unsupported",
 * never "reset": the caller simply records nothing.
 */
export function getIOBridge(): IOBridge | undefined {
  // SAFETY: `globalThis` carries no symbol index signature in the TS lib, so
  // SAFETY: one cast is what makes the symbol-keyed lookup expressible at all;
  // SAFETY: the value stays `unknown`, so the version and method checks below
  // SAFETY: are what prove the shape, and the I/O bridge is the only thing
  // SAFETY: published under this key.
  const maybe = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(IO_BRIDGE_KEY)];
  if (typeof maybe !== "object" || maybe === null) return undefined;
  const bridge = maybe as Partial<IOBridge>;
  if (bridge.version !== IO_BRIDGE_VERSION || typeof bridge.record !== "function") {
    return undefined;
  }
  return bridge as IOBridge;
}

/**
 * Slice the verbatim span lines out of raw file text.
 *
 * WHY a slice, not the whole text: `content` is span-relative and valid only for
 * a single contiguous range, so each span of a multi-span notification travels
 * in its own single-range `record` call. The split is CRLF-tolerant (`/\r?\n/`),
 * and the terminal newline's empty entry is a sentinel rather than a line, so the
 * returned text splits back into exactly the span's lines when the bridge hashes
 * it. Returns `undefined` when the text is shorter than the span claims — the
 * caller then drops the span rather than sending a short slice as the whole span.
 */
export function sliceSpanContent(
  content: string,
  startLine: number,
  lineCount: number,
): string | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(lineCount)) return undefined;
  const start = startLine - 1;
  if (start < 0 || lineCount < 1) return undefined;
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n")) lines.pop();
  if (start + lineCount > lines.length) return undefined;
  return lines.slice(start, start + lineCount).join("\n");
}
