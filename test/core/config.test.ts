import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  toggleReplaceMode,
  toggleAutoRead,
  readConfig,
  writeConfig,
} from "../../src/config";
import { getWritableTempRoot } from "../support/fixtures";
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-config-test-"));
  vi.stubEnv('HOME', tmpHome);
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}
describe("config — toggleReplaceMode", () => {
  it("toggles from default 'bulk' to 'flat'", async () => {
    await withTempHome(async () => {
      const mode = await toggleReplaceMode();
      expect(mode).toBe("flat");
      const persisted = (await readConfig()).replaceMode;
      expect(persisted).toBe("flat");
    });
  });

  it("toggles from 'flat' back to 'bulk'", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: false });
      const mode = await toggleReplaceMode();
      expect(mode).toBe("bulk");
      const persisted = (await readConfig()).replaceMode;
      expect(persisted).toBe("bulk");
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleReplaceMode()).toBe("flat");
      expect(await toggleReplaceMode()).toBe("bulk");
      expect(await toggleReplaceMode()).toBe("flat");
      expect((await readConfig()).replaceMode).toBe("flat");
    });
  });
});

describe("config — toggleAutoRead", () => {
  it("toggles from default false to true", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(true);
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("toggles from true back to false", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: true });
      expect(await toggleAutoRead()).toBe(false);
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("round-trips correctly through multiple toggles", async () => {
    await withTempHome(async () => {
      expect(await toggleAutoRead()).toBe(true);
      expect(await toggleAutoRead()).toBe(false);
      expect(await toggleAutoRead()).toBe(true);
      expect((await readConfig()).autoRead).toBe(true);
    });
  });
});

describe("config — readConfig / writeConfig (field isolation)", () => {
  it("writeConfig preserves both fields", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: true });
      const config = await readConfig();
      expect(config.replaceMode).toBe("flat");
      expect(config.autoRead).toBe(true);
    });
  });

  it("writeConfig preserves both fields (reverse)", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: true });
      const config = await readConfig();
      expect(config.replaceMode).toBe("flat");
      expect(config.autoRead).toBe(true);
    });
  });
});

describe("config — atomic writes", () => {
  it("leaves no temp files behind after writeConfig", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: true });
      const { readdir } = await import("fs/promises");
      const entries = await readdir(join(tmpHome, ".config", "pi-hashline-edit-pro"));
      expect(entries).toEqual(["config.json"]);
    });
  });
});

describe("config — PI_HASHLINE_AUTO_READ env defaults", () => {
  const savedEnv = process.env.PI_HASHLINE_AUTO_READ;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PI_HASHLINE_AUTO_READ;
    } else {
      process.env.PI_HASHLINE_AUTO_READ = savedEnv;
    }
  });

  it("seeds autoRead from env when no config file exists", async () => {
    process.env.PI_HASHLINE_AUTO_READ = "1";
    await withTempHome(async () => {
      const config = await readConfig();
      expect(config.autoRead).toBe(true);
      expect(config.replaceMode).toBe("bulk");
    });
  });

  it("accepts 'true' as an enabling value", async () => {
    process.env.PI_HASHLINE_AUTO_READ = "true";
    await withTempHome(async () => {
      expect((await readConfig()).autoRead).toBe(true);
    });
  });

  it("ignores other env values", async () => {
    process.env.PI_HASHLINE_AUTO_READ = "0";
    await withTempHome(async () => {
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("config file wins over env var", async () => {
    process.env.PI_HASHLINE_AUTO_READ = "1";
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: false });
      expect((await readConfig()).autoRead).toBe(false);
    });
  });

  it("toggleReplaceMode does not drop env-seeded autoRead", async () => {
    process.env.PI_HASHLINE_AUTO_READ = "1";
    await withTempHome(async () => {
      const mode = await toggleReplaceMode();
      expect(mode).toBe("flat");
      const config = await readConfig();
      expect(config.replaceMode).toBe("flat");
      expect(config.autoRead).toBe(true);
    });
  });
});
