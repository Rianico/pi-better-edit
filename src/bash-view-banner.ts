/**
 * WHY: one banner builder for the bash seams (#150): the view, search, file-list, and auto-read
 * WHY: banners each carry a frozen kind word (the kind word is the completeness claim), and that
 * WHY: literal used to be copied at seven call sites in `src/lifecycle-hooks/index.ts` — a frozen
 * WHY: string copied five times is unenforceable. Every site calls `bashBanner(kind)` instead, so
 * WHY: the text below is the single definition site named by spec §3.4. The text must not change.
 */
export const BASH_VIEW_BANNER = "--- Bash view (hashline anchors) ---";
export const BASH_SEARCH_BANNER = "--- Bash search (hashline anchors) ---";
export const BASH_FILE_LIST_BANNER = "--- Bash file list (no anchors) ---";
export const BASH_AUTO_READ_BANNER = "--- Auto-read (hashline anchors) ---";

export type BashBannerKind = "view" | "search" | "file-list" | "auto-read";

/**
 * WHY: the kind word carries the completeness claim (owner decision, #150): `view` and `search`
 * WHY: promise served hashline anchors, `file list` promises none, `auto-read` marks the write
 * WHY: pipeline's own read. Collapsing the kinds is out; this maps each kind to its frozen text.
 */
export function bashBanner(kind: BashBannerKind): string {
  switch (kind) {
    case "view":
      return BASH_VIEW_BANNER;
    case "search":
      return BASH_SEARCH_BANNER;
    case "file-list":
      return BASH_FILE_LIST_BANNER;
    case "auto-read":
      return BASH_AUTO_READ_BANNER;
  }
}
