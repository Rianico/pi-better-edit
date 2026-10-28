import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashStoreDir, hashStorePath, legacyHashStorePath } from "../../src/paths";
import { settingsRoot, stateRoot } from "../../src/config-dir";

/**
 * The relocation's path ladder (#190): two roots, one rule each.
 *
 * WHY these pin the FALLBACKS rather than the override alone: the worker-wide setupFiles seam
 * (test/support/isolate-store.ts) sets `PI_BETTER_EDIT_CONFIG_DIR` for every test file, so a
 * fallback test has to opt out — with an empty value, the documented "unset" spelling — and stub
 * HOME/XDG itself. The override case is the first test here, because it is the only thing that can
 * move the store.
 */
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

/** The three variables this ladder reads, all unset, with the worker seam cleared. */
function withoutOverride(home: string): Record<string, string | undefined> {
  return {
    HOME: home,
    PI_BETTER_EDIT_CONFIG_DIR: "",
    PI_CODING_AGENT_DIR: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
  };
}

describe("the override layout", () => {
  it("owns the settings root verbatim and the state root through <override>/state", () => {
    withEnv({ PI_BETTER_EDIT_CONFIG_DIR: "/tmp/xyz", XDG_STATE_HOME: "/custom/xdg-state" }, () => {
      expect(settingsRoot()).toBe("/tmp/xyz");
      expect(stateRoot()).toBe(join("/tmp/xyz", "state"));
      expect(hashStorePath()).toBe(join("/tmp/xyz", "state", "hash-store.sqlite"));
      expect(legacyHashStorePath()).toBe(join("/tmp/xyz", "state", "hash-store.json"));
      expect(hashStoreDir()).toBe(stateRoot());
    });
  });

  it("treats an empty override as unset", () => {
    withEnv(withoutOverride("/home/probe"), () => {
      expect(settingsRoot()).toBe(
        join("/home/probe", ".pi", "agent", "extensions", "pi-better-edit"),
      );
      expect(stateRoot()).toBe(join("/home/probe", ".local", "state", "pi-better-edit"));
    });
  });
});

describe("the settings root without an override", () => {
  it("lives under the pi agent directory by default", () => {
    withEnv(withoutOverride("/home/probe"), () => {
      expect(settingsRoot()).toBe(
        join("/home/probe", ".pi", "agent", "extensions", "pi-better-edit"),
      );
    });
  });

  it("honours an absolute PI_CODING_AGENT_DIR", () => {
    withEnv({ ...withoutOverride("/home/probe"), PI_CODING_AGENT_DIR: "/opt/pi-agent" }, () => {
      expect(settingsRoot()).toBe(join("/opt/pi-agent", "extensions", "pi-better-edit"));
    });
  });

  it("expands ~ in PI_CODING_AGENT_DIR", () => {
    withEnv({ ...withoutOverride("/home/probe"), PI_CODING_AGENT_DIR: "~/agent-home" }, () => {
      expect(settingsRoot()).toBe(
        join("/home/probe", "agent-home", "extensions", "pi-better-edit"),
      );
    });
  });

  it("ignores a relative PI_CODING_AGENT_DIR instead of resolving it against the cwd", () => {
    withEnv({ ...withoutOverride("/home/probe"), PI_CODING_AGENT_DIR: "relative/agent" }, () => {
      expect(settingsRoot()).toBe(
        join("/home/probe", ".pi", "agent", "extensions", "pi-better-edit"),
      );
    });
  });

  it("no longer reads XDG_CONFIG_HOME", () => {
    withEnv({ ...withoutOverride("/home/probe"), XDG_CONFIG_HOME: "/custom/xdg" }, () => {
      expect(settingsRoot()).not.toContain("/custom/xdg");
      expect(settingsRoot()).toBe(
        join("/home/probe", ".pi", "agent", "extensions", "pi-better-edit"),
      );
    });
  });
});

describe("the state root without an override", () => {
  it("defaults to $HOME/.local/state", () => {
    withEnv(withoutOverride("/home/probe"), () => {
      expect(stateRoot()).toBe(join("/home/probe", ".local", "state", "pi-better-edit"));
    });
  });

  it("honours an absolute XDG_STATE_HOME", () => {
    withEnv({ ...withoutOverride("/home/probe"), XDG_STATE_HOME: "/xdg/state" }, () => {
      expect(stateRoot()).toBe(join("/xdg/state", "pi-better-edit"));
    });
  });

  it("ignores a relative XDG_STATE_HOME", () => {
    withEnv({ ...withoutOverride("/home/probe"), XDG_STATE_HOME: "state-under-cwd" }, () => {
      expect(stateRoot()).toBe(join("/home/probe", ".local", "state", "pi-better-edit"));
    });
  });

  it("ignores an empty XDG_STATE_HOME", () => {
    withEnv({ ...withoutOverride("/home/probe"), XDG_STATE_HOME: "" }, () => {
      expect(stateRoot()).toBe(join("/home/probe", ".local", "state", "pi-better-edit"));
    });
  });
});

describe("the empty HOME fallback", () => {
  it("falls back to the OS home so a path is always absolute", () => {
    withEnv({ ...withoutOverride("/home/probe"), HOME: "" }, () => {
      expect(stateRoot()).toBe(join(homedir(), ".local", "state", "pi-better-edit"));
    });
  });
});
