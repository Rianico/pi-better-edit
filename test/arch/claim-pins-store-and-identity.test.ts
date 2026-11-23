/**
 * M2 claim pins — store, identity, and the read-path budgets. Each test name carries its
 * inventory id (`M2#1` … `M2#16`), so the claim→test mapping is the `it` name itself.
 *
 * Tranche M2 deleted 16 load-bearing claims from `src/` because a comment was no longer a home
 * for them (`.lane/staging/m2/inventory.md`, items 1-16). This file is the executable home for
 * the store, anchor-identity and served/session items; the M3 set lives in its own file.
 *
 * The rule every assertion obeys: it FAILS if the property breaks — no `toBeDefined()` or
 * `not.toThrow()` shapes — and each pin names the number it holds (a counter, a chunk budget,
 * a query-plan line, a span, an index) rather than re-describing the code path.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ORPHAN_LINEAGE_SQL,
  RESOLVABLE_LEASE_SQL,
  loadHashStore,
  type HashStore,
} from "../../src/hash-store";
import { ALPHA } from "../../src/hashline/alphabet";
import { applyEdit } from "../../src/hashline/apply";
import {
  defaultHashIdentity,
  contentOnlyHashes,
  HASH_SPACE,
} from "../../src/hashline/hash-identity.js";
import { initHasher, xxh32 } from "../../src/hashline/hasher";
import { findStablePinBackbone } from "../../src/hashline/patience-pairing";
import { resEdit, type HEdit } from "../../src/hashline/resolve";
import {
  adoptPinnedSnapshotFor,
  pruneMissing,
  snapshotHashFor,
  snapshotIOFor,
  upsertSnapshot,
  upsertSnapshotFor,
  vacuumSnapshots,
} from "../../src/snapshot-store";
import { grantLeasesInTransaction } from "../../src/served-session/session";
import { lineSpanForOffsets } from "../../src/read-expansion/line-arithmetic";
import { findMarkdownSection } from "../../src/read-expansion/markdown-section";
import { splitLines } from "../../src/utils";

beforeAll(async () => {
  await initHasher();
});

function descriptorFor(path: string, content: string) {
  return {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes: contentOnlyHashes(content),
    content,
  };
}

/** Commits (or re-adopts) `content` for `path` — the second call is the cache hit a revert takes. */
function materialize(store: HashStore, path: string, content: string): void {
  upsertSnapshot(store, descriptorFor(path, content));
}

function counterOf(store: HashStore, path: string): number | undefined {
  const row = store.db.prepare("SELECT next_id FROM line_id_counters WHERE path = ?").get(path) as
    | { next_id: number }
    | undefined;
  return row?.next_id;
}

