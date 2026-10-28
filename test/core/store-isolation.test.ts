import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { hashStorePath, loadHashStore, shutdownHashStore } from "../../src/hash-store";
import { settingsRoot, stateRoot } from "../../src/config-dir";

/**
 * Acceptance 2 for #89 and #190: a store-touching call OUTSIDE any temp helper still resolves into
 * the worker-isolated state root, because test/support/isolate-store.ts (setupFiles) pins the seam
 * before any test module is imported. Nothing here calls withTempFile / withTempDir /
 * setupIntegrationTest.
 *
 * WHY the two roots are asserted separately: the override names the extension's own root, the
 * settings file sits directly in it and the store sits in `<root>/state/`. A single assertion on
 * "some path under the temp dir" would pass even if settings and state had swapped places.
 */
describe("hash store isolation from the developer's real state", () => {
  afterAll(() => {
    shutdownHashStore();
  });

  it("resolves the settings root and the state root into the worker temp dir", () => {
    const workerDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
    expect(
      workerDir,
      "test/support/isolate-store.ts must be registered in vitest.config.ts setupFiles",
    ).toBeTruthy();
    expect(settingsRoot()).toBe(workerDir);
    expect(stateRoot()).toBe(join(workerDir!, "state"));
    expect(hashStorePath()).toBe(join(workerDir!, "state", "hash-store.sqlite"));
    // The HOME-derived locations are exactly what the seam must outrank.
    expect(hashStorePath()).not.toBe(
      join(homedir(), ".local", "state", "pi-better-edit", "hash-store.sqlite"),
    );
    expect(stateRoot()).not.toBe(join(homedir(), ".config", "pi-better-edit"));
  });

  it("opens the store under the worker temp dir through the production entry point with no fixture in scope", async () => {
    const workerDir = process.env.PI_BETTER_EDIT_CONFIG_DIR;
    expect(workerDir).toBeTruthy();
    const storeFile = join(workerDir!, "state", "hash-store.sqlite");

    // Strong form: a sentinel HOME proves the seam outranks the HOME/XDG derivation, so the file
    // that appears cannot be the developer's real store and cannot be the sentinel's either.
    const sentinelHome = await mkdtemp(join(tmpdir(), "pi-better-edit-sentinel-home-"));
    const previousHome = process.env.HOME;
    const previousXdgState = process.env.XDG_STATE_HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = sentinelHome;
    delete process.env.XDG_STATE_HOME;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      shutdownHashStore();
      await loadHashStore();

      expect(hashStorePath()).toBe(storeFile);
      expect(storeFile.startsWith(`${workerDir}${sep}`)).toBe(true);
      expect(statSync(storeFile).size).toBeGreaterThan(0);
      // Neither retired nor defaulted location may appear under the sentinel home.
      expect(existsSync(join(sentinelHome, ".config", "pi-better-edit"))).toBe(false);
      expect(existsSync(join(sentinelHome, ".local", "state", "pi-better-edit"))).toBe(false);
      expect(existsSync(join(sentinelHome, ".pi", "agent", "extensions", "pi-better-edit"))).toBe(
        false,
      );
    } finally {
      shutdownHashStore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdgState;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(sentinelHome, { recursive: true, force: true });
    }
  });
});
