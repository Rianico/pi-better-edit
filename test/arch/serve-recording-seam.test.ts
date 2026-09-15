import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { createSessionHandle, recordServes, recordServesTruncated } from "../../src/served-session";
import { initHasher, lineHashes } from "../../src/hashline";
import { getWritableTempRoot } from "../support/fixtures";

const SESSION_MODULE = "src/served-session/session.ts";

beforeAll(async () => {
  await initHasher();
});

/**
 * Body of a top-level `function <name>(...)` declaration, brace-matched from its opening `{`.
 * WHY: "this write exists exactly once" is a structural promise no runtime call can observe, so
 * WHY: the guard reads the module text.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in module`);
  // WHY: an inline object type in the parameter list carries `{` before the real body brace.
  let parens = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === "(") parens += 1;
    else if (source[cursor] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const open = source.indexOf("{", cursor);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

const STATEMENT_KEYWORDS = new Set(["if", "for", "while", "return", "switch", "catch", "await"]);

/** Distinct call names that begin a statement in `body` — the module-private helpers it leans on. */
function calledHelpers(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = match[1]!;
    if (!STATEMENT_KEYWORDS.has(name)) names.add(name);
  }
  return [...names];
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(await getWritableTempRoot(), "serve-seam-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  try {
    await run();
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

describe("serve recording — one shared writer for the mirror, canon sync and lease grant (#103)", () => {
  const session = readFileSync(SESSION_MODULE, "utf-8");

  it("makes both serve paths delegate to a single shared writer", () => {
    const plain = functionBody(session, "recordServesInner");
    const truncated = functionBody(session, "recordServesTruncatedInner");
    const shared = calledHelpers(plain).filter((name) => calledHelpers(truncated).includes(name));
    expect(shared).toHaveLength(1);
    const writer = shared[0]!;

    // the writer is defined once and owns the whole write: mirror row, canon sync, lease grant
    expect(session.match(new RegExp(`function ${writer}\\(`, "g"))).toHaveLength(1);
    const writerBody = functionBody(session, writer);
    expect(writerBody).toContain("withStore(");
    expect(writerBody).toContain("patchServed(");
    expect(writerBody).toContain("servedCanonsUpsert(");
    expect(writerBody).toContain("grantLeasesForRows(");

    // neither serve path keeps its own copy of those steps
    for (const body of [plain, truncated]) {
      expect(body).not.toContain("withStore");
      expect(body).not.toContain("displacedHashes");
      expect(body).not.toContain("servedCanonsUpsert");
      expect(body).not.toContain("grantLeasesForRows");
    }
  });

  it("keeps the truncation shaping as the only serve-path difference", () => {
    const plain = functionBody(session, "recordServesInner");
    const truncated = functionBody(session, "recordServesTruncatedInner");
    expect(plain).not.toContain("lineCount");
    expect(truncated).toContain("lineCount");
    expect(truncated).toContain("clearFrom");
  });

  it("syncs canon rows from served hashes on both the plain and the truncated path", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const path = "/serve-seam.ts";
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
      const rows = hashes.map((hash, position) => ({ position, hash }));

      recordServes(store, "plain", path, rows);
      recordServesTruncated(store, "truncated", path, rows, rows.length, 0);

      expect(await createSessionHandle("plain", path, store).loadCanons()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
      expect(await createSessionHandle("truncated", path, store).loadCanons()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    });
  });
});
