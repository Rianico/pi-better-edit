import { describe, expect, it } from "vitest";
import {
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
} from "fs/promises";
import { join } from "path";
import { resolveTarget, writeAtomic } from "../../src/fs-write";
import { withTempDir } from "../support/fixtures";


describe("resolveTarget — file symlinks", () => {
  it("resolves a path where the final component is a symlink to a file", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const realFile = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      await writeFile(realFile, "data");
      await symlink(realFile, link);
      const resolved = await resolveTarget(link);
      expect(resolved).toBe(realFile);
    });
  });
});

describe("resolveTarget — relative and .. symlink targets", () => {
  it("resolves a symlink with a relative target (same directory)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const realFile = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      await writeFile(realFile, "data");
      await symlink(realFile, link);
      const resolved = await resolveTarget(link);
      expect(resolved).toBe(realFile);
    });
  });

  it("resolves a symlink with a relative target (parent directory)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const sub = join(dir, "sub");
      const realFile = join(dir, "real.txt");
      const link = join(sub, "link.txt");
      await mkdir(sub);
      await writeFile(realFile, "data");
      await symlink(realFile, link);
      const resolved = await resolveTarget(link);
      expect(resolved).toBe(realFile);
    });
  });

  it("resolves a symlink with .. components in the target", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const deep = join(dir, "a", "b", "c");
      const realFile = join(dir, "a", "target.txt");
      const link = join(deep, "link.txt");
      await mkdir(deep, { recursive: true });
      await writeFile(realFile, "data");
      await symlink("../../target.txt", link);
      const resolved = await resolveTarget(link);
      expect(resolved).toBe(realFile);
    });
  });
});

describe("resolveTarget — path edge cases", () => {
  it("resolves root path /", async () => {
    const resolved = await resolveTarget("/");
    expect(resolved).toBe("/");
  });

  it("resolves a path with trailing slash", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const filePath = join(dir, "file.txt");
      await writeFile(filePath, "data");
      const resolved = await resolveTarget(filePath + "/");
      expect(resolved).toBe(filePath);
    });
  });

  it("resolves a path with only a filename (no directory components)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const filePath = join(dir, "standalone.txt");
      await writeFile(filePath, "data");
      const resolved = await resolveTarget(filePath);
      expect(resolved).toBe(filePath);
    });
  });

  it("resolves a dangling symlink (target does not exist)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const link = join(dir, "dangling");
      const missingTarget = join(dir, "nonexistent");
      await symlink(missingTarget, link);
      const resolved = await resolveTarget(link);
      expect(resolved).toBe(missingTarget);
    });
  });

  it("resolves a path with multiple consecutive symlinks in a chain", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const real = join(dir, "real");
      const link1 = join(dir, "link1");
      const link2 = join(dir, "link2");
      const link3 = join(dir, "link3");
      await mkdir(real);
      await symlink(real, link1);
      await symlink(link1, link2);
      await symlink(link2, link3);
      await writeFile(join(real, "x.txt"), "data");
      const resolved = await resolveTarget(join(link3, "x.txt"));
      expect(resolved).toBe(join(real, "x.txt"));
    });
  });

  it("throws ELOOP on a 3-node circular symlink", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      const c = join(dir, "c");
      await symlink(b, a);
      await symlink(c, b);
      await symlink(a, c);
      await expect(resolveTarget(join(a, "x.txt"))).rejects.toThrow(
        /Too many symbolic links/,
      );
    });
  });
});


describe("writeAtomic — file symlink target", () => {
  it("writes through a file symlink (final component is a symlink)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const realFile = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      await writeFile(realFile, "original");
      await symlink(realFile, link);
      await writeAtomic(link, "updated");
      const content = await readFile(realFile, "utf-8");
      expect(content).toBe("updated");
    });
  });

  it("writes through a chain of symlinks to the real file", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const realFile = join(dir, "real.txt");
      const link1 = join(dir, "link1.txt");
      const link2 = join(dir, "link2.txt");
      await writeFile(realFile, "original");
      await symlink(realFile, link1);
      await symlink(link1, link2);
      await writeAtomic(link2, "updated");
      const content = await readFile(realFile, "utf-8");
      expect(content).toBe("updated");
    });
  });
});