function countRows(store: HashStore, sql: string, ...params: (string | number)[]): number {
  const row = store.db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function snapshotIdsOf(store: HashStore, path: string): number[] {
  const rows = store.db
    .prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ? ORDER BY created_at ASC")
    .all(path) as unknown as { snapshot_id: number }[];
  return rows.map((row) => row.snapshot_id);
}

function leaseRowsOf(
  store: HashStore,
  sessionKey: string,
): { anchor: string; line_id: number; served_snapshot_hash: string; retired_at: number | null }[] {
  return store.db
    .prepare(
      "SELECT anchor, line_id, served_snapshot_hash, retired_at FROM served_leases " +
        "WHERE session_id = ? ORDER BY served_line_number ASC",
    )
    .all(sessionKey) as unknown as {
    anchor: string;
    line_id: number;
    served_snapshot_hash: string;
    retired_at: number | null;
  }[];
}

function mirrorRowCount(store: HashStore, path: string): number {
  return countRows(
    store,
    "SELECT COUNT(*) AS n FROM served_session_meta WHERE file_path = ? AND hashes IS NOT NULL",
    path,
  );
}

describe("M2 claim pins — snapshot store", () => {
  it("M2#1: adoption of a committed row allocates ZERO line_id counter ids", async () => {
    const store = await loadHashStore();
    const path = "/claim-pins/m2-1.ts";
    materialize(store, path, "first\nsecond\nthird\n");
    expect(counterOf(store, path)).toBe(4);

    materialize(store, path, "first\nsecond\nthird\n");
    materialize(store, path, "first\nsecond\nthird\n");
    expect(counterOf(store, path)).toBe(4);
  });

  it("M2#2: a failing mirror step rolls the lease grant back with it", async () => {
    const store = await loadHashStore();
    const content = "alpha\nbeta\n";
    const rows = contentOnlyHashes(content).map((hash, position) => ({ position, hash }));

    await adoptPinnedSnapshotFor(descriptorFor("/claim-pins/m2-2-control.ts", content), {
      leases: { sessionKey: "m2-2-control", rows },
      servedMirror: { sessionKey: "m2-2-control", rows },
    });
    expect(leaseRowsOf(store, "m2-2-control").map((lease) => lease.anchor)).toEqual(
      rows.map((row) => row.hash),
    );
    expect(mirrorRowCount(store, "/claim-pins/m2-2-control.ts")).toBe(1);

    const broken = "/claim-pins/m2-2-broken.ts";
    await expect(
      adoptPinnedSnapshotFor(descriptorFor(broken, content), {
        leases: { sessionKey: "m2-2-broken", rows },
        servedMirror: {
          sessionKey: "m2-2-broken",
          rows: [...rows, { position: rows.length, hash: "zz" }],
        },
      }),
    ).rejects.toThrow(/Invalid served hash/);

    expect(leaseRowsOf(store, "m2-2-broken")).toEqual([]);
    expect(mirrorRowCount(store, broken)).toBe(0);
    expect(
      countRows(store, "SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", broken),
    ).toBe(0);
  });

  it("M2#3: pruning purges lineage by hand, so no FK pragma is needed to avoid orphans", async () => {
    const store = await loadHashStore();
    const missing = "/claim-pins/m2-3-never-existed.ts";
    await upsertSnapshotFor(descriptorFor(missing, "one\ntwo\nthree\n"));
    expect(
      countRows(
        store,
        "SELECT COUNT(*) AS n FROM line_lineage ll WHERE ll.snapshot_id IN (SELECT snapshot_id FROM file_snapshots WHERE path = ?)",
        missing,
      ),
    ).toBe(3);

    store.db.exec("PRAGMA foreign_keys = OFF");
    try {
      expect(
        (store.db.prepare("PRAGMA foreign_keys").get() as unknown as { foreign_keys: number })
          .foreign_keys,
      ).toBe(0);
      await pruneMissing(store);
    } finally {
      store.db.exec("PRAGMA foreign_keys = ON");
    }

    expect(
      countRows(store, "SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?", missing),
    ).toBe(0);
    expect(
      countRows(store, `SELECT COUNT(*) AS n FROM line_lineage WHERE ${ORPHAN_LINEAGE_SQL}`),
    ).toBe(0);
  });

  it("M2#4: a cache-hit adoption never sweeps the store", async () => {
    const store = await loadHashStore();
    const adopted = "/claim-pins/m2-4-adopted.ts";
    materialize(store, adopted, "alpha\nbeta\n");

    const neighbour = "/claim-pins/m2-4-neighbour.ts";
    const seed = store.db.prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?, ?, 3, ?, 1, 2)",
    );
    for (let index = 0; index < 12; index++) {
      seed.run(neighbour, `3:2:claim-pins-${index}`, 1_000 + index);
    }
    expect(snapshotIdsOf(store, neighbour)).toHaveLength(12);

    materialize(store, adopted, "alpha\nbeta\n");
    expect(snapshotIdsOf(store, neighbour)).toHaveLength(12);

    expect(vacuumSnapshots(store.db).evicted).toBe(2);
    expect(snapshotIdsOf(store, neighbour)).toHaveLength(10);
  });

  it("M2#10: the cache-hit retirement runs as a correlated NOT EXISTS, never a NOT IN list", async () => {
    const store = await loadHashStore();
    const sql = preparedSql("src/served-session/session.ts", "leaseRetireAbsentStmt", {});
    expect(sql).toContain("UPDATE served_leases SET retired_at");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM line_lineage ll");
    expect(sql.match(/\?/g) ?? []).toHaveLength(3);

    const plan = queryPlan(store, sql, [1, "/claim-pins/m2-10.ts", 1]);
    expect(plan.filter((line) => line.includes("LIST SUBQUERY"))).toEqual([]);
    expect(plan.filter((line) => line.includes("TEMP B-TREE"))).toEqual([]);
    expect(plan.filter((line) => line.includes("CORRELATED SCALAR SUBQUERY"))).toHaveLength(1);
    expect(
      plan.some((line) =>
        line.includes(
          "SEARCH ll USING COVERING INDEX idx_lineage_snapshot_line_id (snapshot_id=? AND line_id=?)",
        ),
      ),
    ).toBe(true);

    const notIn = sql.replace(
      "AND NOT EXISTS (SELECT 1 FROM line_lineage ll WHERE ll.snapshot_id = ? AND ll.line_id = served_leases.line_id)",
      "AND served_leases.line_id NOT IN (SELECT ll.line_id FROM line_lineage ll WHERE ll.snapshot_id = ?)",
    );
    expect(notIn).not.toBe(sql);
    const notInPlan = queryPlan(store, notIn, [1, "/claim-pins/m2-10.ts", 1]);
    expect(notInPlan.some((line) => line.includes("LIST SUBQUERY"))).toBe(true);
  });

  it("M2#11: the vacuum pin probe stays index-covered by idx_leases_file_snapshot", async () => {
    const store = await loadHashStore();
    const sql = preparedSql("src/snapshot-store/vacuum.ts", "pinnedStmt", {
      RESOLVABLE_LEASE_SQL,
    });
    expect(sql).toContain("FROM file_snapshots fs");
    expect(sql).toContain(RESOLVABLE_LEASE_SQL);
    expect(sql.match(/\?/g) ?? []).toHaveLength(2);

    const plan = queryPlan(store, sql, [1, 1]);
    const leaseProbe = plan.filter((line) => line.includes("served_leases"));
    expect(leaseProbe).toHaveLength(1);
    expect(leaseProbe[0]).toBe(
      "SEARCH served_leases USING COVERING INDEX idx_leases_file_snapshot (file_path=? AND served_snapshot_hash=?)",
    );
  });
});

