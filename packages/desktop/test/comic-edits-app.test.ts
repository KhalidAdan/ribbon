import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import type { ComicShape } from "@ribbon/core/comic-name";
import { editForm } from "@ribbon/core/edit-form";
import { bytesToEdits, EDIT_FIELDS, fieldText, type EditField } from "@ribbon/core/edits";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { folderComicEdited } from "../src/app/comic";
import { asksOf, formAsShape, formToSave, type FormValues } from "../src/ui/book-form";

// The app logs as it works, and goes on a moment after a test ends: kept quiet, as controller-edits.test.ts does.
vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);

/**
 * A comic's edits from before it had details of its own, in a folder
 * (docs/BOOK-DETAILS.md, section 6): read as the new ones and the comic
 * named from them on the shelf, nothing written on opening the library,
 * and written in the new shape when the person next saves the book.
 */
describe("a comic's edits from before, on the desktop alone", () => {
  let root: string;
  const ISSUE = "Made Up Saga/Made Up Saga 014.cbz";
  const COLLECTION = "Made Up Saga/Made Up Saga - the first six.cbz";
  const ids: Record<string, string> = {};
  const platform = (): Platform => ({ host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() });
  /** The library opened, and its scan in the background done: a save made while that scan reads the edits back would be undone by it. */
  const open = async () => {
    const c = new AppController(platform());
    await c.boot();
    await c.pickLibrary();
    await vi.waitFor(() => expect(c.getState().scanning === null && c.getState().lastScanMs !== null).toBe(true), { timeout: 10_000 });
    return c;
  };
  const bookAt = (c: AppController, comic: string) => c.getState().books.find((b) => b.book.comic === comic)!;
  const editsFile = (comic: string) => path.join(root, ".ribbon", "edits", `${ids[comic]}.csv`);
  const editsOnDisk = async (comic: string) => (await bytesToEdits(ids[comic]!, await fs.readFile(editsFile(comic)))).values;
  const oldEdits = (rows: [string, string][]) => ["field,value,updated_at", ...rows.map(([f, v]) => `${f},"${v}",2026-11-01T00:00:00.000Z`)].join("\n") + "\n";

  /** What the edit form sends for a book, said to be `shape` if that is given, with `change` typed into it (EditBook.tsx, book-form.ts). */
  const formFor = (b: ScannedBook, change: FormValues, shape?: ComicShape): FormValues => {
    const values = (book: ScannedBook["book"]) => Object.fromEntries(EDIT_FIELDS.filter((f) => f !== "cover").map((f) => [f, fieldText(book, f)])) as Record<EditField, string>;
    const groups = editForm("comic", b.book.comic);
    const asks = asksOf("comic", values(b.book), b.edits);
    const said = shape ? formAsShape(values(b.book), shape, groups, values(b.book)) : values(b.book);
    return formToSave({ ...said, ...change }, groups, { ...asks, shape: shape ?? asks.shape }, values(b.original ?? b.book));
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-comic-edits-"));
    await makeComic(path.join(root, ...ISSUE.split("/")), { pages: 2, comicInfo: comicInfoXml({ Title: "Chapter Fourteen", Series: "Made Up Saga", Number: "14", Writer: "Ada Quill", Penciller: "Ben Nib" }) });
    // A collection whose file calls it issue 1, as many do.
    await makeComic(path.join(root, ...COLLECTION.split("/")), { pages: 2, comicInfo: comicInfoXml({ Series: "Made Up Saga", Number: "1" }) });
    const first = await open();
    for (const comic of [ISSUE, COLLECTION]) ids[comic] = bookAt(first, comic).book.id;
    first.destroy();
    // Edits as Ribbon kept them before: the whole name as the title, the number in the series, writers and artists as one author.
    await fs.mkdir(path.join(root, ".ribbon", "edits"), { recursive: true });
    await fs.writeFile(editsFile(ISSUE), oldEdits([["title", "Made Up Saga #14"], ["series_index", "14"], ["author", "Ada Quill and Ben Nib"]]));
    await fs.writeFile(editsFile(COLLECTION), oldEdits([["title", "Made Up Saga Vol. 1 (#1–#6)"], ["subtitle", "Robots in Disguise"], ["series_index", "1"]]));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reads them as the new ones and names the comic from them, writing nothing on opening", async () => {
    const before = await Promise.all([ISSUE, COLLECTION].map((comic) => fs.readFile(editsFile(comic))));
    const c = await open();
    expect(bookAt(c, COLLECTION).book.title).toBe("Made Up Saga Vol. 1: Robots in Disguise");
    // The issue's title was the name the shelf makes: the shelf says the same, its byline kept until taken back.
    expect(bookAt(c, ISSUE).book).toMatchObject({ title: "Made Up Saga #14", author: "Ada Quill and Ben Nib", issue: "14", seriesIndex: 14 });
    expect(bookAt(c, ISSUE).edits).toEqual({ title: "", issue: "14", author: "Ada Quill and Ben Nib" });
    // The collection: its volume and the issues it holds from the title's shape, its subtitle its title, first in its series.
    expect(bookAt(c, COLLECTION).book).toMatchObject({ volume: "1", collects: "1–6", rawTitle: "Robots in Disguise", seriesIndex: 1 });
    expect(bookAt(c, COLLECTION).book.issue).toBeUndefined();
    const after = await Promise.all([ISSUE, COLLECTION].map((comic) => fs.readFile(editsFile(comic))));
    expect(after).toEqual(before);
    c.destroy();
  });

  it("writes them in the new shape when the book is next saved, and a byline taken back is gone", async () => {
    const c = await open();
    await c.saveEdits(ids[ISSUE]!, formFor(bookAt(c, ISSUE), { colours: "Cy Ink" }));
    // No number in the series, no subtitle: the issue is what the file says, so it is no edit at all.
    expect(await editsOnDisk(ISSUE)).toEqual({ title: "", author: "Ada Quill and Ben Nib", colours: "Cy Ink" });
    expect(bookAt(c, ISSUE).book).toMatchObject({ title: "Made Up Saga #14", seriesIndex: 14, credits: { writers: ["Ada Quill"], pencils: ["Ben Nib"], colours: ["Cy Ink"] } });

    // By taken back: the writers and the art make the byline.
    await c.saveEdits(ids[ISSUE]!, formFor(bookAt(c, ISSUE), { author: "" }));
    expect(await editsOnDisk(ISSUE)).toEqual({ title: "", colours: "Cy Ink" });
    expect(bookAt(c, ISSUE).book.author).toBe("Ada Quill; Ben Nib");

    // The collection said to be an issue, numbered 1 as its file says: its volume and its issues emptied.
    await c.saveEdits(ids[COLLECTION]!, formFor(bookAt(c, COLLECTION), { issue: "1" }, "issue"));
    expect(await editsOnDisk(COLLECTION)).toEqual({ title: "Robots in Disguise" });
    expect(bookAt(c, COLLECTION).book).toMatchObject({ title: "Made Up Saga #1: Robots in Disguise", issue: "1", seriesIndex: 1 });
    c.destroy();
  });
});

