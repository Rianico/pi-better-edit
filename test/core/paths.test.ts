import { describe, expect, it } from "vitest";
import { homedir } from "os";
import { join, dirname } from "path";
import { configDir, configPath, hashStorePath, hashStoreDir } from "../../src/paths";

describe("configDir", () => {
  it("returns the config directory under home when XDG_CONFIG_HOME is unset", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(configDir()).toBe(join(homedir(), ".config", "pi-hashline-edit-lsz"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it.skipIf(process.platform === "win32")("uses XDG_CONFIG_HOME when set", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    try {
      expect(configDir()).toBe(join("/custom/xdg", "pi-hashline-edit-lsz"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "";
    try {
      expect(configDir()).toBe(join(homedir(), ".config", "pi-hashline-edit-lsz"));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
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
