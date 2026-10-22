import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../src/host/host";
import { guardWrites, isReadOnly, ReadOnlyFolder } from "../src/app/read-only";
import { PositionKeeper } from "../src/app/positions";
import { ReadingKeeper } from "../src/app/reading";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";
import { BookText } from "../src/core/reading/booktext";
import type { Position } from "../src/core/types";

// What the iPhone's Files app answers for a share it reaches read-only (seen on the SE).
const EROFS = "failed to open file at path: /share/books/.ribbon/positions/a.csv with error: Read-only file system (os error 30)";

/** A host whose writes fail with `fails` while it is set, and which counts what reached it. */
function fakeHost() {
  const writes: string[] = [];
  let fails: string | null = null;
  const write = async (path: string) => {
    writes.push(path);
    if (fails) throw new Error(fails);
  };
  const host = {
    readFile: async () => new TextEncoder().encode("kept"),
    writeFile: write,
    mkdir: write,
    remove: write,
    rename: async (from: string) => write(from),
  } as unknown as Host;
  return {
    host,
    writes,
    fail(message: string | null) {
      fails = message;
    },
  };
}

describe("isReadOnly", () => {
  it("knows a folder that cannot be written from here", () => {
    expect(isReadOnly(new Error(EROFS))).toBe(true);
    expect(isReadOnly(new Error("The media is write protected. (os error 19)"))).toBe(true);
    expect(isReadOnly(new ReadOnlyFolder("/share/books"))).toBe(true);
  });

  it("does not take a share that is away for a moment for one that is read-only", () => {
    expect(isReadOnly(new Error("the network name cannot be found"))).toBe(false);
    expect(isReadOnly(new Error("Access is denied. (os error 5)"))).toBe(false);
  });
});

describe("guardWrites", () => {
  it("says so once, and writes inside the folder no more", async () => {
    const f = fakeHost();
    const onReadOnly = vi.fn();
    const host = guardWrites(f.host, "/share/books", onReadOnly);
    f.fail(EROFS);
    await expect(host.writeFile("/share/books/.ribbon/positions/a.csv", new Uint8Array())).rejects.toBeInstanceOf(ReadOnlyFolder);
    expect(onReadOnly).toHaveBeenCalledTimes(1);
    // From now on a write inside the folder fails at once, without going to the share.
    await expect(host.mkdir("/share/books/.ribbon/covers")).rejects.toBeInstanceOf(ReadOnlyFolder);
    await expect(host.rename("/share/books/.ribbon/a", "/share/books/.ribbon/b")).rejects.toBeInstanceOf(ReadOnlyFolder);
    expect(f.writes).toEqual(["/share/books/.ribbon/positions/a.csv"]);
    expect(onReadOnly).toHaveBeenCalledTimes(1);
  });

  it("lets reads, and writes outside the folder, through", async () => {
    const f = fakeHost();
    const host = guardWrites(f.host, "/share/books/", () => undefined);
    f.fail(EROFS);
    await expect(host.writeFile("/share/books/.ribbon/a.csv", new Uint8Array())).rejects.toBeInstanceOf(ReadOnlyFolder);
    f.fail(null);
    expect(new TextDecoder().decode(await host.readFile("/share/books/a.m4b"))).toBe("kept");
    // This device's mirror, and a folder whose name only starts the same way.
    await host.writeFile("/Users/me/Library/Ribbon/mirror/positions.csv", new Uint8Array());
    await host.mkdir("/share/books2/.ribbon");
    expect(f.writes.slice(1)).toEqual(["/Users/me/Library/Ribbon/mirror/positions.csv", "/share/books2/.ribbon"]);
  });

  it("passes a share that is away for a moment through as it is", async () => {
    const f = fakeHost();
    const onReadOnly = vi.fn();
    const host = guardWrites(f.host, "/share/books", onReadOnly);
    f.fail("the network name cannot be found");
    await expect(host.writeFile("/share/books/.ribbon/a.csv", new Uint8Array())).rejects.toThrow("the network name cannot be found");
    f.fail(null);
    await host.writeFile("/share/books/.ribbon/a.csv", new Uint8Array());
    expect(f.writes).toHaveLength(2);
    expect(onReadOnly).not.toHaveBeenCalled();
  });
});

describe("a read-only folder's places", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("are kept on this machine, and the share is not tried again", async () => {
    const local: Position[][] = [];
    const tries: number[] = [];
    const logs: string[] = [];
    const k = new PositionKeeper(
      {
        local: async (all) => void local.push(all),
        share: async (p) => {
          tries.push(p.offsetMs);
          throw new ReadOnlyFolder("/share/books");
        },
        log: (m) => void logs.push(m),
      },
      { retryDelayMs: () => 1_000 },
    );
    k.record({ bookId: "a", offsetMs: 42_000, updatedAt: new Date().toISOString(), device: "phone" }, true);
    await vi.advanceTimersByTimeAsync(100);
    k.record({ bookId: "a", offsetMs: 43_000, updatedAt: new Date().toISOString(), device: "phone" }, true);
    // A minute of playing, then the app closing: nothing more goes to the share.
    await vi.advanceTimersByTimeAsync(60_000);
    await k.flush();
    expect(tries).toEqual([42_000]);
    expect(k.status()).toMatchObject({ readOnly: true, pendingShare: 1 });
    expect(local.at(-1)![0]!.offsetMs).toBe(43_000);
    expect(logs.filter((l) => l.includes("read-only"))).toHaveLength(1);
  });

  it("while reading, are kept on this machine without trying the share again", async () => {
    const book: Ebook = {
      format: EBOOK_FORMAT,
      meta: { title: "T", authors: [], identifiers: [] },
      layout: "reflowable",
      sections: [{ href: "one.xhtml", linear: true, overlay: null, chars: 60, blocks: [{ k: "p", runs: [{ t: "It was a giant circle of wraithbone, five miles across it." }] }] }],
      toc: [],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let tries = 0;
    const kept: string[] = [];
    const k = new ReadingKeeper(new BookText(book), { section: 0, block: 0, offset: 0 }, {
      keepLocal: (place) => void kept.push(place.loc.text!.highlight!.split(" ")[0]!),
      share: async () => {
        tries++;
        throw new ReadOnlyFolder("/share/books");
      },
    });
    k.move({ section: 0, block: 0, offset: 9 }, "seek");
    await k.flush();
    // Nothing is held for another try, and nothing is said about it: the library has said it once.
    await k.flush();
    expect(tries).toBe(1);
    expect(kept).toEqual(["giant"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
