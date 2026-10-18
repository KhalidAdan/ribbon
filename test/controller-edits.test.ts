import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

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
  });
});
