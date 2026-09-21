import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { createSessionHandle, recordServes } from "../../src/served-session";
import { canonDigest, initHasher, lineHashes } from "../../src/hashline";
import { snapshotHashFor } from "../../src/snapshot-store";
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

describe("serve recording — one shared writer for the mirror and the lease grant (#103, #151)", () => {
  const session = readFileSync(SESSION_MODULE, "utf-8");

  it("makes both serve paths delegate to a single shared writer", () => {
    const plain = functionBody(session, "recordServesInner");
    const truncated = functionBody(session, "recordServesTruncatedInner");
    const shared = calledHelpers(plain).filter((name) => calledHelpers(truncated).includes(name));
    expect(shared).toHaveLength(1);
    const writer = shared[0]!;

    // the writer is defined once and owns the whole write: mirror row + lease grant. Canon evidence
    // needs no step here at all (#151): it is derived from the leases this writer grants.
    expect(session.match(new RegExp(`function ${writer}\\(`, "g"))).toHaveLength(1);
    const writerBody = functionBody(session, writer);
    expect(writerBody).toContain("withStore(");
    expect(writerBody).toContain("patchServed(");
    expect(writerBody).toContain("grantLeasesForRows(");
    expect(writerBody).not.toContain("canon");

    // neither serve path keeps its own copy of those steps
    for (const body of [plain, truncated]) {
      expect(body).not.toContain("withStore");
      expect(body).not.toContain("displacedHashes");
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
  it("derives canon evidence from the leases a serve grants, never from a stored canon", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const path = "/serve-seam.ts";
      const lines = ["alpha", "beta", "gamma"];
      const content = `${lines.join("\n")}\n`;
      const hashes = await lineHashes(content, path);
      const rows = hashes.map((hash, position) => ({ position, hash }));

      // A mirror-only serve grants no lease, so no canon evidence exists anywhere. There is nothing
      // to read back a canon text from: `served.canons` is written by no v7 code path (#151).
      recordServes(store, "mirror-only", path, rows);
      expect(await createSessionHandle("mirror-only", path, store).loadCanonDigests()).toEqual([]);

      // A serve that names its content hash grants the leases the evidence is derived from.
      const handle = createSessionHandle("leased", path, store);
      await handle.recordDiff(rows, { contentHash: snapshotHashFor(content) });
      await handle.recordDiff(rows, { contentHash: snapshotHashFor(content) });
      expect(await handle.loadCanonDigests()).toEqual(lines.map((line) => canonDigest(line)));
    });
  });
});
