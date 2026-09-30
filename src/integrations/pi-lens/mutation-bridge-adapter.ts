/**
 * Mutation-bridge adapter — the only place that knows the pi-lens mutation bridge exists.
 *
 * WHY a separate module: `src/mutated-files.ts` is domain-neutral and must not reference any
 * extension, while this module is the integration edge that turns mutated-file notifications into
 * `recordMutation` calls. Detection is structural (a global symbol key plus a version and shape
 * check), so nothing here imports pi-lens. When the bridge is absent, or the mode is `off`, every
 * notification is a no-op.
 *
 * Shape source (pi-lens 4.3.0): `clients/mutating-tool.ts:853-887` defines `BridgeMutationEntry`
 * (`filePath`, `kind`, `touchedLines?`, `editRanges?`, `consumer?`, plus `importsChanged?` /
 * `deferAutofix?` / `provenance?` that this adapter does not send), `clients/mutation-bridge.ts:72-80`
 * defines `MutationBridge` (`readonly version: 1`, `recordMutation(entry): boolean`), `:146-157`
 * defines the range validation mirrored below, and `:365-370` is the version-checked lookup.
 *
 * Silence is the contract: this observer runs inside core tool execution, so it never logs and
 * never throws — a broken bridge degrades to "no mutation mirrored", never to a failed edit or
 * write. Drops are counted instead, for tests only.
 */
import { isAbsolute } from "node:path";
import { addMutatedFileObserver, type MutatedFileNotification } from "../../mutated-files.js";
import type { ServedSpan } from "../../served-spans.js";
import { resolveEffectiveLensMode } from "./config.js";

const MUTATION_BRIDGE_KEY = "pi-lens:mutation-bridge";
const MUTATION_BRIDGE_VERSION = 1;
const CONSUMER = "pi-better-edit";

/** One line range as pi-lens validates it: both ends 1-indexed integers, `end >= start`. */
type BridgeRange = [number, number];

/** The bridge entry this adapter sends; ranges are omitted rather than sent empty. */
interface BridgeEntry {
  filePath: string;
  kind: "edit" | "write";
  touchedLines?: BridgeRange;
  editRanges?: BridgeRange[];
  consumer?: string;
}

/** Structural view of the bridge published by pi-lens; only these two members are ever read. */
interface MutationBridge {
  readonly version: number;
  recordMutation(entry: BridgeEntry): boolean;
}

/** SAFETY: resolved per call rather than captured at module load, so a bridge mounted after this
 * adapter is attached is still found, and a bridge swapped by another extension is honoured. */
function getBridge(): MutationBridge | undefined {
  // SAFETY: `globalThis` carries no symbol index signature in the TS lib, so one cast is what makes
  // SAFETY: the symbol-keyed lookup expressible at all; the value stays `unknown`, so the version
  // SAFETY: and method checks below are what prove the shape, and the mutation bridge is the only
  // SAFETY: thing published under this key.
  const maybe = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(MUTATION_BRIDGE_KEY)];
  if (typeof maybe !== "object" || maybe === null) return undefined;
  const bridge = maybe as Partial<MutationBridge>;
  if (bridge.version !== MUTATION_BRIDGE_VERSION || typeof bridge.recordMutation !== "function") {
    return undefined;
  }
  return bridge as MutationBridge;
}

let dropCount = 0;

/** Test helper: how many notifications this adapter dropped since the last reset. */
export function getMutationDropCountForTests(): number {
  return dropCount;
}

/** Test helper: reset the drop tally so counts cannot leak between tests. */
export function resetMutationDropCountForTests(): void {
  dropCount = 0;
}

/** SAFETY: pi-lens rejects a malformed range outright (`isValidRange`, mutation-bridge.ts:146-157),
 * so a span that cannot be expressed as one is dropped here rather than sent as a guess. */
function toBridgeRange(span: ServedSpan): BridgeRange | undefined {
  const { startLine, lineCount } = span;
  if (!Number.isInteger(startLine) || !Number.isInteger(lineCount)) return undefined;
  if (startLine < 1 || lineCount < 1) return undefined;
  return [startLine, startLine + lineCount - 1];
}

/**
 * Map one notification to a bridge entry, or `undefined` when it cannot be expressed truthfully.
 *
 * WHY the two shapes: pi-lens treats `kind: "write"` as whole-file authorship, so a write carries no
 * ranges; an `edit` whose `ranges` are empty means the whole file changed too, and pi-lens rejects
 * an empty `editRanges` array, so those keys are omitted rather than sent. `touchedLines` is the
 * bounding box of the ranges, which must arrive ascending (the seam's invariant).
 */
function toEntry(notification: MutatedFileNotification): BridgeEntry | undefined {
  if (!isAbsolute(notification.filePath)) return undefined;
  if (notification.kind === "write" || notification.ranges.length === 0) {
    return { filePath: notification.filePath, kind: notification.kind, consumer: CONSUMER };
  }

  const editRanges: BridgeRange[] = [];
  for (const span of notification.ranges) {
    const range = toBridgeRange(span);
    if (range === undefined) return undefined;
    editRanges.push(range);
  }

  const first = editRanges[0];
  const last = editRanges.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return {
    filePath: notification.filePath,
    kind: notification.kind,
    touchedLines: [first[0], last[1]],
    editRanges,
    consumer: CONSUMER,
  };
}

/**
 * Subscribe the mutation mirror and return the unsubscribe function.
 *
 * `getCwd` is injectable because the observer path has no command context: `process.cwd()` stands
 * in for the session cwd (pi launches in it), while the `/pi-better-edit` command resolves the
 * exact `ctx.cwd`. The mode is re-read per notification, so a mode change takes effect immediately.
 */
export function attachMutationBridgeAdapter(options?: { getCwd?: () => string }): () => void {
  const getCwd = options?.getCwd ?? ((): string => process.cwd());
  return addMutatedFileObserver((notification: MutatedFileNotification): void => {
    try {
      let cwd: string;
      try {
        cwd = getCwd();
      } catch {
        // SAFETY: an unusable cwd means the mode cannot be resolved, so nothing is mirrored.
        return;
      }
      if (resolveEffectiveLensMode(cwd) === "off") return;
      const bridge = getBridge();
      // WHY: `auto` treats an absent bridge as disabled and `on` cannot conjure one, so both modes
      // WHY: share this single no-op path — the mode gate above is the only difference between them.
      if (bridge === undefined) {
        dropCount += 1;
        return;
      }
      const entry = toEntry(notification);
      if (entry === undefined) {
        dropCount += 1;
        return;
      }
      try {
        if (!bridge.recordMutation(entry)) dropCount += 1;
      } catch {
        // SAFETY: advisory-only — a refused record must not propagate into the edit or write that
        // SAFETY: already landed, and the failure is the bridge's to report.
        dropCount += 1;
      }
    } catch {
      // SAFETY: advisory-only — this runs inside core tool execution, so no failure may propagate
      // SAFETY: into the edit or write that produced the mutation.
    }
  });
}