describe("M2 claim pins — anchor identity", () => {
  it("M2#7: the content-only base index stays inside the 18-bit subcube", async () => {
    const lines = Array.from({ length: 64 }, (_, index) => `const claim${index} = ${index};`);
    const expected = lines.map((line) => (xxh32(line) >>> 14) % HASH_SPACE);
    expect(new Set(expected).size).toBe(64);

    const anchors = contentOnlyHashes(lines.join("\n"));
    expect(anchors.map(indexOfAnchor)).toEqual(expected);
    expect(Math.max(...expected)).toBeLessThan(2 ** 18);
    expect(Math.max(...expected)).toBeGreaterThan(2 ** 17);
  });

  it("M2#12: an unrecognized placement value is refused, never silently in-place", async () => {
    const item = { text: "", anchor_from: "AAAA", anchor_to: "AAAA", placement: "at-start" };
    expect(() => resEdit(item as never)).toThrow(
      /Field "at" must be "in-place", "before" or "after"\. Nothing was written\./,
    );
    for (const placement of ["in-place", "before", "after"] as const) {
      expect(
        resEdit({ text: "x", anchor_from: "AAAA", anchor_to: "AAAA", placement }).placement,
      ).toBe(placement);
    }
  });

  it("M2#14: the minimal-displacement backbone stays sub-quadratic at 100k pins", () => {
    const pins = Array.from({ length: 100_000 }, (_, index) => ({
      prevLine: index + 1,
      currLine: index + 1,
    }));
    expect(findStablePinBackbone(pins)).toHaveLength(100_000);
  });

  it("M2#15: a CR whose LF falls outside the slice is not yet a break", () => {
    const crlf = "a\r\nb";
    expect(lineSpanForOffsets(crlf, 0, 4)).toEqual({ startLine: 1, endLine: 2 });
    expect(lineSpanForOffsets(crlf, 0, 2)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineSpanForOffsets("a\rb", 0, 3)).toEqual({ startLine: 1, endLine: 2 });

    const lines = "a\nb\nc";
    expect(lineSpanForOffsets(lines, 1, 2)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineSpanForOffsets("a\n", 0, 2)).toEqual({ startLine: 1, endLine: 1 });
    expect(lineSpanForOffsets("abc", 0, 4)).toBeNull();
    expect(lineSpanForOffsets("abc", 2, 1)).toBeNull();
  });
});

