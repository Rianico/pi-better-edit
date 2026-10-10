import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { configDir, hashStorePath, loadHashStore, shutdownHashStore } from "../../src/hash-store";

/**
 * Acceptance 2 for #89: a store-touching call OUTSIDE any temp helper still resolves into the
 * worker-isolated dir, because test/support/isolate-store.ts (setupFiles) pins the seam before any
 * test module is imported. Nothing here calls withTempFile / withTempDir / setupIntegrationTest.
 */
describe("hash store isolation from the developer's real store", () => {
  afterAll(() => {
    shutdownHashStore();
  });

  it("resolves configDir()/hashStorePath() to the worker temp dir, not the HOME-derived config dir", () => {
    const workerDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
    expect(
      workerDir,
      "test/support/isolate-store.ts must be registered in vitest.config.ts setupFiles",
    ).toBeTruthy();
    expect(configDir()).toBe(workerDir);
    expect(hashStorePath()).toBe(join(workerDir!, "hash-store.sqlite"));
    expect(hashStorePath()).not.toBe(
      join(homedir(), ".config", "pi-better-edit", "hash-store.sqlite"),
    );
  });

  it("opens the store under the worker temp dir through the production entry point with no fixture in scope", async () => {
    const workerDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
    expect(workerDir).toBeTruthy();
    const storeFile = join(workerDir!, "hash-store.sqlite");

    // Strong form: a sentinel HOME proves the seam outranks the HOME/XDG derivation, so the file
    // that appears cannot be the developer's real store and cannot be the sentinel's either.
    const sentinelHome = await mkdtemp(join(tmpdir(), "pi-better-edit-sentinel-home-"));
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = sentinelHome;
    delete process.env.XDG_CONFIG_HOME;
    try {
      shutdownHashStore();
      await loadHashStore();

      expect(hashStorePath()).toBe(storeFile);
      expect(storeFile.startsWith(`${workerDir}${sep}`)).toBe(true);
      expect(statSync(storeFile).size).toBeGreaterThan(0);
      expect(existsSync(join(sentinelHome, ".config", "pi-better-edit"))).toBe(false);
    } finally {
      shutdownHashStore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      await rm(sentinelHome, { recursive: true, force: true });
    }
  });
});
