import { readdirSync, readFileSync } from "node:fs";
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
    // WHY: the pin's name promises every module, so the scan walks every `.ts` file under `src/`
    // WHY: except the definition site itself — a future copy-paste in any new seam fails here.
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    const literals = [
      BASH_VIEW_BANNER,
      BASH_SEARCH_BANNER,
      BASH_FILE_LIST_BANNER,
      BASH_AUTO_READ_BANNER,
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file.endsWith("/bash-view-banner.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const literal of literals) {
        expect(source).not.toContain(literal);
      }
    }
  });
});
