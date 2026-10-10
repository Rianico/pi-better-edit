import { getPreviewInput, type RPreview, type RRState } from "./edit-render.js";

export const PREVIEW_DEBOUNCE_MS = 150;

export interface PreviewHost {
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  state: RRState;
  invalidate: () => void;
}

export type PreviewCompute = (args: unknown, cwd: string) => Promise<RPreview>;

// SAFETY: large-class — cohesive store owns DB and cache as single owner; split would scatter invariants.
export class DebouncedPreview {
  constructor(
    private readonly compute: PreviewCompute,
    private readonly debounceMs: number = PREVIEW_DEBOUNCE_MS,
    private readonly getSessionId?: () => string | undefined,
  ) {}

  renderCall(host: PreviewHost, args: unknown): void {
    const { state } = host;
    const previewInput = getPreviewInput(args);
    if (host.executionStarted || !host.argsComplete || !previewInput) {
      this.cancel(state);
      return;
    }
    const argsKey = JSON.stringify(previewInput);
    if (state.argsKey === argsKey) return;
    this.cancel(state);
    state.argsKey = argsKey;
    const previewGeneration = (state.previewGeneration ?? 0) + 1;
    state.previewGeneration = previewGeneration;
    // WHY: (#168-class) the compute's session is bound at arm time: if the serving session
    // WHY: changed before the timer fires, verifying these anchors against the new session
    // WHY: would mint a false E_UNKNOWN_ANCHOR, so the stale compute is dropped (cancelled)
    // WHY: and the next renderCall re-arms against the session that actually serves anchors.
    const armedSessionId = this.getSessionId?.();
    state.previewTimer = setTimeout(() => {
      delete state.previewTimer;
      if (this.getSessionId && this.getSessionId() !== armedSessionId) {
        this.cancel(state);
        host.invalidate();
        return;
      }
      this.compute(args, host.cwd)
        .then((preview) => {
          if (state.argsKey === argsKey && state.previewGeneration === previewGeneration) {
            state.preview = preview;
            host.invalidate();
          }
        })
        .catch((err: unknown) => {
          if (state.argsKey === argsKey && state.previewGeneration === previewGeneration) {
            state.preview = {
              error: err instanceof Error ? err.message : String(err),
            };
            host.invalidate();
          }
        });
    }, this.debounceMs);
  }

  cancel(state: RRState): void {
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      delete state.previewTimer;
    }
    delete state.argsKey;
    delete state.preview;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }

  clearResult(state: RRState): void {
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      delete state.previewTimer;
    }
    delete state.preview;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }
}
