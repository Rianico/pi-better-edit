import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/**
 * Enter pi's per-path mutation queues for SEVERAL paths in one deterministic, sorted nesting.
 *
 * WHY: `withFileMutationQueue` serializes per path; a multi-path holder that acquired {A, B} and
 * another that acquired {B, A} in submission order would deadlock. Sorting the set (and deduping
 * it) makes the acquisition order a function of the paths alone — every holder waits in the same
 * order. Used by the foreign-cut transaction (pipeline), its correlated undo (edit-undo), and
 * next-run repair (cut-repair).
 */
export async function withSortedMutationQueues<T>(
  paths: string[],
  run: () => Promise<T>,
): Promise<T> {
  const uniq = [...new Set(paths)].sort();
  const nest = (index: number): Promise<T> =>
    index === uniq.length ? run() : withFileMutationQueue(uniq[index]!, () => nest(index + 1));
  return nest(0);
}
