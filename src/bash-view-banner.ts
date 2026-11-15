export const BASH_SEARCH_ROOT = "[Bash search (anchors)]";
export const BASH_FILE_LIST_ROOT = "[Bash file list (no anchors)]";

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
