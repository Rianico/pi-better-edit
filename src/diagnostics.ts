/**
 * The extension's ONLY diagnostic sink.
 *
 * WHY this exists at all: the extension runs inside Pi's process, and that process owns the
 * terminal through a differential renderer (`pi-tui` main screen): it tracks the hardware cursor
 * row and the lines it last painted, and repaints only what it believes changed. A write to
 * stdout/stderr therefore lands at whatever cursor position the frame happens to occupy — the text
 * is splatted across unrelated rows, interleaved with the UI, and erased by the next paint. It is
 * also uncopyable: by the time a selection starts, the renderer has rewritten the cells. That is
 * exactly how `console.error("Bash view interception failed:", error)` surfaced: a stack trace
 * smeared over the view, gone when you tried to select it.
 *
 * WHY the file lives in `configDir()` and nowhere else: `PI_BETTER_EDIT_CONFIG_DIR` is already the
 * single operator-owned base directory for everything this extension persists (the store, its WAL,
 * its janitor's bookkeeping). A second base (XDG_STATE_HOME, a log dir, `~/Library/Logs`) would be
 * a second precedence ladder to document and a second seam to isolate in tests. One directory, one
 * override, one rule: `<configDir>/diagnostics.log`, rotated to `<configDir>/diagnostics.log.1`.
 *
 * WHY JSONL and not prose: the records carry stack traces, and a stack trace in prose needs either
 * multi-line records (unparseable) or escaped newlines (unreadable). One JSON object per line is
 * both — `jq -r '.error.stack[]'` prints a normal trace, `grep` still finds a line by message.
 *
 * WHY synchronous appends: a record is written at most once per failure, and a synchronous append
 * keeps records ordered and never floats a promise that an exit could drop. The cost is paid on
 * failure paths only, never on the happy path.
 *
 * WHY nothing here may throw: this is the last resort of a best-effort hook. A diagnostic sink that
 * can fail its caller turns "the view passed through" into "the tool call errored" — the very
 * failure it exists to make visible. Every entry point swallows its own I/O errors.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config-dir.js";

type DiagnosticLevel = "error" | "warn" | "info";

/** Fixed file name inside `configDir()`; exported so the status display and tests agree on it. */
export const DIAGNOSTICS_LOG_NAME = "diagnostics.log";

/**
 * WHY 1 MiB: a rotated pair of these is small enough to attach to a bug report whole, and a failing
 * hook that fires once per tool call still needs ~thousands of records to reach it.
 */
export const DIAGNOSTICS_LOG_MAX_BYTES = 1024 * 1024;

/** Record bounds: a stack with 12 frames is enough to name the throw site; a longer one is noise. */
const MAX_STACK_FRAMES = 12;
const MAX_TEXT_CHARS = 2_000;

interface DiagnosticRecord {
  readonly ts: string;
  readonly level: DiagnosticLevel;
  readonly scope: string;
  readonly message: string;
  readonly error?: {
    readonly name: string;
    readonly code?: string;
    readonly message: string;
    readonly stack: readonly string[];
  };
  readonly context?: Record<string, unknown>;
  readonly pid: number;
}

/** `<configDir>/diagnostics.log` — the sibling of `hash-store.sqlite`. */
export function diagnosticsLogPath(): string {
  // SAFETY: join of trusted configDir with a fixed file name — constant suffix, no traversal.
  return join(configDir(), DIAGNOSTICS_LOG_NAME);
}

/**
 * Size and recency of the log, for `/pi-better-edit` status. Never throws: an absent log is a
 * legitimate state ("no diagnostics recorded") and a stat failure says nothing about the renderer.
 */
export function diagnosticsLogStatus(): { path: string; bytes: number; modifiedAt?: Date } {
  const path = diagnosticsLogPath();
  try {
    const info = statSync(path);
    return { path, bytes: info.size, modifiedAt: info.mtime };
  } catch {
    return { path, bytes: 0 };
  }
}

/**
 * Report a failure. `args` are joined for the message, and a trailing `Error` is recorded (name,
 * code, message, truncated stack) instead of being stringified. Mirrors `console.error(a, b, err)`
 * so a migrated call site keeps its wording verbatim.
 */
export function reportDiagnostic(scope: string, ...args: unknown[]): void {
  write("error", scope, args);
}

/** A degraded-but-working path (a store quarantined and rebuilt, a config value ignored). */
export function reportWarning(scope: string, ...args: unknown[]): void {
  write("warn", scope, args);
}

/** A one-off notice worth keeping, e.g. the first "bash view intercepted" hint. */
export function reportInfo(scope: string, ...args: unknown[]): void {
  write("info", scope, args);
}

function write(level: DiagnosticLevel, scope: string, args: readonly unknown[]): void {
  try {
    const error = [...args].reverse().find((arg) => arg instanceof Error) as Error | undefined;
    const message = args
      .filter((arg) => arg !== error)
      .map((arg) => describe(arg))
      .join(" ")
      .trim();
    const record = buildRecord(level, scope, message === "" ? "reported" : message, error);
    const line = `${JSON.stringify(record)}\n`;
    appendRecord(line);
  } catch {
    // SAFETY: last resort — losing a diagnostic must never fail the caller (see the module WHY).
  }
}

function buildRecord(
  level: DiagnosticLevel,
  scope: string,
  message: string,
  error: Error | undefined,
): DiagnosticRecord {
  const context = contextOf(error);
  const code = error === undefined ? undefined : errorCode(error);
  return {
    ts: new Date().toISOString(),
    level,
    scope,
    message: truncate(message, MAX_TEXT_CHARS),
    ...(error === undefined
      ? {}
      : {
          error: {
            name: error.name,
            ...(code === undefined ? {} : { code }),
            message: truncate(error.message, MAX_TEXT_CHARS),
            stack: stackFrames(error),
          },
        }),
    ...(context === undefined ? {} : { context }),
    pid: process.pid,
  };
}

/**
 * WHY `DomainError` fields are lifted into the context: those codes are the extension's own
 * vocabulary (`[MODEL] [E_NOT_FOUND] …`), and a reader looking for "what was refused, and why"
 * should not have to re-parse the message.
 */
function contextOf(error: Error | undefined): Record<string, unknown> | undefined {
  if (error === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  const maybe = error as { code?: unknown; audience?: unknown; details?: unknown };
  if (typeof maybe.audience === "string") fields["audience"] = maybe.audience;
  if (maybe.details !== undefined) fields["details"] = maybe.details;
  return Object.keys(fields).length === 0 ? undefined : fields;
}

function errorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function stackFrames(error: Error): string[] {
  const stack = error.stack;
  if (stack === undefined) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => truncate(line, MAX_TEXT_CHARS));
}

function appendRecord(line: string): void {
  const path = diagnosticsLogPath();
  // SAFETY: mkdir of a path derived from the operator-owned configDir with a constant suffix.
  mkdirSync(dirname(path), { recursive: true });
  rotateIfOversize(path, Buffer.byteLength(line, "utf-8"));
  appendFileSync(path, line, "utf-8");
}

/**
 * WHY one generation: the purpose of the file is "the error that just happened", and a single
 * predecessor keeps the newest record while bounding the directory. Rotation happens BEFORE the
 * append, so a single oversized record still lands in a fresh file.
 */
function rotateIfOversize(path: string, incomingBytes: number): void {
  let current = 0;
  try {
    current = statSync(path).size;
  } catch {
    // WHY: an absent log is the first-run state, not a fault — there is nothing to rotate.
    return;
  }
  if (current + incomingBytes <= DIAGNOSTICS_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
