import { describe, expect, it, vi } from "vitest";
import { reopenedOnIos } from "../src/app/platform";
import type { SourceEntry } from "../src/core/sources";

const listed: SourceEntry[] = [
  { root: "/private/var/mobile/Library/LiveFiles/smb/books", addedAt: "2026-10-20T00:00:00.000Z" },
  { root: "/private/var/mobile/Containers/Shared/AppGroup/a/File Provider Storage/Kept", addedAt: "2026-10-21T00:00:00.000Z" },
];

describe("reopening the chosen folders on iOS", () => {
  it("follows a folder that is somewhere else now, and saves where", async () => {
    const written: SourceEntry[][] = [];
    const now = "/private/var/mobile/Containers/Shared/AppGroup/b/File Provider Storage/Kept";
    const list = await reopenedOnIos(listed, async () => [{ was: listed[1]!.root, now }], async (l) => void written.push(l));
    expect(list.map((s) => s.root)).toEqual([listed[0]!.root, now]);
    expect(list[1]!.addedAt).toBe(listed[1]!.addedAt);
    expect(written).toEqual([list]);
  });

  it("leaves a folder that is out of reach as it was, and writes nothing", async () => {
    let wrote = false;
    const list = await reopenedOnIos(listed, async () => [{ was: listed[0]!.root, now: null }], async () => void (wrote = true));
    expect(list).toEqual(listed);
    expect(wrote).toBe(false);
  });

  it("opens the list as it was when the folders cannot be reopened at all", async () => {
    // The warning is the point, so it is caught here rather than printed: printed as the file ends, it raced vitest's shutdown on Windows.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = await reopenedOnIos(
      listed,
      async () => {
        throw new Error("no plugin");
      },
      async () => undefined,
    );
    expect(list).toEqual(listed);
    expect(warn).toHaveBeenCalledWith("ribbon:", "could not open the remembered folders again:", "Error: no plugin");
    warn.mockRestore();
  });
});
