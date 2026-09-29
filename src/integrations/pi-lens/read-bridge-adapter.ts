/**
 * Read-bridge adapter — the only place that knows the pi-lens read bridge exists.
 *
 * WHY a separate module: `src/served-spans.ts` is domain-neutral and must not reference any
 * extension, while this module is the integration edge that turns served spans into `recordRead`
 * calls. Detection is structural (a global symbol key plus a shape check), so nothing here imports
 * pi-lens. When the bridge is absent, or the mode is `off`, every notification is a no-op.
 *
 * Silence is the contract: this observer runs inside core tool execution, so it never logs and
 * never throws — a broken bridge degrades to "no mirroring", never to a failed read or edit.
 */
import { isAbsolute } from "node:path";
import { addServedSpanObserver, type ServedSpanNotification } from "../../served-spans.js";
import { resolveEffectiveLensMode } from "./config.js";

const READ_BRIDGE_KEY = "pi-lens:read-bridge";
const READ_BRIDGE_VERSION = 1;
const CONSUMER = "pi-better-edit";

/** Structural view of the bridge published by pi-lens; only these two members are ever read. */
interface ReadBridge {
  readonly version: number;
  recordRead(entry: {
    filePath: string;
    requestedOffset: number;
    requestedLimit?: number;
    consumer?: string;
  }): void;
}

/** SAFETY: resolved per call rather than captured at module load, so a bridge mounted after this
 * adapter is attached is still found, and a bridge swapped by another extension is honoured. */
function getBridge(): ReadBridge | undefined {
  // SAFETY: `globalThis` carries no symbol index signature in the TS lib, so one cast is what makes
  // SAFETY: the symbol-keyed lookup expressible at all; the value stays `unknown` so the shape check
  // SAFETY: below is what proves it, and the read bridge is the only thing published under this key.
  const maybe = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(READ_BRIDGE_KEY)];
  if (typeof maybe !== "object" || maybe === null) return undefined;
  const bridge = maybe as Partial<ReadBridge>;
  if (bridge.version !== READ_BRIDGE_VERSION || typeof bridge.recordRead !== "function") {
    return undefined;
  }
  return bridge as ReadBridge;
}

/**
 * Subscribe the bridge mirror and return the unsubscribe function.
 *
 * `getCwd` is injectable because the observer path has no command context: `process.cwd()` stands
 * in for the session cwd (pi launches in it), while the `/pi-better-edit` command resolves the
 * exact `ctx.cwd`. The mode is re-read per notification, so a mode change takes effect immediately.
 */
export function attachReadBridgeAdapter(options?: { getCwd?: () => string }): () => void {
  const getCwd = options?.getCwd ?? ((): string => process.cwd());
  return addServedSpanObserver((notification: ServedSpanNotification): void => {
    try {
      if (notification.spans.length === 0 || !isAbsolute(notification.filePath)) return;
      let cwd: string;
      try {
        cwd = getCwd();
      } catch {
        // SAFETY: an unusable cwd means the mode cannot be resolved, so nothing is mirrored.
        return;
      }
      const mode = resolveEffectiveLensMode(cwd);
      if (mode === "off") return;
      const bridge = getBridge();
      // WHY: `auto` treats an absent bridge as disabled and `on` cannot conjure one, so both modes
      // WHY: share this single no-op path — the mode gate above is the only difference between them.
      if (bridge === undefined) return;
      for (const span of notification.spans) {
        try {
          bridge.recordRead({
            filePath: notification.filePath,
            requestedOffset: span.startLine,
            requestedLimit: span.lineCount,
            consumer: CONSUMER,
          });
        } catch {
          // SAFETY: advisory-only — one rejected span must not stop the remaining spans of the same
          // SAFETY: notification, and the failure is the bridge's to report.
        }
      }
    } catch {
      // SAFETY: advisory-only — this runs inside core tool execution, so no failure may propagate
      // SAFETY: into the read or edit that served the rows.
    }
  });
}