describe("M2 claim pins — served sessions", () => {
  it("M2#8: a cache-hit re-adoption still runs the authoritative retired_at writer", async () => {
    const store = await loadHashStore();
    const io = snapshotIOFor(store);
    const path = "/claim-pins/m2-8.ts";
    const sessionKey = "m2-8";
    const older = "alpha\nbeta\ngamma\n";
    const newer = "alpha\nBETA\ngamma\n";

    const olderHashes = await defaultHashIdentity.hashesFor(older, {
      path,
      snapshotIO: io,
      retireLeases: true,
    });
    expect(olderHashes).toHaveLength(3);
    const newerHashes = await defaultHashIdentity.hashesFor(newer, {
      path,
      snapshotIO: io,
      retireLeases: true,
    });
    grantLeasesInTransaction(
      store.db,
      sessionKey,
      path,
      [{ position: 1, hash: newerHashes[1]! }],
      snapshotHashFor(newer),
    );
    expect(leaseRowsOf(store, sessionKey).map((lease) => lease.retired_at)).toEqual([null]);

    await defaultHashIdentity.hashesFor(older, { path, snapshotIO: io, retireLeases: true });

    const leases = leaseRowsOf(store, sessionKey);
    expect(leases.map((lease) => lease.served_snapshot_hash)).toEqual([snapshotHashFor(newer)]);
    expect(leases.map((lease) => lease.retired_at !== null)).toEqual([true]);
  });

  it("M2#9: the chunk and page budgets are 400, 400 and 4096", () => {
    const source = readFileSync("src/served-session/session.ts", "utf-8");
    expect(source).toContain("const LEASE_UPSERT_CHUNK = 400;");
    expect(source).toContain("const LINEAGE_PAGE_CHUNK = 400;");
    expect(source).toContain("const GRANT_PAGE_MAX = 4096;");
  });

  it("M2#9b: the 4096-row page-pricing boundary is result-preserving", async () => {
    const store = await loadHashStore();
    const content = Array.from({ length: 4_100 }, (_, index) => `line ${index}`).join("\n");
    const path = "/claim-pins/m2-9.ts";
    materialize(store, path, content);
    const hashes = contentOnlyHashes(content);
    const page = hashes.map((hash, position) => ({ position, hash }));

    grantLeasesInTransaction(
      store.db,
      "m2-9-page",
      path,
      page.slice(0, 4_096),
      snapshotHashFor(content),
    );
    grantLeasesInTransaction(
      store.db,
      "m2-9-scan",
      path,
      page.slice(0, 4_097),
      snapshotHashFor(content),
    );

    const asPage = leaseRowsOf(store, "m2-9-page");
    const asScan = leaseRowsOf(store, "m2-9-scan").slice(0, 4_096);
    expect(asPage).toHaveLength(4_096);
    expect(leaseRowsOf(store, "m2-9-scan")).toHaveLength(4_097);
    expect(asPage).toEqual(asScan);
    expect(asPage[0]!.line_id).toBe(1);
  });
});

