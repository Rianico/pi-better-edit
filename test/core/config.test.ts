import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import {
  readReplaceMode,
  writeReplaceMode,
  toggleReplaceMode,
  readAutoRead,
  writeAutoRead,
  toggleAutoRead,
  readConfig,
  writeConfig,
} from "../../src/config";

// We override the config path by manipulating the homedir. The config module
// uses os.homedir() → ~/.config/pi-hashline-edit-pro/config.json. We create
// a temp dir and set HOME so the module writes there instead.
const origHome = process.env.HOME;
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-config-test-"));
  process.env.HOME = tmpHome;
  try {
    await run();
  } finally {
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  }
}

describe("config — readReplaceMode", () => {
  it("returns 'bulk' when no config file exists", async () => {
    await withTempHome(async () => {
      const mode = await readReplaceMode();
      expect(mode).toBe("bulk");
    });
  });

  it("returns 'bulk' for corrupted config file", async () => {
    await withTempHome(async () => {
      const configDir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), "not valid json", "utf-8");
      const mode = await readReplaceMode();
      expect(mode).toBe("bulk");
    });
  });

  it("returns 'bulk' for config with invalid mode value", async () => {
    await withTempHome(async () => {
      const configDir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ replaceMode: "invalid" }), "utf-8");
      const mode = await readReplaceMode();
      expect(mode).toBe("bulk");
    });
  });

  it("reads back a written 'flat' mode", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("flat");
      const mode = await readReplaceMode();
      expect(mode).toBe("flat");
    });
  });

  it("reads back a written 'bulk' mode", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("bulk");
      const mode = await readReplaceMode();
      expect(mode).toBe("bulk");
    });
  });
});

describe("config — writeReplaceMode", () => {
  it("creates the config directory and file", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("flat");
      const configPath = join(tmpHome, ".config", "pi-hashline-edit-pro", "config.json");
      const content = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.replaceMode).toBe("flat");
    });
  });
});

describe("config — toggleReplaceMode", () => {
  it("toggles from default 'bulk' to 'flat'", async () => {
    await withTempHome(async () => {
      const mode = await toggleReplaceMode();
      expect(mode).toBe("flat");
      const persisted = await readReplaceMode();
      expect(persisted).toBe("flat");
    });
  });

  it("toggles from 'flat' back to 'bulk'", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("flat");
      const mode = await toggleReplaceMode();
      expect(mode).toBe("bulk");
      const persisted = await readReplaceMode();
      expect(persisted).toBe("bulk");
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleReplaceMode()).toBe("flat");
      expect(await toggleReplaceMode()).toBe("bulk");
      expect(await toggleReplaceMode()).toBe("flat");
      expect(await readReplaceMode()).toBe("flat");
    });
  });
});

describe("config — readAutoRead", () => {
  it("returns false when no config file exists", async () => {
    await withTempHome(async () => {
      expect(await readAutoRead()).toBe(false);
    });
  });

  it("returns false for corrupted config", async () => {
    await withTempHome(async () => {
      const configDir = join(tmpHome, ".config", "pi-hashline-edit-pro");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), "garbage", "utf-8");
      expect(await readAutoRead()).toBe(false);
    });
  });

  it("reads back a written 'true' value", async () => {
    await withTempHome(async () => {
      await writeAutoRead(true);
      expect(await readAutoRead()).toBe(true);
    });
  });

  it("reads back a written 'false' value", async () => {
    await withTempHome(async () => {
      await writeAutoRead(false);
      expect(await readAutoRead()).toBe(false);
    });
  });
});

describe("config — toggleAutoRead", () => {
  it("toggles from default false to true", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(true);
      expect(await readAutoRead()).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempHome(async () => {
      await writeAutoRead(true);
      expect(await toggleAutoRead()).toBe(false);
      expect(await readAutoRead()).toBe(false);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(true);
      expect(await toggleAutoRead()).toBe(false);
      expect(await toggleAutoRead()).toBe(true);
      expect(await readAutoRead()).toBe(true);
    });
  });
});

describe("config — readConfig / writeConfig (field isolation)", () => {
  it("writeReplaceMode does not clobber autoRead", async () => {
    await withTempHome(async () => {
      await writeAutoRead(true);
      await writeReplaceMode("flat");
      const config = await readConfig();
      expect(config.replaceMode).toBe("flat");
      expect(config.autoRead).toBe(true);
    });
  });

  it("writeAutoRead does not clobber replaceMode", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("flat");
      await writeAutoRead(true);
      const config = await readConfig();
      expect(config.replaceMode).toBe("flat");
      expect(config.autoRead).toBe(true);
    });
  });
});
