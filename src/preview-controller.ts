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

export class DebouncedPreview {
  readonly #armed = new Set<RRState>();

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
    const armedSessionId = this.getSessionId?.();
    this.#armed.add(state);
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
        })
        .finally(() => {
          if (state.previewGeneration === previewGeneration) this.#armed.delete(state);
        });
    }, this.debounceMs);
  }

  cancel(state: RRState): void {
    this.#armed.delete(state);
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      delete state.previewTimer;
    }
    delete state.argsKey;
    delete state.preview;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }

  clearResult(state: RRState): void {
    this.#armed.delete(state);
    if (state.previewTimer) {
      clearTimeout(state.previewTimer);
      delete state.previewTimer;
    }
    delete state.preview;
    state.previewGeneration = (state.previewGeneration ?? 0) + 1;
  }

  /**
   * Cancels every armed entry: a pending debounce timer never fires, and a compute already running
   * is generation-guarded, so it can never publish its result after the cancel. An entry stays
   * armed from arm time until its compute settles, which is how a cancel reaches an in-flight one.
   */
  cancelArmed(): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- cancel mutates the set, so the walk reads a snapshot
    for (const state of [...this.#armed]) this.cancel(state);
  }
}
