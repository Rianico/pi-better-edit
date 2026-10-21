import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BASH_VIEW_ENV_VAR } from "../../../src/bash-view-config.js";
import { LENS_BRIDGE_ENV_VAR } from "../../../src/integrations/pi-lens/config.js";
import { SettingsOverlay } from "../../../src/integrations/pi-lens/settings-overlay.js";
import { STORE_JANITOR_ENV_VAR } from "../../../src/store-kernel/settings.js";

let root = "";
let projectDir = "";
let homeDir = "";
const savedHome = process.env.HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pbe-settings-overlay-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  delete process.env[BASH_VIEW_ENV_VAR];
  delete process.env[STORE_JANITOR_ENV_VAR];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env[LENS_BRIDGE_ENV_VAR];
  delete process.env[BASH_VIEW_ENV_VAR];
  delete process.env[STORE_JANITOR_ENV_VAR];
  await rm(root, { recursive: true, force: true });
});

function rendered(overlay: SettingsOverlay, width = 68): string {
  return overlay.render(width).join("\n");
}

describe("SettingsOverlay", () => {
  it("renders both description lines of the selected setting row", () => {
    const overlay = new SettingsOverlay(projectDir, () => undefined);
    overlay.selectItem("lens");
    const out = rendered(overlay);
    expect(out).toContain("Effective:");
    expect(out).toContain("Global:");
    expect(out).toContain("Env:");
    const lines = out.split("\n");
    const effectiveIdx = lines.findIndex((line) => line.includes("Effective:"));
    expect(effectiveIdx).toBeGreaterThan(-1);
  });

  it("shows the env-override prefix on the effective line when the env var wins", () => {
    const saved = process.env[LENS_BRIDGE_ENV_VAR];
    process.env[LENS_BRIDGE_ENV_VAR] = "off";
    try {
      const overlay = new SettingsOverlay(projectDir, () => undefined);
      overlay.selectItem("lens");
      const out = rendered(overlay);
      expect(out).toContain(`⚠️ Overridden by ${LENS_BRIDGE_ENV_VAR}`);
      expect(out.replace(/\s+/g, " ")).toContain("Effective: off (source: env)");
    } finally {
      if (saved === undefined) delete process.env[LENS_BRIDGE_ENV_VAR];
      else process.env[LENS_BRIDGE_ENV_VAR] = saved;
    }
  });

  it("calls done with undefined on Escape", () => {
    const seen: unknown[] = [];
    const overlay = new SettingsOverlay(projectDir, (result) => {
      seen.push(result);
    });
    overlay.handleInput("\x1b");
    expect(seen).toEqual([undefined]);
  });

  it("exposes four rows including the target scope switch", () => {
    const overlay = new SettingsOverlay(projectDir, () => undefined);
    for (const id of ["target-scope", "lens", "bash-view", "store"]) {
      overlay.selectItem(id);
      const out = rendered(overlay);
      expect(out).toContain("Effective:");
    }
  });
});
