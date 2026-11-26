import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import { parseLog } from "@ribbon/core/poslog";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { howFar, lengthOf, progressOf } from "../src/ui/progress";
import { folio } from "../src/comic/ComicView";

/**
 * Reading a comic in the app (docs/COMICS.md, sections 5 and 6), over
 * comics made for the test: it opens to read, turns, keeps its page on
 * this machine and in the position log, and opens there again.
 */
describe("a comic in the app", () => {
  let root: string;
  const platformFor = (settings = memorySettings()): Platform => ({
    host: nodeHost(),
    pickFolder: async () => root,
    allowFolder: async () => undefined,
    fileUrl: (p) => `file:///${p}`,
    comicPageUrl: (file, entry, version) => `comic://${file}#${entry}@${version}`,
    sources: memorySources(),
    appSettings: settings,
  });
  const open = async (settings = memorySettings()) => {
    const c = new AppController(platformFor(settings));
    await c.boot();
    await c.pickLibrary();
    return c;
  };
  const comicOf = (c: AppController, title: string) => c.getState().books.find((b) => b.book.title === title)!;
  const logRecords = async () => {
    const dir = path.join(root, ".ribbon", "positions");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson"));
    return (await Promise.all(files.map(async (f) => parseLog(await fs.readFile(path.join(dir, f), "utf8")).records))).flat();
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-comic-app-"));
    await makeComic(path.join(root, "Made Up Saga 001 (2018).cbz"), { pages: 9, wide: [4], unpadded: true });
    await makeComic(path.join(root, "Paper Lanterns.cbz"), { pages: 3, comicInfo: comicInfoXml({ Manga: "YesAndRightToLeft" }) });
    await fs.writeFile(path.join(root, "Broken.cbz"), "not an archive");
  });
  afterAll(async () => {
    // An app closed a moment ago may still be writing its last record beside the books: tried again until it has.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("is worded as something read, by its pages", async () => {
    const c = await open();
    const book = comicOf(c, "Made Up Saga #1");
    expect(lengthOf(book)).toBe("9 pages");
    expect(progressOf(book, c.getState(), (id) => c.readingProgress(id))).toMatchObject({ started: false, finished: false, fraction: 0 });
    expect(folio([0], 9)).toBe("Page 1 of 9");
    expect(folio([1, 2], 9)).toBe("Pages 2–3 of 9");
    c.destroy();
  });

  it("opens to read where an audiobook plays, in the natural order of its pages", async () => {
    const c = await open();
    const book = comicOf(c, "Made Up Saga #1");
    await c.playBook(book);
    expect(c.getState().current).toBeNull();
    expect(c.getState().reading).toBeNull();
    const r = c.getState().comic!;
    expect(r).toMatchObject({ status: "ready", bookId: book.book.id, page: 0 });
    if (r.status !== "ready") throw new Error("not ready");
    expect(r.pages).toHaveLength(9);
    expect(r.pages.slice(0, 3)).toEqual(["page-1.png", "page-2.png", "page-3.png"]);
    // A page's address names its file, its entry, and the file as it is now.
    expect(c.comicPageUrl(1)).toBe(`comic://${path.join(root, "Made Up Saga 001 (2018).cbz")}#page-2.png@${book.book.id}`);
    await c.closeComic();
    expect(c.getState().comic).toBeNull();
    c.destroy();
  });

  it("keeps its page on this machine and in the position log, and opens there again", async () => {
    const settings = memorySettings();
    const c = await open(settings);
    const book = comicOf(c, "Made Up Saga #1");
    await c.openComic(book.book.id);
    c.turnComic(1);
    c.turnComic(6, "seek");
    // Past the last page is the last page.
    c.turnComic(99);
    c.turnComic(6);
    c.comicMeasured(book.book.id, 4, 400, 300);
    expect(c.getState().comic).toMatchObject({ page: 6, wide: [false, false, false, false, true, false, false, false, false] });
    await c.closeComic();

    // The shelf: three quarters through.
    const p = progressOf(book, c.getState(), (id) => c.readingProgress(id));
    expect(p).toMatchObject({ started: true, finished: false });
    expect(p.fraction).toBeCloseTo(0.75, 2);
    expect(howFar(book, p)).toBe("75% read");

    // The log: a place with no time, naming the page's entry and its number from 1, under the read edition's claim.
    const places = (await logRecords()).filter((r) => r.k === "pos");
    expect(places.at(-1)).toMatchObject({ k: "pos", why: "close", book: { ids: [`urn:ribbon:${book.book.id}-text`] }, loc: { href: "page-7.png", type: "image/png", locations: { position: 7, totalProgression: 0.75 } } });
    expect(places.at(-1)).not.toHaveProperty("ms");
    c.destroy();

    // Another machine, with nothing of its own kept: it opens at the log's page.
    const other = await open();
    await other.openComic(book.book.id);
    expect(other.getState().comic).toMatchObject({ status: "ready", page: 6 });
    await other.closeComic();
    other.destroy();

    // This machine again: its own kept page.
    const again = await open(settings);
    await again.openComic(book.book.id);
    expect(again.getState().comic).toMatchObject({ status: "ready", page: 6 });
    again.destroy();
  });

  it("is finished on its last page", async () => {
    const c = await open();
    const book = comicOf(c, "Paper Lanterns");
    await c.openComic(book.book.id);
    c.turnComic(2);
    await c.closeComic();
    expect(progressOf(book, c.getState(), (id) => c.readingProgress(id)).finished).toBe(true);
    c.destroy();
  });

  it("reads right to left as it says of itself, unless a person says otherwise: in their own folders, as an edit beside the comic", async () => {
    const settings = memorySettings();
    const c = await open(settings);
    const manga = comicOf(c, "Paper Lanterns").book.id;
    const other = comicOf(c, "Made Up Saga #1").book.id;
    expect(c.comicRightToLeft(manga)).toBe(true);
    expect(c.comicRightToLeft(other)).toBe(false);
    expect(c.mayEdit(manga)).toBe(true);
    c.setComicRightToLeft(manga, false);
    c.setComicRightToLeft(other, true);
    // It turns at once.
    expect(c.comicRightToLeft(manga)).toBe(false);
    expect(c.comicRightToLeft(other)).toBe(true);
    // And is kept as each comic's edit, as the edit form keeps it, which the reader then goes by: this machine's own choice goes.
    await vi.waitFor(() => expect(c.getState().comicDirections).toEqual({}));
    expect(comicOf(c, "Paper Lanterns").edits).toEqual({ rightToLeft: "no" });
    expect(comicOf(c, "Made Up Saga #1").edits).toEqual({ rightToLeft: "yes" });
    expect(c.comicRightToLeft(manga)).toBe(false);
    expect(c.comicRightToLeft(other)).toBe(true);
    await vi.waitFor(async () => expect(await settings.read()).toMatchObject({ comicDirections: {} }));
    // Another app on these folders reads them the same way.
    const elsewhere = await open();
    expect(elsewhere.comicRightToLeft(manga)).toBe(false);
    expect(elsewhere.comicRightToLeft(other)).toBe(true);
    elsewhere.destroy();
    // Taken back, each reads as its file says again.
    await c.resetEdits(manga, "rightToLeft");
    await c.resetEdits(other);
    expect(comicOf(c, "Paper Lanterns").edits).toBeUndefined();
    expect(c.comicRightToLeft(manga)).toBe(true);
    expect(c.comicRightToLeft(other)).toBe(false);
    // Turned back to what its file says, it is no edit at all.
    c.setComicRightToLeft(manga, false);
    await vi.waitFor(() => expect(comicOf(c, "Paper Lanterns").edits).toEqual({ rightToLeft: "no" }));
    c.setComicRightToLeft(manga, true);
    await vi.waitFor(() => expect(comicOf(c, "Paper Lanterns").edits).toBeUndefined());
    await vi.waitFor(() => expect(c.getState().comicDirections).toEqual({}));
    expect(c.comicRightToLeft(manga)).toBe(true);
    c.destroy();
  });

  it("reads as the edit form's switch says, here too: saving the form takes back this machine's own choice", async () => {
    const first = await open();
    const id = comicOf(first, "Made Up Saga #1").book.id;
    first.destroy();
    // Read right to left on this machine, as anyone's choice was before the direction was the comic's own detail.
    const settings = memorySettings();
    await settings.write({ comicDirections: { [id]: true } });
    const c = await open(settings);
    expect(c.comicRightToLeft(id)).toBe(true);
    // The form shows it reading left to right, as its file says, and is saved so: that is how it reads, here as everywhere.
    // Its title is the story's own name, which this one has none of: the shelf names it by its series and number.
    await c.saveEdits(id, { title: "", rightToLeft: "no" });
    expect(c.getState().comicDirections).toEqual({});
    expect(c.comicRightToLeft(id)).toBe(false);
    expect(comicOf(c, "Made Up Saga #1").edits).toBeUndefined();
    c.destroy();
  });

  it("says in words why a file that is no comic can't be opened", async () => {
    const c = await open();
    await c.openComic(comicOf(c, "Broken").book.id);
    expect(c.getState().comic).toMatchObject({ status: "failed" });
    expect((c.getState().comic as { message: string }).message).toMatch(/isn't a comic Ribbon can open/);
    await c.closeComic();
    c.destroy();
  });

  it("closes when another book opens to read, and only the comic asked for last opens", async () => {
    const c = await open();
    const [a, b] = [comicOf(c, "Made Up Saga #1"), comicOf(c, "Paper Lanterns")];
    const first = c.openComic(a.book.id);
    const second = c.openComic(b.book.id);
    await Promise.all([first, second]);
    expect(c.getState().comic).toMatchObject({ status: "ready", bookId: b.book.id });
    c.destroy();
  });
});