describe("writeAtomic — hard-linked file edge cases", () => {
  it("writes to a hard-linked file in-place when nlink > 1", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const { link } = await import("fs/promises");
      const original = join(dir, "original.txt");
      const hardlink = join(dir, "hardlink.txt");
      await writeFile(original, "shared content");
      await link(original, hardlink);
      await writeAtomic(original, "updated shared");
      const content1 = await readFile(original, "utf-8");
      const content2 = await readFile(hardlink, "utf-8");
      expect(content1).toBe("updated shared");
      expect(content2).toBe("updated shared");
    });
  });

  it("uses atomic write (not in-place) when nlink === 1", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const filePath = join(dir, "single.txt");
      await writeFile(filePath, "original");
      const statsBefore = await stat(filePath);
      expect(statsBefore.nlink).toBe(1);
      await writeAtomic(filePath, "updated");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("updated");
    });
  });
});

describe("writeAtomic — directory symlink target", () => {
  it("creates a new file inside a directory reached through a symlink", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const realDir = join(dir, "real");
      const linkDir = join(dir, "link");
      await mkdir(realDir);
      await symlink(realDir, linkDir);
      const filePath = join(linkDir, "new.txt");
      await writeAtomic(filePath, "content");
      const content = await readFile(join(realDir, "new.txt"), "utf-8");
      expect(content).toBe("content");
    });
  });
});

describe("writeAtomic — large and binary content", () => {
  it("writes a large file", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const filePath = join(dir, "large.txt");
      const line = "x".repeat(1000);
      const content = Array.from({ length: 1000 }, (_, i) => `${line}${i}`).join("\n");
      await writeAtomic(filePath, content);
      const read = await readFile(filePath, "utf-8");
      expect(read).toBe(content);
      expect(read.length).toBe(content.length);
    });
  });

  it("writes content with null bytes (binary-like)", async () => {
    await withTempDir("fs-write-edge-", async (dir) => {
      const filePath = join(dir, "binary.bin");
      const content = "abc\0def\0ghi";
      await writeAtomic(filePath, content);
      const read = await readFile(filePath, "utf-8");
      expect(read).toBe(content);
    });
  });
});

describe("writeAtomic — stale temp file sweep", () => {
  it("removes its own stale UUID temp files but never user files with a .tmp- prefix", async () => {
    await withTempDir("fs-write-sweep-", async (dir) => {
      const stale = join(dir, ".tmp-12345678-1234-1234-1234-123456789abc");
      const fresh = join(dir, ".tmp-fedcba98-7654-4321-8765-abcdefabcdef");
      const userFile = join(dir, ".tmp-user-notes");
      await writeFile(stale, "leftover");
      await writeFile(fresh, "leftover");
      await writeFile(userFile, "precious");
      const { utimes } = await import("fs/promises");
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(stale, oldTime, oldTime);
      await utimes(userFile, oldTime, oldTime);

      await writeAtomic(join(dir, "target.txt"), "content");

      await expect(readFile(stale, "utf-8")).rejects.toThrow();
      await expect(readFile(fresh, "utf-8")).resolves.toBe("leftover");
      await expect(readFile(userFile, "utf-8")).resolves.toBe("precious");
      await expect(readFile(join(dir, "target.txt"), "utf-8")).resolves.toBe(
        "content",
      );
    });
  });

  it("does not remove fresh temp files from concurrent writers", async () => {
    await withTempDir("fs-write-sweep-", async (dir) => {
      const fresh = join(dir, ".tmp-abcdefab-cdef-1234-5678-abcdefabcdef");
      await writeFile(fresh, "in progress");

      await writeAtomic(join(dir, "target.txt"), "content");

      await expect(readFile(fresh, "utf-8")).resolves.toBe("in progress");
    });
  });

  it("leaves unrelated dotfiles untouched", async () => {
    await withTempDir("fs-write-sweep-", async (dir) => {
      const dotfile = join(dir, ".gitignore");
      await writeFile(dotfile, "node_modules");
      const { utimes } = await import("fs/promises");
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(dotfile, oldTime, oldTime);

      await writeAtomic(join(dir, "target.txt"), "content");

      await expect(readFile(dotfile, "utf-8")).resolves.toBe("node_modules");
    });
  });
});
