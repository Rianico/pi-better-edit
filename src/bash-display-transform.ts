import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DisplayTransform } from "./bash-classifier.js";

const execFileAsync = promisify(execFile);

/**
 * WHY: (ADR-0048 D2) the transform is a closed display set. The re-run is the oracle: the same
 * executable and flags run on a temporary copy of the exact raw head bytes, so platform-specific
 * `od`/`xxd`/`hexdump` layouts cannot drift between what bash printed and what this proves.
 * `cat -A` is GNU-only; `cat -vet` is the BSD/GNU-portable equivalent. A missing command, a
 * timeout, or over-budget output returns undefined and the serve seam passes the whole command
 * through raw with zero leases.
 */
const COMMANDS: Record<DisplayTransform["kind"], readonly [string, ...string[]]> = {
  "cat-A": ["cat", "-A"],
  "cat-vet": ["cat", "-vet"],
  "od-c": ["od", "-c"],
  xxd: ["xxd"],
  "hexdump-C": ["hexdump", "-C"],
};

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

export async function runDisplayTransform(
  transform: DisplayTransform,
  input: string,
): Promise<string | undefined> {
  const [program, ...args] = COMMANDS[transform.kind];
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-bash-display-"));
    const file = join(dir, "slice");
    await writeFile(file, input);
    const { stdout } = await execFileAsync(program, [...args, file], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: TIMEOUT_MS,
    });
    return stdout;
  } catch {
    return undefined;
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
