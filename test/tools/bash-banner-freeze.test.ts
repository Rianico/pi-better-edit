import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASH_AUTO_READ_LABEL,
  BASH_FILE_LIST_ROOT,
  BASH_SEARCH_ROOT,
  BASH_VIEW_LABEL,
  bashBanner,
} from "../../src/bash-view-banner.js";

// WHY: the bash seams' bracket roots and page labels are frozen text (#150, read-chrome): the kind
// WHY: word carries the completeness claim, so the suite pins each literal byte-identically and guards
// WHY: that every call site imports the builder instead of re-declaring the text. An edited literal
// WHY: here means the contract moved.
describe("bash banner freeze (#150)", () => {
  it("pins the frozen root and label literals byte-identically", () => {
    expect(BASH_SEARCH_ROOT).toBe("[Bash search (anchors)]");
    expect(BASH_FILE_LIST_ROOT).toBe("[Bash file list (no anchors)]");
    expect(BASH_VIEW_LABEL).toBe("Bash view");
    expect(BASH_AUTO_READ_LABEL).toBe("Auto-read");
  });

  it("routes every root through its frozen literal", () => {
    expect(bashBanner("search")).toBe(BASH_SEARCH_ROOT);
    expect(bashBanner("file-list")).toBe(BASH_FILE_LIST_ROOT);
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
    // WHY: only the bracketed forms are frozen chrome — the bare labels are ordinary prose words
    // WHY: (`Bash view setting` names a config key), so the pin guards how they are assembled.
    const literals = [
      BASH_SEARCH_ROOT,
      BASH_FILE_LIST_ROOT,
      `[${BASH_VIEW_LABEL}: `,
      `[${BASH_AUTO_READ_LABEL}: `,
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
