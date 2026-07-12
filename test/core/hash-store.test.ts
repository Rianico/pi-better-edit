import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import {
  loadHashStore,
  saveHashStore,
  pruneHashStore,
  type HashStore,
} from "../../src/hash-store";

let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-hashstore-test-"));
  vi.stubEnv('HOME', tmpHome);
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function storePath(): string {
  return join(tmpHome, ".config", "pi-hashline-edit-pro", "hash-store.json");
}

describe("hash-store — loadHashStore", () => {
  it("returns default store when no file exists", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      expect(store.version).toBe(1);
      expect(store.snapshots).toEqual({});
    });
  });

  it("creates the store file when none exists", async () => {
    await withTempHome(async () => {
      await loadHashStore();
      const content = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(parsed.snapshots).toEqual({});
    });
  });

  it("returns parsed store when file exists with valid data", async () => {
    await withTempHome(async () => {
      const initial: HashStore = {
        version: 1,
        snapshots: {
          "/path/to/file.ts": { content: "hello\n", hashes: ["aB3", "xY7"] },
        },
      };
      await mkdir(join(tmpHome, ".config", "pi-hashline-edit-pro"), { recursive: true });
      await writeFile(storePath(), JSON.stringify(initial), "utf-8");

      const store = await loadHashStore();
      expect(store.version).toBe(1);
      expect(store.snapshots["/path/to/file.ts"]).toBeDefined();
      expect(store.snapshots["/path/to/file.ts"]!.content).toBe("hello\n");
      expect(store.snapshots["/path/to/file.ts"]!.hashes).toEqual(["aB3", "xY7"]);
    });
  });

  it("returns default store for corrupt JSON and overwrites the file", async () => {
    await withTempHome(async () => {
      const dir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(dir, { recursive: true });
      await writeFile(storePath(), "not valid json", "utf-8");

      const store = await loadHashStore();
      expect(store.version).toBe(1);
      expect(store.snapshots).toEqual({});

      // Verify the file was overwritten with valid JSON
      const content = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
    });
  });

  it("handles missing snapshots field gracefully", async () => {
    await withTempHome(async () => {
      const dir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(dir, { recursive: true });
      await writeFile(storePath(), JSON.stringify({ version: 1 }), "utf-8");

      const store = await loadHashStore();
      expect(store.snapshots).toEqual({});
    });
  });

  it("handles null snapshots field gracefully", async () => {
    await withTempHome(async () => {
      const dir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(dir, { recursive: true });
      await writeFile(storePath(), JSON.stringify({ version: 1, snapshots: null }), "utf-8");

      const store = await loadHashStore();
      expect(store.snapshots).toEqual({});
    });
  });
});

describe("hash-store — saveHashStore", () => {
  it("writes store to disk", async () => {
    await withTempHome(async () => {
      const store: HashStore = {
        version: 1,
        snapshots: {
          "/a.ts": { content: "x\n", hashes: ["AAA"] },
        },
      };
      await saveHashStore(store);

      const content = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(parsed.snapshots["/a.ts"].content).toBe("x\n");
    });
  });

  it("creates the config directory if it does not exist", async () => {
    await withTempHome(async () => {
      const store: HashStore = { version: 1, snapshots: {} };
      await saveHashStore(store);

      // Should not throw — directory was created
      const content = await readFile(storePath(), "utf-8");
      expect(JSON.parse(content).version).toBe(1);
    });
  });

  it("round-trips through load and save", async () => {
    await withTempHome(async () => {
      const original: HashStore = {
        version: 1,
        snapshots: {
          "/a.ts": { content: "a\n", hashes: ["AAA"] },
          "/b.ts": { content: "b\nc\n", hashes: ["BBB", "CCC"] },
        },
      };
      await saveHashStore(original);
      const loaded = await loadHashStore();
      expect(loaded).toEqual(original);
    });
  });

  it("preserves all snapshots when saving multiple entries", async () => {
    await withTempHome(async () => {
      const store: HashStore = {
        version: 1,
        snapshots: {
          "/1.ts": { content: "1\n", hashes: ["111"] },
          "/2.ts": { content: "2\n", hashes: ["222"] },
          "/3.ts": { content: "3\n", hashes: ["333"] },
        },
      };
      await saveHashStore(store);
      const loaded = await loadHashStore();
      expect(Object.keys(loaded.snapshots)).toHaveLength(3);
    });
  });

  it("produces valid JSON that can be parsed back", async () => {
    await withTempHome(async () => {
      const store: HashStore = {
        version: 1,
        snapshots: {
          "/a.ts": { content: "x\n", hashes: ["AAA"] },
          "/b.ts": { content: "y\n", hashes: ["BBB"] },
        },
      };
      await saveHashStore(store);
      const raw = await readFile(storePath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.snapshots["/a.ts"].content).toBe("x\n");
      expect(parsed.snapshots["/b.ts"].content).toBe("y\n");
    });
  });
});

