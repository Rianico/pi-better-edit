import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASH_AUTO_READ_BANNER,
  BASH_FILE_LIST_BANNER,
  BASH_SEARCH_BANNER,
  BASH_VIEW_BANNER,
  bashBanner,
} from "../../src/bash-view-banner.js";

// WHY: the four bash banners are frozen text (#150): the kind word carries the completeness claim,
// WHY: so the suite pins each literal byte-identically and guards that the seven call sites import
// WHY: the builder instead of re-declaring the text. An edited literal here means the contract moved.
describe("bash banner freeze (#150)", () => {
  it("pins the four banner literals byte-identically", () => {
    expect(BASH_VIEW_BANNER).toBe("--- Bash view (hashline anchors) ---");
    expect(BASH_SEARCH_BANNER).toBe("--- Bash search (hashline anchors) ---");
    expect(BASH_FILE_LIST_BANNER).toBe("--- Bash file list (no anchors) ---");
    expect(BASH_AUTO_READ_BANNER).toBe("--- Auto-read (hashline anchors) ---");
  });

  it("routes every kind through its frozen literal", () => {
    expect(bashBanner("view")).toBe(BASH_VIEW_BANNER);
    expect(bashBanner("search")).toBe(BASH_SEARCH_BANNER);
    expect(bashBanner("file-list")).toBe(BASH_FILE_LIST_BANNER);
    expect(bashBanner("auto-read")).toBe(BASH_AUTO_READ_BANNER);
  });

  it("declares no banner literal outside the single definition site", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/lifecycle-hooks/index.ts", import.meta.url)),
      "utf8",
    );
    for (const literal of [
      BASH_VIEW_BANNER,
      BASH_SEARCH_BANNER,
      BASH_FILE_LIST_BANNER,
      BASH_AUTO_READ_BANNER,
    ]) {
      expect(source).not.toContain(literal);
    }
  });
});
