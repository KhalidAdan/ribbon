import { afterAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type Platform } from "../src/app/controller";
import { LibraryService } from "../src/app/library";
import { memorySources } from "../src/app/platform";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

// The app logs as it works, and the controllers here carry on after the test (a scan asked for during another runs
// once more after it, covers, chapter probes): a line logged once vitest has closed the file fails the run, though
// every test passed (#224). The log isn't what's tested here, so it's kept quiet for the life of the file.
vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

function platform(root: string): Platform {
  return { host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
}

describe("hand edits through the app", () => {
  afterAll(async () => {
    await fs.rm(path.join(FIXTURE_ROOT, ".ribbon", "edits"), { recursive: true, force: true });
    await fs.rm(path.join(FIXTURE_ROOT, ".ribbon", "covers"), { recursive: true, force: true });
  });

  it("an edit shows at once, survives a rescan and a fresh start, and comes back off field by field", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    await c.pickLibrary();
    const target = c.getState().books.find((b) => b.book.path === "single-m4b")!;
    const id = target.book.id;
    const filesTitle = target.book.title;

    await c.saveEdits(id, { title: "A Better Title", narrator: "Someone Real", series: "Hand Series", seriesIndex: "2" });
    let b = c.getState().books.find((x) => x.book.id === id)!;
    expect(b.book.title).toBe("A Better Title");
    expect(b.book.narrator).toBe("Someone Real");
    expect(b.book.seriesIndex).toBe(2);
    expect(b.original?.title).toBe(filesTitle);

    await c.rescan(true);
    b = c.getState().books.find((x) => x.book.id === id)!;
    expect(b.book.title).toBe("A Better Title");

    const again = new AppController(platform(FIXTURE_ROOT));
    await again.pickLibrary();
    expect(again.getState().books.find((x) => x.book.id === id)!.book.title).toBe("A Better Title");

    await again.setCover(id, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "jpg");
    expect(again.getState().books.find((x) => x.book.id === id)!.book.cover).toMatch(/^\.ribbon\/covers\/edited-/);

    await again.resetEdits(id, "title");
    b = again.getState().books.find((x) => x.book.id === id)!;
    expect(b.book.title).toBe(filesTitle);
    expect(b.book.narrator).toBe("Someone Real");

    await again.resetEdits(id);
    b = again.getState().books.find((x) => x.book.id === id)!;
    expect(b.book.narrator).toBe(target.book.narrator);
    expect(b.original).toBeUndefined();
    expect(b.book.cover).toBe(target.book.cover);
    c.destroy();
    again.destroy();
  });

  it("keeps a save made while every edits file is being read back, over the older file the read had found", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    await c.pickLibrary();
    const id = c.getState().books.find((b) => b.book.path === "single-m4b")!.book.id;
    // A scan reads the edits twice: with its records, and again when it is done, to lay them over the books it found.
    // That last read finds the files as they are, then is held, as a slow disk or a share would hold it, while the
    // book is saved. Before readEdits, it then laid the file it had found over the save, and the shelf lost the save
    // until the next read (seen on GitHub's Windows runner).
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let begin = () => undefined as void;
    const begun = new Promise<void>((resolve) => (begin = resolve));
    const read = LibraryService.prototype.readAllEdits;
    let reads = 0;
    const holding = vi.spyOn(LibraryService.prototype, "readAllEdits").mockImplementation(async function (this: LibraryService) {
      const found = await read.call(this);
      if (++reads === 2) {
        begin();
        await held;
      }
      return found;
    });
    const scan = c.rescan(true);
    await begun;
    await c.saveEdits(id, { title: "Saved While Reading" });
    release();
    await scan;
    holding.mockRestore();
    expect(c.getState().books.find((x) => x.book.id === id)!.book.title).toBe("Saved While Reading");
    // And a fresh read finds the same, from the file.
    await c.rescan(true);
    expect(c.getState().books.find((x) => x.book.id === id)!.book.title).toBe("Saved While Reading");
    await c.resetEdits(id);
    c.destroy();
  });
});
