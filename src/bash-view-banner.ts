/**
 * WHY: one definition site for the bash seams' bracket roots (#150, read-chrome): `view`, `search`,
 * WHY: `file list` and `auto-read` each carry a kind word — the kind word IS the completeness claim —
 * WHY: and that literal used to be copied at seven call sites in `src/lifecycle-hooks/index.ts`. Every
 * WHY: site names its kind here instead, so the text below is the single definition site spec §3.4
 * WHY: names. The `---` banner is gone: a page's chrome is its header, and only these two roots
 * WHY: (a search's match list, a path list) have no page to name.
 */
export const BASH_SEARCH_ROOT = "[Bash search (anchors)]";
export const BASH_FILE_LIST_ROOT = "[Bash file list (no anchors)]";

/**
 * WHY: `view` and `auto-read` merged into their page headers (`[Bash view: f (40 lines total)]`), so
 * WHY: their frozen text is the label, not a line of its own — the completeness claim moves into the
 * WHY: header's bracket and a page can no longer carry two of them.
 */
export const BASH_VIEW_LABEL = "Bash view";
export const BASH_AUTO_READ_LABEL = "Auto-read";

export type BashBannerKind = "search" | "file-list";

/** The bracket root that introduces a result with no page header of its own. */
export function bashBanner(kind: BashBannerKind): string {
  switch (kind) {
    case "search":
      return BASH_SEARCH_ROOT;
    case "file-list":
      return BASH_FILE_LIST_ROOT;
  }
}
