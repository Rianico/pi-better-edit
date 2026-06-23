import { beforeEach, describe, expect, it, vi } from "vitest";

const rmMock = vi.fn(async () => undefined);
const renameMock = vi.fn(async () => undefined);
const openMock = vi.fn(async () => ({
  writeFile: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));
const mkdirMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100644, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readlink: readlinkMock,
  rename: renameMock,
  rm: rmMock,
  stat: statMock,
}));

describe("writeAtomic temp-file cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameMock.mockResolvedValue(undefined);
  });

  it("removes the temp file when rename fails", async () => {
    renameMock.mockRejectedValue(new Error("rename failed"));

    const { writeAtomic } = await import("../../src/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "rename failed",
    );

    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
      { force: true },
    );
  });

  it("does not call rm when rename succeeds", async () => {
    const { writeAtomic } = await import("../../src/fs-write");

    await writeAtomic("/tmp/target.txt", "content");

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(rmMock).not.toHaveBeenCalled();
  });
});
