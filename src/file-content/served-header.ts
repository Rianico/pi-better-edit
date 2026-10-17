/**
 * WHY: one shared ranged-header builder (#149): the served read (`src/read.ts`) and the bash view
 * WHY: (`src/lifecycle-hooks/index.ts`) named the same windowed page two ways. Both call this, so
 * WHY: the dialects cannot drift again. Whole-file and multi-window headers live with their callers
 * WHY: (each keeps its own long-standing shape); only the ranged form is shared.
 */
export function formatRangedServedHeader(
  file: string,
  startLine: number,
  endLine: number,
  totalLines: number,
): string {
  return `[${file} (lines ${startLine}-${endLine} of ${totalLines})]`;
}
