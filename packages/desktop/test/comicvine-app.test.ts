import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import type { CvRequest } from "@ribbon/core/comicvine";
import { bytesToEdits } from "@ribbon/core/edits";
import { bytesToMatch } from "@ribbon/core/matched";
import type { Host } from "@ribbon/core/host";
import { AppController, shownToEdit, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";

// The app logs as it works, and goes on a moment after a test ends: kept quiet, as controller-edits.test.ts does.
vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);

/** A made-up key: the only one the stand-in below takes. A key in this repository must never be a real one. */
const KEY = "madeupkeyforthetests0123456789";

/** A cover's picture as ComicVine's site would send it: the start of a JPEG is all the app shows of it. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const run9001 = {
  id: 9001,
  name: "Made Up Saga",
  start_year: "2018",
  count_of_issues: 12,
  publisher: { id: 90031, name: "Made Up Press" },
  image: { thumb_url: "https://comicvine.gamespot.com/a/uploads/scale_avatar/9/9001/made-up-saga-1.jpg" },
  site_detail_url: "https://comicvine.gamespot.com/made-up-saga/4050-9001/",
};
const run9002 = { id: 9002, name: "Made Up Saga", start_year: "2021", count_of_issues: 3, publisher: { id: 90033, name: "Another Press" }, image: null, site_detail_url: "https://comicvine.gamespot.com/made-up-saga/4050-9002/" };
const volume = { id: 9001, name: "Made Up Saga", site_detail_url: "https://comicvine.gamespot.com/made-up-saga/4050-9001/" };

/**
 * ComicVine's answers, written by hand in the shape its API documentation
 * gives (as the server's stand-in's are, packages/server/test/comicvine/):
 * by a request's path, and a search's or a run's issues by its filter.
 * Every comic, person and address is made up.
 */
const ANSWERS: Record<string, unknown> = {
  "issue/4000-123456/": {
    id: 123456,
    name: "The Long Way Home",
    issue_number: "2",
    cover_date: "2018-07-01",
    store_date: "2018-07-04",
    volume,
    person_credits: [
      { id: 90001, name: "Ada Quill", role: "writer" },
      { id: 90002, name: "Ben Nib", role: "artist, cover" },
      { id: 90004, name: "Di Pen", role: "letterer" },
    ],
    story_arc_credits: [{ id: 70001, name: "The Lighthouse" }],
    site_detail_url: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/",
    deck: null,
    description: "<p>Ada and Ben take the <em>long</em> way home.</p>",
  },
  "issue/4000-123455/": {
    id: 123455,
    name: "Setting Out",
    issue_number: "1",
    cover_date: "2018-06-01",
    volume,
    person_credits: [{ id: 90001, name: "Ada Quill", role: "writer" }],
    site_detail_url: "https://comicvine.gamespot.com/made-up-saga-1-setting-out/4000-123455/",
    description: "<p>Where it starts.</p>",
  },
  "volume/4050-9001/": run9001,
  "volumes/name:Made Up Saga": [run9002, run9001],
  "issues/volume:9001,issue_number:1": [{ id: 123455, name: "Setting Out", issue_number: "1", volume }],
};

/**
 * ComicVine on the desktop alone (docs/BOOK-DETAILS.md, section 7, "Where
 * it runs"): the app over a folder of made comics, its host's ComicVine
 * answering from the answers above (the app's own goes through its Rust,
 * src-tauri/src/comicvine.rs, tested there). What the app asks, keeps beside
 * the comics, and shows.
 */