describe("M2 claim pins — read expansion", () => {
  it("M2#16: a fence fails closed — no backtick in a backtick info string, no unclosed fence", () => {
    const smuggled = "# A\n```js`x\n# B\n";
    expect(findMarkdownSection(smuggled, 1, 1)).toEqual({ start: 1, end: 2, title: "A" });
    expect(findMarkdownSection("# A\n```js\n# B\n", 1, 1)).toBeNull();
    expect(findMarkdownSection("# A\n```\n# B\n", 1, 1)).toBeNull();
    expect(findMarkdownSection("# A\n```\n# B\n```\n", 1, 1)).toEqual({
      start: 1,
      end: 4,
      title: "A",
    });
  });
});

describe("M2 claim pins — edit assembly", () => {
  it("M2#5: every retired span is healed to s1 <= s2 before it is written", () => {
    const content = "a\nb\nX\nY\nc";
    const hashes = contentOnlyHashes(content);
    const move = (sourceFrom: number, sourceTo: number): HEdit =>
      ({
        content_lines: [],
        hash_bounds: [{ hash: hashes[4]! }, { hash: hashes[4]! }],
        placement: "after",
        source: {
          bounds: [{ hash: hashes[sourceFrom - 1]! }, { hash: hashes[sourceTo - 1]! }],
          retire: true,
        },
      }) as HEdit;

    const healed = applyEdit(content, move(2, 1), undefined, hashes);
    expect(healed.sourceRange).toMatchObject({ startLine: 1, endLine: 2 });
    expect(
      healed.warnings?.filter((warning) => warning.includes("W_REVERSED_ANCHORS")),
    ).toHaveLength(1);

    const written = applyEdit(content, move(1, 2), undefined, hashes);
    expect(written.sourceRange).toMatchObject({ startLine: 1, endLine: 2 });
    expect(written.sourceRange!.startLine).toBeLessThanOrEqual(written.sourceRange!.endLine);
  });
});

/** The base index an anchor was assigned: `idxToHash` is `ALPHA` as a positional numeral. */
function indexOfAnchor(anchor: string): number {
  let index = 0;
  for (const char of anchor) index = index * ALPHA.length + ALPHA.indexOf(char);
  return index;
}

/**
 * The SQL text a module ships for one `db.prepare(...)` statement, read back out of the source.
 *
 * The two statements pinned with it (`leaseRetireAbsentStmt`, `pinnedStmt`) are module-private, and
 * the query plan is the claim, so re-typing the SQL here would pin a copy instead of the code: a
 * `NOT IN` rewrite or a changed index shape has to redden. Literal parts are concatenated in source
 * order; `${NAME}` in a template literal is resolved from `values`, and an unknown name throws.
 */
function preparedSql(file: string, variable: string, values: Record<string, string>): string {
  const source = readFileSync(file, "utf-8");
  const head = `const ${variable} = db.prepare(`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${file}: no \`${head}\` statement to pin`);
  const parts: string[] = [];
  let depth = 1;
  let index = start + head.length;
  while (index < source.length && depth > 0) {
    const char = source[index]!;
    if (char === '"' || char === "`") {
      let end = index + 1;
      let text = "";
      while (end < source.length && source[end] !== char) {
        text += source[end];
        end++;
      }
      parts.push(
        text.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (_, name: string) => {
          const value = values[name];
          if (value === undefined) {
            throw new Error(
              `${file}: ${variable} interpolates \${${name}}, which the pin did not supply`,
            );
          }
          return value;
        }),
      );
      index = end + 1;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    index++;
  }
  if (depth !== 0) throw new Error(`${file}: unterminated db.prepare( for ${variable}`);
  return parts.join("");
}

function queryPlan(store: HashStore, sql: string, params: (string | number)[]): string[] {
  return (
    store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as unknown as { detail: string }[]
  ).map((row) => row.detail);
}
