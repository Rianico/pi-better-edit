import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { writeFileAtomically } from "../../src/fs-write";

// These tests exercise the real filesystem (no fs/promises mocking) to cover the
// new-file branch of writeFileAtomically, which the mocked permissions test
// skips by always returning an existing stat. They lock the current behavior;
// revisit if umask-honoring new-file modes are desired.

async function makeTempDir(): Promise<string> {
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "pi-hashline-perm-"));
}

describe("writeFileAtomically — new-file mode", () => {
  it("creates a new file with mode 0o600 (owner-only), independent of umask", async () => {
    // open(temp, "wx", 0o600) creates the temp file at 0o600 and the new-file
    // path has no existingStats, so no chmod fallback runs. 0o600 has only owner
    // bits, so umask cannot clear any of them — the result is 0o600 regardless of
    // the process umask.
    const dir = await makeTempDir();
    try {
      const target = join(dir, "fresh.txt");
      await writeFileAtomically(target, "hello\n");
      const stats = await stat(target);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an existing file's mode across an atomic rewrite", async () => {
    const dir = await makeTempDir();
    try {
      const target = join(dir, "exists.txt");
      await writeFile(target, "old\n");
      // Force a known, deterministic mode (writeFile applies umask) so the
      // preservation assertion is stable regardless of the host umask.
      await chmod(target, 0o644);
      expect((await stat(target)).mode & 0o777).toBe(0o644);

      await writeFileAtomically(target, "new\n");
      const stats = await stat(target);
      expect(stats.mode & 0o777).toBe(0o644);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});