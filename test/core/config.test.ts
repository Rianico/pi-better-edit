import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import {
  toggleReplaceMode,
  toggleAutoRead,
  readConfig,
  writeConfig,
} from "../../src/config";

// We override the config path by manipulating the homedir. The config module
// uses os.homedir() → ~/.config/pi-hashline-edit-pro/config.json. We create
// a temp dir and set HOME so the module writes there instead.
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-config-test-"));
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