/** The shelf's comic with its edits laid over it (app/comic.ts, `folderComicEdited`). */
describe("a comic's edits on the shelf", () => {
  const book = { id: "c1", path: "Made Up Saga/014.cbz", comic: "Made Up Saga/014.cbz", narrator: "", cover: "", year: null, durationMs: 0, sizeBytes: 1, fileCount: 0 };

  it("moves edits from before and names the comic from them, the moved ones in effect", () => {
    const files = { ...book, title: "Made Up Saga #14: Chapter Fourteen", rawTitle: "Chapter Fourteen", author: "Ada Quill", series: "Made Up Saga", seriesIndex: 14, issue: "14", credits: { writers: ["Ada Quill"] } };
    const moved = folderComicEdited(files, { title: "The Long Way", seriesIndex: "15" });
    expect(moved.original).toBe(files);
    expect(moved.edits).toEqual({ title: "The Long Way", issue: "15" });
    expect(moved.book).toMatchObject({ title: "Made Up Saga #15: The Long Way", seriesIndex: 15, author: "Ada Quill" });
  });

  it("shows a comic from a library.csv written before comics kept their details as it was, until the scan brings them", () => {
    // As Ribbon 0.51.0 kept it: its whole name as its title, its writers as its author, its number as its place.
    const files = { ...book, title: "Made Up Saga #14", rawTitle: "Made Up Saga #14", author: "Ada Quill, Ben Nib", series: "Made Up Saga", seriesIndex: 14 };
    const edits = { title: "Made Up Saga #14", seriesIndex: "14", description: "Mine." };
    const shown = folderComicEdited(files, edits);
    expect(shown.book).toMatchObject({ title: "Made Up Saga #14", author: "Ada Quill, Ben Nib", seriesIndex: 14, description: "Mine." });
    expect(shown.edits).toBe(edits);
  });
});
