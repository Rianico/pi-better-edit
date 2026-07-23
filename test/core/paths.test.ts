import { describe, expect, it } from "vitest";
import { homedir } from "os";
import { join, dirname } from "path";
import { configDir, configPath, hashStorePath, hashStoreDir } from "../../src/paths";

describe("configDir", () => {
  it("returns the config directory under home", () => {
    const dir = configDir();
    expect(dir).toBe(join(homedir(), ".config", "pi-hashline-edit-pro"));
  });
});

describe("configPath", () => {
  it("returns the config file path", () => {
    const path = configPath();
    expect(path).toBe(join(configDir(), "config.json"));
  });
});

describe("hashStorePath", () => {
  it("returns the hash store file path", () => {
    const path = hashStorePath();
    expect(path).toBe(join(configDir(), "hash-store.sqlite"));
  });
});

describe("hashStoreDir", () => {
  it("returns the directory of the hash store path", () => {
    const dir = hashStoreDir();
    expect(dir).toBe(dirname(hashStorePath()));
  });
});
