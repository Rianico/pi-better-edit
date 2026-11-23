import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { getWritableTempRoot } from "../support/fixtures";
import { loadHashStore, shutdownHashStore } from "../../src/hash-store";

describe("store — withStore fail-loud", () => {
  it("throws when no store is open", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-fail-loud-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      shutdownHashStore();
      const { withStore } = await import("../../src/store-kernel");
      expect(() => withStore(() => {})).toThrow(/requires an open SQLite store/);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("store — schema ownership", () => {
  it("creates the v7 snapshot, undo and served tables via domain ensureSchema hooks", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-schema-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const store = await loadHashStore();
      const db = store.db;
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = tables.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining(["file_snapshots", "file_undo", "served_session_meta", "meta"]),
      );
    } finally {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("snapshot/undo/served ensureSchema are idempotent", async () => {
    const home = await mkdtemp(join(await getWritableTempRoot(), "store-idempotent-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const store = await loadHashStore();
      const { ensureSnapshotSchema } = await import("../../src/snapshot-store");
      const { ensureFileUndoSchema } = await import("../../src/hash-store");
      const { ensureServedSchema } = await import("../../src/served-session/index.js");
      expect(() => ensureSnapshotSchema(store.db)).not.toThrow();
      expect(() => ensureFileUndoSchema(store.db)).not.toThrow();
      expect(() => ensureServedSchema(store.db)).not.toThrow();
      expect(() => ensureSnapshotSchema(store.db)).not.toThrow();
    } finally {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
