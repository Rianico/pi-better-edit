import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { writeAtomic } from "../../src/fs-write";

const isWindows = process.platform === "win32";

async function makeTempDir(): Promise<string> {
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "pi-hashline-perm-"));
}

describe.skipIf(isWindows)("writeAtomic — new-file mode", () => {
  it("creates a new file with mode 0o600 (owner-only), independent of umask", async () => {

    const dir = await makeTempDir();
    try {
      const target = join(dir, "fresh.txt");
      await writeAtomic(target, "hello\n");
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

      await chmod(target, 0o644);
      expect((await stat(target)).mode & 0o777).toBe(0o644);

      await writeAtomic(target, "new\n");
      const stats = await stat(target);
      expect(stats.mode & 0o777).toBe(0o644);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
