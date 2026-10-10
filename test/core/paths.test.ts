import { describe, expect, it } from "vitest";
import { homedir } from "os";
import { join, dirname } from "path";
import { configDir, hashStorePath, hashStoreDir } from "../../src/paths";

// WHY: this file pins the XDG/HOME fallback chain. The worker-wide setupFiles seam
// WHY: (test/support/isolate-store.ts) sets PI_BETTER_EDIT_CONFIG_DIR for every test file, so each
// WHY: fallback test opts out explicitly with an empty value — the documented "unset" spelling.
function withoutConfigDirSeam(run: () => void): void {
  const previous = process.env.PI_BETTER_EDIT_CONFIG_DIR;
  process.env.PI_BETTER_EDIT_CONFIG_DIR = "";
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_BETTER_EDIT_CONFIG_DIR;
    else process.env.PI_BETTER_EDIT_CONFIG_DIR = previous;
  }
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("configDir", () => {
  it("returns PI_BETTER_EDIT_CONFIG_DIR verbatim, without a pi-better-edit suffix", () => {
    withEnv({ PI_BETTER_EDIT_CONFIG_DIR: "/tmp/xyz", XDG_CONFIG_HOME: "/custom/xdg" }, () => {
      expect(configDir()).toBe("/tmp/xyz");
      expect(hashStorePath()).toBe(join("/tmp/xyz", "hash-store.sqlite"));
    });
  });

  it("ignores an empty PI_BETTER_EDIT_CONFIG_DIR and falls through to the XDG path", () => {
    withEnv({ PI_BETTER_EDIT_CONFIG_DIR: "", XDG_CONFIG_HOME: "/custom/xdg" }, () => {
      expect(configDir()).toBe(join("/custom/xdg", "pi-better-edit"));
    });
  });
  it("returns the config directory under home when XDG_CONFIG_HOME is unset", () => {
    withoutConfigDirSeam(() => {
      const previousXdg = process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_CONFIG_HOME;
      try {
        expect(configDir()).toBe(join(homedir(), ".config", "pi-better-edit"));
      } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
      }
    });
  });

  it.skipIf(process.platform === "win32")("uses XDG_CONFIG_HOME when set", () => {
    withoutConfigDirSeam(() => {
      const previousXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = "/custom/xdg";
      try {
        expect(configDir()).toBe(join("/custom/xdg", "pi-better-edit"));
      } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
      }
    });
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    withoutConfigDirSeam(() => {
      const previousXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = "";
      try {
        expect(configDir()).toBe(join(homedir(), ".config", "pi-better-edit"));
      } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
      }
    });
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
