/**
 * pi-lens bridge configuration — the on-disk `lens.bridge` setting and its precedence ladder.
 *
 * WHY a seam: the mode is read on every served-row notification and written only by the
 * `/pi-better-edit` command, so both sides must agree on one ladder — env, then project file,
 * then global file, then the `auto` default. A malformed config is never an error: it degrades
 * to "not configured" so a hand-edited file can never break editing.
 *
 * Shape of `.pi/agents/pi-better-edit.json`:
 * `{ "$schema": <LENS_SCHEMA_ID>, "lens": { "bridge": "auto" | "on" | "off" } }`
 * (documented by `schemas/pi-better-edit.json`). Unknown keys are preserved on write.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DomainError } from "../../domain-errors.js";

export type LensBridgeMode = "auto" | "on" | "off";
export type LensBridgeScope = "project" | "global";

/** Environment override; wins over both files. Values outside the enum are ignored, not fatal. */
export const LENS_BRIDGE_ENV_VAR = "PI_BETTER_EDIT_LENS_BRIDGE";

/** Config location relative to the project root or to the home directory. */
export const LENS_CONFIG_REL = ".pi/agents/pi-better-edit.json";

/** Published schema id written into config files (see `schemas/pi-better-edit.json`). */
export const LENS_SCHEMA_ID =
  "https://github.com/Rianico/pi-better-edit/schemas/pi-better-edit.json";

const LENS_BRIDGE_MODES: readonly LensBridgeMode[] = ["auto", "on", "off"];
const LENS_BRIDGE_SCOPES: readonly LensBridgeScope[] = ["project", "global"];

/** Runtime guard for values arriving from files, env vars and command arguments. */
export function isLensBridgeMode(value: unknown): value is LensBridgeMode {
  return typeof value === "string" && LENS_BRIDGE_MODES.some((mode) => mode === value);
}

/** Runtime guard for the two config scopes. */
export function isLensBridgeScope(value: unknown): value is LensBridgeScope {
  return typeof value === "string" && LENS_BRIDGE_SCOPES.some((scope) => scope === value);
}

/** SAFETY: HOME wins over homedir() because pi runs the extension with the user's shell env; an
 * empty HOME counts as unset. Mirrors the `homeBase` convention in `src/paths.ts`. */
function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome !== undefined && envHome.length > 0 ? envHome : homedir();
}

function lensConfigPath(scope: LensBridgeScope, cwd: string): string {
  return scope === "global" ? join(homeBase(), LENS_CONFIG_REL) : join(cwd, LENS_CONFIG_REL);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing, unreadable and unparseable all read as "no config object" — never a throw. */
function readConfigObject(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // SAFETY: an absent or unreadable config means "not configured", so the caller falls through the
    // SAFETY: precedence ladder; a permissions error must not break the tool that reads the mode.
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // SAFETY: a hand-edited file can be unparseable mid-write; reading it as "not configured" keeps
    // SAFETY: the read total and lets the next save rewrite the file from the canonical shape.
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function readScopeMode(path: string): LensBridgeMode | undefined {
  const config = readConfigObject(path);
  if (config === undefined) return undefined;
  const lens = config.lens;
  if (!isRecord(lens)) return undefined;
  return isLensBridgeMode(lens.bridge) ? lens.bridge : undefined;
}

/**
 * Both scopes' configured modes. Pure read: never creates the directory or the file, never
 * throws. A scope is absent (rather than `undefined`-valued) when its file is missing or holds a
 * value outside the enum.
 */
export function readLensBridgeConfig(cwd: string): {
  project?: LensBridgeMode;
  global?: LensBridgeMode;
} {
  const project = readScopeMode(lensConfigPath("project", cwd));
  const global = readScopeMode(lensConfigPath("global", cwd));
  return {
    ...(project !== undefined ? { project } : {}),
    ...(global !== undefined ? { global } : {}),
  };
}

function readEnvMode(): LensBridgeMode | undefined {
  const raw = process.env[LENS_BRIDGE_ENV_VAR];
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return isLensBridgeMode(normalized) ? normalized : undefined;
}

/** Effective mode: env override, then project, then global, then `"auto"`. Never throws. */
export function resolveEffectiveLensMode(cwd: string): LensBridgeMode {
  const fromEnv = readEnvMode();
  if (fromEnv !== undefined) return fromEnv;
  const config = readLensBridgeConfig(cwd);
  return config.project ?? config.global ?? "auto";
}

/**
 * Persist `mode` for `scope`, preserving unknown top-level keys and other `lens.*` keys already
 * in the file. Creates the directory as needed and replaces the file atomically (sibling temp
 * file + rename, same filesystem). Throws `E_BAD_PAYLOAD` for a mode or scope outside the enum.
 */
export function saveLensBridgeConfig(
  mode: LensBridgeMode,
  scope: LensBridgeScope,
  cwd: string,
): { path: string } {
  if (!isLensBridgeMode(mode)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Unknown lens bridge mode "${String(mode)}". Pass auto, on or off and retry.`,
    });
  }
  if (!isLensBridgeScope(scope)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `Unknown lens bridge scope "${String(scope)}". Pass project or global and retry.`,
    });
  }

  const path = lensConfigPath(scope, cwd);
  const existing = readConfigObject(path) ?? {};
  // WHY: only `lens.bridge` is ours to set — an existing `$schema` is a deliberate editor-time
  // WHY: choice and unknown top-level or `lens.*` keys belong to the user, so all of them survive.
  const existingSchema = existing.$schema;
  const next = {
    ...existing,
    $schema:
      typeof existingSchema === "string" && existingSchema.length > 0
        ? existingSchema
        : LENS_SCHEMA_ID,
    lens: { ...(isRecord(existing.lens) ? existing.lens : {}), bridge: mode },
  };

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // SAFETY: the temp file is a sibling of the target inside the directory just created (same
  // SAFETY: filesystem), so renameSync replaces the target atomically; the pid suffix keeps
  // SAFETY: concurrent writers from clobbering each other's staging file.
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    renameSync(tempPath, path);
  } catch (error: unknown) {
    try {
      unlinkSync(tempPath);
    } catch {
      // SAFETY: best-effort cleanup after a failed write — the original error is the actionable one,
      // SAFETY: and an orphaned .tmp-<pid> sibling is inert.
    }
    throw error;
  }

  return { path };
}
