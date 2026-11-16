/**
 * Unified I/O bridge adapter — the only place that records to pi-lens v2.
 * WHY one module for both seams: a v2 `record` entry carries at most one facet of each kind, so the two
 * domain-neutral seams (`src/served-spans.ts`, `src/mutated-files.ts`) each map to single-facet calls,
 * and an edit-plus-preview pair travels as two back-to-back calls in producer order, never one compound.
 * Read evidence: verbatim `content` is recorded span by span, one single-range call each with its slice,
 * and a failed slice drops the span rather than sending it short; `content` is valid only for one
 * contiguous range. Without it, ONE call carries every range with `evidence: "disk"`; `lineHashes` are never sent.
 * Silence is the contract: these observers run inside core tool execution, so nothing here logs and
 * nothing throws — a broken bridge degrades to "no I/O mirrored", never a failed read, edit or write.
 * Drops are counted instead, for tests only; an explicit `off` mode is never a drop.
 */
import { isAbsolute } from "node:path";
import { addMutatedFileObserver, type MutatedFileNotification } from "../../mutated-files.js";
import { addServedSpanObserver, type ServedSpanNotification } from "../../served-spans.js";
import { resolveEffectiveLensMode } from "./config.js";
import {
  getIOBridge,
  IO_BRIDGE_CONSUMER,
  sliceSpanContent,
  type IOBridge,
  type IOBridgeMutate,
  type IOBridgeRange,
} from "./io-bridge.js";

let dropCount = 0;

/** Test helper: how many mirrors this adapter dropped since the last reset. */
export function getIODropCountForTests(): number {
  return dropCount;
}

/** Test helper: reset the drop tally so counts cannot leak between tests. */
export function resetIODropCountForTests(): void {
  dropCount = 0;
}

/**
 * SAFETY: pi-lens rejects a malformed range outright (`isValidRange`), so a span
 * that cannot be expressed as one is dropped here rather than sent as a guess.
 * The seams guarantee valid spans; this guard is defense in depth.
 */
function toBridgeRange(startLine: number, lineCount: number): IOBridgeRange | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(lineCount)) return undefined;
  if (startLine < 1 || lineCount < 1) return undefined;
  return [startLine, startLine + lineCount - 1];
}

/**
 * Map one mutation notification to its facet, or `undefined` when it cannot be
 * expressed truthfully. An empty range list means the whole file changed, which
 * v2 names `write`: `edit` requires a non-empty `ranges`.
 */
function toMutateFacet(notification: MutatedFileNotification): IOBridgeMutate | undefined {
  if (!isAbsolute(notification.filePath)) return undefined;
  if (notification.kind === "write" || notification.ranges.length === 0) {
    return { kind: "write" };
  }
  const ranges: IOBridgeRange[] = [];
  for (const span of notification.ranges) {
    const range = toBridgeRange(span.startLine, span.lineCount);
    if (range === undefined) return undefined;
    ranges.push(range);
  }
  return { kind: "edit", ranges };
}

/** Record one mutation notification; every failure path counts one drop. */
function recordMutated(bridge: IOBridge, notification: MutatedFileNotification): void {
  const mutate = toMutateFacet(notification);
  if (mutate === undefined) {
    dropCount += 1;
    return;
  }
  try {
    const result = bridge.record({
      filePath: notification.filePath,
      consumer: IO_BRIDGE_CONSUMER,
      mutate,
    });
    if (result?.mutate?.accepted !== true) dropCount += 1;
  } catch {
    dropCount += 1;
  }
}

/** Record the caller slice of one single-range span; a failed slice counts a drop. */
function recordSlicedSpan(
  bridge: IOBridge,
  filePath: string,
  startLine: number,
  lineCount: number,
  content: string,
): void {
  const range = toBridgeRange(startLine, lineCount);
  const slice = range === undefined ? undefined : sliceSpanContent(content, startLine, lineCount);
  if (range === undefined || slice === undefined) {
    dropCount += 1;
    return;
  }
  try {
    const result = bridge.record({
      filePath,
      consumer: IO_BRIDGE_CONSUMER,
      read: { ranges: [range], content: slice },
    });
    if (result?.read?.accepted !== true) dropCount += 1;
  } catch {
    dropCount += 1;
  }
}

/** Record every span of a text-less notification as ONE disk-evidence call. */
function recordDiskReads(
  bridge: IOBridge,
  filePath: string,
  notification: ServedSpanNotification,
): void {
  const ranges: IOBridgeRange[] = [];
  for (const span of notification.spans) {
    const range = toBridgeRange(span.startLine, span.lineCount);
    if (range === undefined) {
      dropCount += 1;
      return;
    }
    ranges.push(range);
  }
  try {
    const result = bridge.record({
      filePath,
      consumer: IO_BRIDGE_CONSUMER,
      read: { ranges, evidence: "disk" },
    });
    if (result?.read?.accepted !== true) dropCount += 1;
  } catch {
    dropCount += 1;
  }
}

/** Record one served-span notification: caller slices when present, else one disk batch. */
function recordServedSpans(bridge: IOBridge, notification: ServedSpanNotification): void {
  const content = notification.content;
  if (typeof content !== "string") {
    recordDiskReads(bridge, notification.filePath, notification);
    return;
  }
  for (const span of notification.spans) {
    recordSlicedSpan(bridge, notification.filePath, span.startLine, span.lineCount, content);
  }
}

/**
 * Subscribe both mirrors and return the combined unsubscribe function.
 *
 * `getCwd` is injectable because the observer path has no command context:
 * `process.cwd()` stands in for the session cwd (pi launches in it), while the
 * `/pi-better-edit` command resolves the exact `ctx.cwd`. The mode is re-read per
 * notification, so a mode change takes effect immediately. A cwd that cannot be
 * resolved mirrors nothing and counts no drop, like an explicit `off`.
 */
export function attachIOBridgeAdapter(options?: { getCwd?: () => string }): () => void {
  const getCwd = options?.getCwd ?? ((): string => process.cwd());
  const resolveMode = (): string | undefined => {
    try {
      return resolveEffectiveLensMode(getCwd());
    } catch {
      return undefined;
    }
  };
  const detachMutated = addMutatedFileObserver((notification: MutatedFileNotification): void => {
    try {
      const mode = resolveMode();
      if (mode === undefined || mode === "off") return;
      const bridge = getIOBridge();
      if (bridge === undefined) {
        dropCount += 1;
        return;
      }
      recordMutated(bridge, notification);
    } catch {}
  });
  const detachServed = addServedSpanObserver((notification: ServedSpanNotification): void => {
    try {
      if (notification.spans.length === 0 || !isAbsolute(notification.filePath)) return;
      const mode = resolveMode();
      if (mode === undefined || mode === "off") return;
      const bridge = getIOBridge();
      if (bridge === undefined) {
        dropCount += 1;
        return;
      }
      recordServedSpans(bridge, notification);
    } catch {}
  });
  return () => {
    detachMutated();
    detachServed();
  };
}