describe("hash-store — pruneHashStore", () => {
  it("removes snapshots for files that no longer exist", async () => {
    await withTempHome(async () => {
      const store: HashStore = {
        version: 1,
        snapshots: {
          "/nonexistent/file.ts": { content: "old\n", hashes: ["ZZZ"] },
        },
      };
      await pruneHashStore(store);
      expect(store.snapshots).toEqual({});
    });
  });

  it("keeps snapshots for files that still exist", async () => {
    await withTempHome(async () => {
      const existingFile = join(tmpHome, "existing.ts");
      await writeFile(existingFile, "hello\n", "utf-8");

      const store: HashStore = {
        version: 1,
        snapshots: {
          [existingFile]: { content: "hello\n", hashes: ["ABC"] },
        },
      };
      await pruneHashStore(store);
      expect(store.snapshots[existingFile]).toBeDefined();
    });
  });

  it("removes stale entries while keeping valid ones", async () => {
    await withTempHome(async () => {
      const existingFile = join(tmpHome, "keep.ts");
      await writeFile(existingFile, "keep\n", "utf-8");

      const store: HashStore = {
        version: 1,
        snapshots: {
          [existingFile]: { content: "keep\n", hashes: ["KEP"] },
          "/gone.ts": { content: "gone\n", hashes: ["GON"] },
        },
      };
      await pruneHashStore(store);
      expect(store.snapshots[existingFile]).toBeDefined();
      expect(store.snapshots["/gone.ts"]).toBeUndefined();
    });
  });

  it("does nothing when all snapshots reference existing files", async () => {
    await withTempHome(async () => {
      const f1 = join(tmpHome, "a.ts");
      const f2 = join(tmpHome, "b.ts");
      await writeFile(f1, "a\n", "utf-8");
      await writeFile(f2, "b\n", "utf-8");

      const store: HashStore = {
        version: 1,
        snapshots: {
          [f1]: { content: "a\n", hashes: ["AAA"] },
          [f2]: { content: "b\n", hashes: ["BBB"] },
        },
      };
      const snapshotCount = Object.keys(store.snapshots).length;
      await pruneHashStore(store);
      expect(Object.keys(store.snapshots)).toHaveLength(snapshotCount);
    });
  });

  it("persists the pruned store to disk when entries are removed", async () => {
    await withTempHome(async () => {
      const store: HashStore = {
        version: 1,
        snapshots: {
          "/gone.ts": { content: "x\n", hashes: ["XXX"] },
        },
      };
      await pruneHashStore(store);

      const loaded = await loadHashStore();
      expect(loaded.snapshots).toEqual({});
    });
  });

  it("does not persist when no entries are removed", async () => {
    await withTempHome(async () => {
      const existingFile = join(tmpHome, "stay.ts");
      await writeFile(existingFile, "stay\n", "utf-8");

      const store: HashStore = {
        version: 1,
        snapshots: {
          [existingFile]: { content: "stay\n", hashes: ["STY"] },
        },
      };
      // Save initial state
      await saveHashStore(store);

      // Prune — should not change anything
      await pruneHashStore(store);

      // Load and verify
      const loaded = await loadHashStore();
      expect(loaded.snapshots[existingFile]).toBeDefined();
    });
  });
});