describe("ComicVine on the desktop alone", () => {
  let root: string;
  /** Each request the host was asked to send, as its path and filter. */
  const asked: string[] = [];
  /** ComicVine out of reach while set. */
  let failing = false;
  const settings = memorySettings();

  const WEB = "Made Up Saga/Made Up Saga 002.cbz";
  const LOST = "Lost Things/Lost Things 001.cbz";
  const PLAIN = "Made Up Saga/Made Up Saga 001.cbz";
  const ids: Record<string, string> = {};

  const host = (): Host => ({
    ...nodeHost(),
    async comicVineAsk(key: string, request: CvRequest) {
      const filter = request.params.filter;
      asked.push(filter ? `${request.path}?${filter}` : request.path);
      if (failing) return { status: 0, body: "" };
      if (key !== KEY) return { status: 401, body: JSON.stringify({ status_code: 100, error: "Invalid API Key", results: [] }) };
      const results = ANSWERS[filter ? `${request.path}${filter.replace(/,start_year:\d+$/, "")}` : request.path];
      if (results === undefined) return request.path.endsWith("s/") ? { status: 200, body: JSON.stringify({ status_code: 1, error: "OK", results: [] }) } : { status: 404, body: JSON.stringify({ status_code: 101, error: "Object Not Found", results: [] }) };
      return { status: 200, body: JSON.stringify({ status_code: 1, error: "OK", results }) };
    },
    comicVinePicture: async (url: string) => (url.startsWith("https://comicvine.gamespot.com/a/uploads/") ? PICTURE : null),
  });
  const platform = (): Platform => ({ host: host(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings, comicVineGapMs: 0 });

  /** The library opened, and its scan in the background done. */
  const open = async () => {
    const c = new AppController(platform());
    await c.boot();
    await c.pickLibrary();
    await vi.waitFor(() => expect(c.getState().scanning === null && c.getState().lastScanMs !== null).toBe(true), { timeout: 10_000 });
    return c;
  };
  const bookAt = (c: AppController, comic: string) => c.getState().books.find((b) => b.book.comic === comic)!;
  const recordOf = async (comic: string) => {
    const file = path.join(root, ".ribbon", "matched", `${ids[comic]}.csv`);
    return existsSync(file) ? bytesToMatch(ids[comic]!, await fs.readFile(file)) : null;
  };
  const editsOf = async (comic: string) => {
    const file = path.join(root, ".ribbon", "edits", `${ids[comic]}.csv`);
    return existsSync(file) ? (await bytesToEdits(ids[comic]!, await fs.readFile(file))).values : null;
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-comicvine-"));
    // A comic whose file gives its issue's page on ComicVine; one whose page ComicVine has no issue at; one that gives none.
    await makeComic(path.join(root, ...WEB.split("/")), { pages: 2, comicInfo: comicInfoXml({ Series: "Made Up Saga", Number: "2", Writer: "Ada Quill", Publisher: "Made Up Press", Web: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/" }) });
    await makeComic(path.join(root, ...LOST.split("/")), { pages: 2, comicInfo: comicInfoXml({ Series: "Lost Things", Number: "1", Web: "https://comicvine.gamespot.com/lost-things-1/4000-404404/" }) });
    await makeComic(path.join(root, ...PLAIN.split("/")), { pages: 2, comicInfo: comicInfoXml({ Series: "Made Up Saga", Number: "1" }) });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("asks ComicVine nothing without a key, and offers no look-up", async () => {
    const c = await open();
    for (const comic of [WEB, LOST, PLAIN]) ids[comic] = bookAt(c, comic).book.id;
    expect(bookAt(c, WEB).book.comicvine).toBe("4000-123456");
    expect(c.getState().comicVineKey).toBe(false);
    expect(c.comicVineFor(ids[WEB]!)).toBeNull();
    expect(asked).toEqual([]);
    expect(existsSync(path.join(root, ".ribbon", "matched"))).toBe(false);
    c.destroy();
  });

  it("with a key, matches by itself only the comics whose files give their issue's page, once each, and never searches", async () => {
    const c = await open();
    await c.setComicVineKey(` ${KEY} `);
    expect(c.getState().comicVineKey).toBe(true);
    // Kept in the app's own settings, never beside the books.
    expect((await settings.read()).comicVineKey).toBe(KEY);
    await vi.waitFor(async () => expect(await recordOf(LOST)).not.toBeNull(), { timeout: 5_000 });
    expect([...asked].sort()).toEqual(["issue/4000-123456/", "issue/4000-404404/", "volume/4050-9001/"]);

    const matched = await recordOf(WEB);
    expect(matched).toMatchObject({ match: { address: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/", as: "issue", values: { series: "Made Up Saga (2018)", issue: "2", title: "The Long Way Home", writers: "Ada Quill", pencils: "Ben Nib", inks: "Ben Nib", letters: "Di Pen", storyArcs: "The Lighthouse", publisher: "Made Up Press", coverDate: "2018-07", onSale: "2018-07-04" } } });
    expect(await recordOf(LOST)).toMatchObject({ match: null, none: "not found" });
    expect(await recordOf(PLAIN)).toBeNull();

    // On the shelf: named from what ComicVine said, laid over its file, with its page to link back to; no edit made.
    expect(bookAt(c, WEB).book).toMatchObject({ title: "Made Up Saga #2: The Long Way Home", author: "Ada Quill; Ben Nib", series: "Made Up Saga (2018)", seriesIndex: 2, description: "Ada and Ben take the long way home.", coverDate: "2018-07", comicvine: "4000-123456" });
    expect(bookAt(c, WEB).comicVineMatch?.address).toBe(matched!.match!.address);
    expect(bookAt(c, WEB).edits).toBeUndefined();
    expect(bookAt(c, WEB).original?.series).toBe("Made Up Saga");
    expect(c.comicVineFor(ids[WEB]!)).toBe("here");
    c.destroy();

    // The next start asks nothing: each was asked once, found or not.
    asked.length = 0;
    const again = await open();
    expect(bookAt(again, WEB).book.title).toBe("Made Up Saga #2: The Long Way Home");
    await new Promise((r) => setTimeout(r, 200));
    expect(asked).toEqual([]);
    again.destroy();
  });

  it("lets a person's edit beat ComicVine's; a field set back to ComicVine's stops being an edit; forgetting the match keeps the edits", async () => {
    const c = await open();
    const id = ids[WEB]!;
    // The form offers ComicVine's as what taking an edit back returns to, and the files' where ComicVine says nothing.
    const shown = shownToEdit(bookAt(c, WEB));
    expect(shown.reference).toMatchObject({ rawTitle: "The Long Way Home", publisher: "Made Up Press" });
    expect(shown.matched?.values.title).toBe("The Long Way Home");

    await c.saveEdits(id, { title: "My Own Title", publisher: "Made Up Press" });
    expect(await editsOf(WEB)).toEqual({ title: "My Own Title" });
    expect(bookAt(c, WEB).book).toMatchObject({ title: "Made Up Saga #2: My Own Title", series: "Made Up Saga (2018)" });

    await c.saveEdits(id, { title: "The Long Way Home" });
    expect(await editsOf(WEB)).toBeNull();
    expect(bookAt(c, WEB).book.title).toBe("Made Up Saga #2: The Long Way Home");

    await c.saveEdits(id, { publisher: "A Press Of My Own" });
    await c.forgetComicVineMatch(id);
    expect(await recordOf(WEB)).toMatchObject({ match: null, none: "forgotten" });
    expect(await editsOf(WEB)).toEqual({ publisher: "A Press Of My Own" });
    expect(bookAt(c, WEB).book).toMatchObject({ title: "Made Up Saga #2", series: "Made Up Saga", publisher: "A Press Of My Own" });
    expect(bookAt(c, WEB).book.comicvine).toBe("4000-123456");
    expect(bookAt(c, WEB).comicVineMatch).toBeUndefined();
    c.destroy();

    // Forgotten, it isn't matched by itself again.
    asked.length = 0;
    const again = await open();
    await new Promise((r) => setTimeout(r, 200));
    expect(asked).toEqual([]);
    expect(bookAt(again, WEB).book.series).toBe("Made Up Saga");
    await again.resetEdits(id);
    again.destroy();
  });

  it("finds a comic's run by its series' name, shows ComicVine's beside the comic, and keeps nothing until Use these", async () => {
    const c = await open();
    const id = ids[PLAIN]!;
    asked.length = 0;
    const runs = await c.comicVineRuns(id, { name: "Made Up Saga", year: null });
    // Both named as asked: the longer run first. Each with its first year, publisher, issues and the address of its small picture.
    expect(runs).toEqual([
      { id: "4050-9001", name: "Made Up Saga", startYear: 2018, publisher: "Made Up Press", issues: 12, address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/", picture: run9001.image.thumb_url },
      { id: "4050-9002", name: "Made Up Saga", startYear: 2021, publisher: "Another Press", issues: 3, address: "https://comicvine.gamespot.com/made-up-saga/4050-9002/", picture: null },
    ]);
    const picture = await c.comicVineRunPicture(id, runs[0]!);
    expect(new Uint8Array(await picture!.arrayBuffer())).toEqual(PICTURE);
    expect(await c.comicVineRunPicture(id, runs[1]!)).toBeNull();

    const found = await c.lookUpOnComicVine(id, { address: runs[0]!.id, issue: "1", as: "issue" });
    expect(found).toMatchObject({ address: "https://comicvine.gamespot.com/made-up-saga-1-setting-out/4000-123455/", as: "issue", values: { title: "Setting Out", issue: "1", series: "Made Up Saga (2018)" }, run: { id: "4050-9001", startYear: 2018 } });
    // The run came with the search: picking it asked only for its issue by number, and the issue whole.
    expect(asked).toEqual(["volumes/?name:Made Up Saga", "issues/?volume:9001,issue_number:1", "issue/4000-123455/"]);
    expect(await recordOf(PLAIN)).toBeNull();
    expect(bookAt(c, PLAIN).book.title).toBe("Made Up Saga #1");

    await c.keepComicVineMatch(id, { address: runs[0]!.id, issue: "1", as: "issue" });
    // Kept from what was asked today: nothing asked twice.
    expect(asked).toHaveLength(3);
    expect(await recordOf(PLAIN)).toMatchObject({ match: { address: found.address, as: "issue", values: { title: "Setting Out" } } });
    expect(bookAt(c, PLAIN).book).toMatchObject({ title: "Made Up Saga #1: Setting Out", series: "Made Up Saga (2018)" });
    c.destroy();
  });

  it("says why a comic can't be looked up, in words a person can act on", async () => {
    const c = await open();
    const id = ids[PLAIN]!;
    await expect(c.lookUpOnComicVine(id, { address: "https://elsewhere.example/4000-1/", as: "issue" })).rejects.toThrow(/isn’t a page on ComicVine/);
    await expect(c.lookUpOnComicVine(id, { address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/", as: "issue" })).rejects.toThrow(/Give the number of the issue in that run/);
    await expect(c.lookUpOnComicVine(id, { address: "4050-9001", issue: "99", as: "issue" })).rejects.toThrow("ComicVine has no issue 99 in that run.");
    await expect(c.lookUpOnComicVine(id, { address: "4000-777777", as: "issue" })).rejects.toThrow("ComicVine has no such issue.");
    failing = true;
    await expect(c.lookUpOnComicVine(id, { address: "4000-777778", as: "issue" })).rejects.toThrow("ComicVine can’t be reached from this computer just now.");
    failing = false;
    await c.setComicVineKey("anotherkeythatisnotit");
    await expect(c.lookUpOnComicVine(id, { address: "4000-777779", as: "issue" })).rejects.toThrow(/refused your key/);
    // Taken away, there's no look-up, though a match kept before can still be forgotten.
    await c.setComicVineKey(null);
    expect((await settings.read()).comicVineKey).toBeUndefined();
    expect(c.comicVineFor(id)).toBeNull();
    await c.forgetComicVineMatch(id);
    expect(await recordOf(PLAIN)).toMatchObject({ match: null, none: "forgotten" });
    c.destroy();
  });
});
