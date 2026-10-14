import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveBashViewConfig } from "../../src/bash-view-config.js";
import { DomainError } from "../../src/domain-errors.js";
import { saveLensBridgeConfig } from "../../src/integrations/pi-lens/config.js";
import { saveStoreJanitorConfig } from "../../src/store-config.js";

// WHY: (Issue #94) these eight guards are internal contract checks, not payload validation: the
// WHY: command handlers narrow every token and the settings overlay offers only enum choices, so no
// WHY: caller can reach them. Their code must read as an invariant failure and their text must state
// WHY: the fact — a payload remedy would advertise a repair that cannot exist.
// WHY: The token list mirrors `test/arch/remedy-eligibility.test.ts`, which polices the registry
// WHY: examples; this oracle drives the eight REAL sites, where a planted imperative would pass it.
const IMPERATIVE = /\b(retry|use|run|execute|omit|declare|choose|merge|pass|send|fix)\b/i;
const PAYLOAD_REMEDY = "Fix the payload fields and retry.";

interface Site {
  readonly label: string;
  readonly offending: string;
  readonly trigger: (dir: string) => unknown;
}

const LENS_MODE = (mode: unknown, dir: string): unknown =>
  saveLensBridgeConfig(mode as Parameters<typeof saveLensBridgeConfig>[0], "project", dir);
const LENS_SCOPE = (scope: unknown, dir: string): unknown =>
  saveLensBridgeConfig("on", scope as Parameters<typeof saveLensBridgeConfig>[1], dir);
const BASH_VIEW_MODE = (mode: unknown, dir: string): unknown =>
  saveBashViewConfig(mode as Parameters<typeof saveBashViewConfig>[0], "project", dir);
const BASH_VIEW_SCOPE = (scope: unknown, dir: string): unknown =>
  saveBashViewConfig("off", scope as Parameters<typeof saveBashViewConfig>[1], dir);
const STORE_SCOPE = (scope: unknown, dir: string): unknown =>
  saveStoreJanitorConfig(
    { mode: "on" },
    scope as Parameters<typeof saveStoreJanitorConfig>[1],
    dir,
  );
const STORE_SETTINGS =
  (settings: Parameters<typeof saveStoreJanitorConfig>[0]) =>
  (dir: string): unknown =>
    saveStoreJanitorConfig(settings, "project", dir);

const SITES: readonly Site[] = [
  { label: "lens bridge mode", offending: "nope", trigger: (dir) => LENS_MODE("nope", dir) },
  { label: "lens bridge scope", offending: "mars", trigger: (dir) => LENS_SCOPE("mars", dir) },
  {
    label: "bash view mode",
    offending: "sometimes",
    trigger: (dir) => BASH_VIEW_MODE("sometimes", dir),
  },
  { label: "bash view scope", offending: "mars", trigger: (dir) => BASH_VIEW_SCOPE("mars", dir) },
  { label: "config scope", offending: "mars", trigger: (dir) => STORE_SCOPE("mars", dir) },
  {
    label: "store janitor mode",
    offending: "maybe",
    trigger: STORE_SETTINGS({ mode: "maybe" as never }),
  },
  {
    label: "store janitor interval",
    offending: "1.5",
    trigger: STORE_SETTINGS({ intervalMs: 1.5 }),
  },
  {
    label: "store janitor batch size",
    offending: "-1",
    trigger: STORE_SETTINGS({ batchSize: -1 }),
  },
];

describe("config setter enum guards (Issue #94)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pi-config-guard-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  for (const site of SITES) {
    it(`${site.label} fails as an internal invariant with no payload remedy and writes nothing`, () => {
      let caught: unknown;
      try {
        site.trigger(projectDir);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      const error = caught as { code: string; message: string; payload: { message: string } };
      expect(error.code).toBe("E_INTERNAL_INVARIANT");
      // WHY: the rendered envelope is what a reader (or a host) actually sees, so both the envelope
      // WHY: and the payload text are checked — and the offending value must survive in it, or the
      // WHY: failure would name no cause at all.
      expect(error.message).toContain(
        "[MODEL] [E_INTERNAL_INVARIANT] An internal invariant failed: ",
      );
      expect(error.message).toContain(site.offending);
      expect(error.message).not.toContain("payload");
      expect(error.message).not.toContain(PAYLOAD_REMEDY);
      expect(error.message).not.toMatch(IMPERATIVE);
      expect(error.payload.message).toContain(site.offending);
      expect(error.payload.message).not.toContain(PAYLOAD_REMEDY);
      expect(error.payload.message).not.toMatch(IMPERATIVE);
      expect(readdirSync(projectDir)).toEqual([]);
    });
  }
});
