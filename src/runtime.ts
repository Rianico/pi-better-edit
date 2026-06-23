export function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
