import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController, type Platform } from "../../desktop/src/app/controller.ts";
import { LibraryService } from "../../desktop/src/app/library.ts";
import { memorySettings, memorySources } from "../../desktop/src/app/platform.ts";
import { ribbonClaim } from "@ribbon/core/poslog";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { endOf, readsOf } from "@ribbon/core/stats";
import type { Host } from "@ribbon/core/host";
import { nodeHost } from "@ribbon/host-node/node";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import { epub, importAs, makeLibraries, mp3, serverWithAdmin } from "./fixture.ts";

const PASSWORD = "a long password";
const PHONE = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Nobody on the ship would look at it for long."];

/**
 * The desktop with a server, as the desktop alone is covered elsewhere: the
 * whole app (AppController) signed in over HTTP to a real server, doing what
 * only happens with one. The reader and the player never ask where a book
 * came from, so a downloaded book is theirs like any other and the end-to-end
 * checks cover it; what differs is here.
 */
describe("the desktop on a server", () => {
  let dir: string;
  let shelf: string;
  let server: RibbonServer;
  let admin = "";
  let url = "";

  const start = async (config: Parameters<typeof serverWithAdmin>[1] = {}) => {
    ({ server, admin } = await serverWithAdmin(dir, config));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  };

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-desktop-server-"));
    ({ shelf } = makeLibraries(dir));
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Long enough for the app's own short waits: places go after a second, a changed library is asked for after one and a half. */
  const soon = <T,>(value: () => T | Promise<T>) => expect.poll(value, { timeout: 10_000, interval: 50 });

  /** A server holding the two books of the shelf. */
  const stocked = async () => {
    await start();
    await importAs(server, admin, shelf);
  };

  const asked = async <T,>(at: string, token = admin) => (await server.app.inject({ method: "GET", url: at, headers: { authorization: `Bearer ${token}` } })).json() as T;

  /** Someone new, invited by the admin: their token, for asking the server as them. */
  const invited = async (name: string) => {
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    return ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name, password: PASSWORD } })).json() as { token: string }).token;
  };

  /** One device: the whole app with a Ribbon folder of its own, signed in. */
  const aDesktop = async (name = "admin", opts: { host?: Host; settings?: NonNullable<Platform["appSettings"]> } = {}) => {
    const home = mkdtempSync(path.join(dir, "home-"));
    const settings = opts.settings ?? memorySettings();
    const platform: Platform = { host: opts.host ?? nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings, home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    const app = new AppController(platform);
    await app.boot();
    await app.connectServer(url, name, PASSWORD);
    await soon(() => app.getState().books.length).toBeGreaterThan(0);
    return { app, settings };
  };

  const book = (app: AppController, title: string): ScannedBook => app.getState().books.find((b) => b.book.title === title)!;
  const root = (app: AppController) => app.getState().sources.find((s) => s.server)!.root;
  const fileOf = (app: AppController, b: ScannedBook) => path.join(root(app), ...b.files[0]!.path.split("/"));

  it("downloads a book whole, with what the server worked out about it", async () => {
    await stocked();
    const { app } = await aDesktop();
    const listed = book(app, "Long Book");
    expect(listed.remote).toBeTruthy();

    await app.downloadBook(listed.book.id);

    const here = book(app, "Long Book");
    expect(here.remote).toBeUndefined();
    expect(here.book.id).toBe(listed.book.id);
    expect(here.files).toHaveLength(2);
    expect(readFileSync(fileOf(app, here))).toEqual(readFileSync(path.join(shelf, "Author Two", "Long Book", "01.mp3")));
    // Measured once, on the server: this device never measures it.
    expect(await new LibraryService(nodeHost(), root(app)).readLoudness(here.book.id)).not.toBeNull();
    expect(app.getState().error).toBeNull();
  }, 30_000);

  it("takes a download off this device, and the book and your bookmark stay", async () => {
    await stocked();
    const { app } = await aDesktop();
    const id = book(app, "Red Book").book.id;
    await app.downloadBook(id);
    const file = fileOf(app, book(app, "Red Book"));
    await app.addBookmarkAt(id, 1500, "Keep this");

    await app.removeDownload(id);

    expect(existsSync(file)).toBe(false);
    expect(book(app, "Red Book").remote).toBeTruthy();
    expect((await app.loadBookmarks(id)).map((b) => b.note)).toEqual(["Keep this"]);
    expect(app.downloadedBooks()).toEqual([]);
  }, 30_000);

  it("carries a bookmark to every device and app, and a delete with it", async () => {
    await stocked();
    const { app: one } = await aDesktop();
    const { app: two } = await aDesktop();
    const id = book(one, "Red Book").book.id;

    const made = (await one.addBookmarkAt(id, 1500, "First thought"))!;

    const onServer = () => asked<{ bookmarks: { note: string }[] }>("/api/bookmarks").then((r) => r.bookmarks.map((b) => b.note));
    await soon(onServer).toEqual(["First thought"]);
    await soon(async () => (await two.loadBookmarks(id)).map((b) => b.note)).toEqual(["First thought"]);

    await two.editBookmark(id, made.id, "Second thought");
    await soon(onServer).toEqual(["Second thought"]);
    await soon(async () => (await one.loadBookmarks(id)).map((b) => b.note)).toEqual(["Second thought"]);

    await one.removeBookmark(id, made.id);
    await soon(onServer).toEqual([]);
    await soon(async () => two.loadBookmarks(id)).toEqual([]);
  }, 30_000);

  it("keeps one person's bookmarks from another's", async () => {
    await stocked();
    await invited("brother");
    const { app: mine } = await aDesktop();
    const { app: theirs } = await aDesktop("brother");
    const id = book(mine, "Red Book").book.id;

    await mine.addBookmarkAt(id, 1500, "Mine");
    await soon(() => asked<{ bookmarks: unknown[] }>("/api/bookmarks").then((r) => r.bookmarks.length)).toBe(1);

    expect(await theirs.loadBookmarks(book(theirs, "Red Book").book.id)).toEqual([]);
  }, 30_000);

  it("moves to a place another device left, as soon as it's left", async () => {
    await stocked();
    const { app } = await aDesktop();
    const id = book(app, "Red Book").book.id;
    const place = { v: 1, k: "pos", dev: PHONE, seq: Date.now(), t: new Date().toISOString(), book: { ids: [ribbonClaim(id)] }, why: "pause", ms: 2000 };

    await server.app.inject({ method: "POST", url: "/api/places", headers: { authorization: `Bearer ${admin}` }, payload: { device: { id: PHONE, name: "Ribbon on the phone" }, records: [place] } });

    await soon(() => app.getState().positions[id]?.offsetMs).toBe(2000);
    expect(app.getState().positions[id]?.device).toBe("Ribbon on the phone");
  }, 30_000);

  it("keeps the daily goal on the server, the one chosen later standing on every device", async () => {
    await stocked();
    const goal = async () => (await asked<{ goal: { minutes: number; chosenAt: string | null } }>("/api/goal")).goal;
    const { app } = await aDesktop();
    await app.setGoal(20);
    expect((await goal()).minutes).toBe(20);

    // Chosen later on the phone: a desktop signing in takes it.
    const later = new Date(Date.now() + 60_000).toISOString();
    await server.app.inject({ method: "PUT", url: "/api/goal", headers: { authorization: `Bearer ${admin}` }, payload: { minutes: 30, chosenAt: later } });
    const { app: other } = await aDesktop();
    await soon(() => other.getState().goal.minutes).toBe(30);

    // Chosen later still on a desktop that was away: signing in, it's the server's too.
    const settings = memorySettings();
    await settings.write({ dailyGoal: { minutes: 45, chosenAt: new Date(Date.now() + 120_000).toISOString() } });
    const { app: away } = await aDesktop("admin", { settings });
    expect(away.getState().goal.minutes).toBe(45);
    await soon(async () => (await goal()).minutes).toBe(45);
    for (const a of [app, other, away]) a.destroy();
  }, 30_000);

  it("sends what's waiting on disconnecting, and finds it all on signing in again", async () => {
    await stocked();
    const { app, settings } = await aDesktop();
    const id = book(app, "Red Book").book.id;
    await app.downloadBook(id);
    const file = fileOf(app, book(app, "Red Book"));
    await app.addBookmarkAt(id, 1500, "Before I left");

    await app.removeSource(app.getState().sources[0]!.id);

    expect(app.getState().sources).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect((await settings.read()).serverTokens).toEqual({});
    const left = await asked<{ bookmarks: { note: string }[] }>("/api/bookmarks");
    expect(left.bookmarks.map((b) => b.note)).toEqual(["Before I left"]);

    await app.connectServer(url, "admin", PASSWORD);
    await soon(() => app.getState().books.length).toBe(2);
    expect((await app.loadBookmarks(id)).map((b) => b.note)).toEqual(["Before I left"]);
  }, 30_000);

  it("has one listen-through going, however many devices hear a book and however often it's started again", async () => {
    await stocked();
    const { app: desktop } = await aDesktop();
    const { app: other } = await aDesktop();
    const red = book(desktop, "Red Book");
    const id = red.book.id;
    const serverId = red.remote!.serverId;
    const fromThePhone = (route: string, payload: object) => server.app.inject({ method: "POST", url: `/api/books/${serverId}/${route}`, headers: { authorization: `Bearer ${admin}` }, payload: { device: { id: PHONE, name: "Ribbon on the phone" }, ...payload } });
    const ends = (app: AppController) => {
      const reads = readsOf(app.getState().history.reads, id);
      return reads.map((r, i) => endOf(r, reads[i + 1]).how);
    };

    // The thin app opens one with its first stretch of listening, and every device has it.
    const now = new Date().toISOString();
    await fromThePhone("listened", { start: now, end: now, fromMs: 0, toMs: 0 });
    await soon(() => ends(desktop)).toEqual(["going"]);

    // "Start again from the beginning" on the desktop: a new one, and the first is left as it was.
    await desktop.listenAgain(id);
    await soon(() => ends(other)).toEqual(["left", "going"]);

    // Played to its end on the thin app, the new one closes. The one left behind was never finished.
    await fromThePhone("finished", {});
    await soon(() => ends(other)).toEqual(["left", "finished"]);
    const { books } = await asked<{ books: Record<string, { finished: boolean }> }>("/api/progress");
    expect(books[serverId]!.finished).toBe(true);
  }, 30_000);

  it("keeps a book's edit on the server, for every device and app", async () => {
    await stocked();
    const { app: one } = await aDesktop();
    const { app: two } = await aDesktop();
    const id = book(one, "Red Book").book.id;

    await one.saveEdits(id, { title: "The Red Book, Revised" });

    const titles = () => asked<{ books: { title: string }[] }>("/api/books").then((r) => r.books.map((b) => b.title));
    await soon(titles).toContain("The Red Book, Revised");
    await soon(() => two.getState().books.find((b) => b.book.id === id)?.book.title).toBe("The Red Book, Revised");
  }, 30_000);

  it("leaves deleting a book to the admin", async () => {
    await stocked();
    await invited("brother");
    const { app: mine } = await aDesktop();
    const { app: theirs } = await aDesktop("brother");
    await soon(() => mine.canDeleteFromServer(book(mine, "Red Book").book.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    expect(theirs.canDeleteFromServer(book(theirs, "Red Book").book.id)).toBe(false);
  }, 30_000);

  it("keeps a series on the server, for every device and app", async () => {
    await stocked();
    const { app: one } = await aDesktop();
    const { app: two } = await aDesktop();
    await soon(() => one.getState().canAddFolders).toBe(true);

    await one.createSeries("Colours", [book(one, "Red Book").book.id, book(one, "Long Book").book.id]);

    const onServer = await asked<{ series: { name: string; books: unknown[] }[] }>("/api/series");
    expect(onServer.series.find((s) => s.name === "Colours")?.books).toHaveLength(2);
    await soon(() => Object.values(two.getState().series).map((s) => s.name)).toContain("Colours");
  }, 30_000);

  it("puts a book in a reading list made by hand and leaves it in the series it was in, on every device", async () => {
    await stocked();
    const { app: one } = await aDesktop();
    const { app: two } = await aDesktop();
    await soon(() => one.getState().canAddFolders).toBe(true);
    const red = book(one, "Red Book").book.id;

    // As the White Scars list was made from books of The Horus Heresy.
    await one.createSeries("Colours", [red, book(one, "Long Book").book.id]);
    await one.createSeries("Favourites", [red]);

    const onServer = await asked<{ series: { name: string; books: unknown[] }[] }>("/api/series");
    expect(onServer.series.find((s) => s.name === "Colours")?.books).toHaveLength(2);
    expect(onServer.series.find((s) => s.name === "Favourites")?.books).toHaveLength(1);
    await soon(() => two.seriesOfBook(book(two, "Red Book").book.id).map((g) => g.name).sort()).toEqual(["Colours", "Favourites"]);
  }, 30_000);

  /** A book that can be transcribed: its narration, and the EPUB it reads along with. */
  const toldBook = (title: string, seconds = 150) => {
    const reader = path.join(dir, title);
    mp3(path.join(reader, "An Author", title, "01.mp3"), { title, album: title, artist: "An Author" }, undefined, seconds);
    epub(path.join(reader, "An Author", title, `${title}.epub`), "Chapter One", SENTENCES);
    return reader;
  };

  /** A machine that opens EPUBs, with the tool the app's own Rust is. */
  const readsEpubs = (): Host => {
    const tool = builtTool("ribbon-ebook");
    expect(tool, "build the EPUB tool first: cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    const run = promisify(execFile);
    const cache = mkdtempSync(path.join(dir, "ebook-"));
    return { ...nodeHost(), openEbook: async (file) => (await run(tool!, [file, cache], { maxBuffer: 1 << 26 })).stdout };
  };

  /**
   * A machine that hears. Whisper is the one thing not here, since it needs a
   * graphics card: everything around it is the app's own. `before` runs ahead
   * of each answer, to hold the hearing partway.
   */
  const aHearingDesktop = async (before: () => Promise<void> = async () => undefined) => {
    const heard: number[] = [];
    const host: Host = {
      ...readsEpubs(),
      speechTranscribe: async (_model, clips, seconds) => {
        await before();
        return clips.map((clip) => {
          heard.push(clip.startMs);
          return [{ startMs: clip.startMs, endMs: clip.startMs + seconds * 1000, words: SENTENCES.join(" ") }];
        });
      },
    };
    const settings = memorySettings();
    await settings.write({ speechModel: "ggml-small.bin", speechClipMs: 100 });
    return { heard, ...(await aDesktop("admin", { host, settings })) };
  };

  const transcribed = () => asked<{ books: { title: string; done: number; total: number }[] }>("/api/library/transcripts").then((r) => r.books);
  const serverWithTools = () => start({ ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") });

  it("transcribes a server's book whole and sends it, so every device can read along", async () => {
    await serverWithTools();
    await importAs(server, admin, toldBook("Told Book"));
    expect((await transcribed())[0]!.done).toBe(0);

    const { app, heard } = await aHearingDesktop();

    await soon(transcribed).toEqual([expect.objectContaining({ done: 3, total: 3 })]);
    expect([...heard].sort((a, b) => a - b)).toEqual([0, 60_000, 120_000]);
    // Downloaded only to be heard: taken off again, as it came.
    await soon(() => book(app, "Told Book").remote).toBeTruthy();

    const { app: other } = await aDesktop();
    const id = book(other, "Told Book").book.id;
    await other.downloadBook(id);
    const aligned = await new LibraryService(nodeHost(), root(other)).readAligned(id);
    expect([...aligned.spans.keys()].sort((a, b) => a - b)).toEqual([0, 60_000, 120_000]);
  }, 60_000);

  it("transcribes a book that arrives while it's open, as a move brings them", async () => {
    await serverWithTools();
    await importAs(server, admin, shelf);
    await aHearingDesktop();

    await importAs(server, admin, toldBook("Arrived Later"));

    await soon(transcribed).toEqual([expect.objectContaining({ title: "Arrived Later", done: 3, total: 3 })]);
  }, 60_000);

  it("transcribes an audiobook downloaded here before its EPUB was put beside it and its folder added again", async () => {
    await serverWithTools();
    const reader = path.join(dir, "EPUB Later");
    const folder = path.join(reader, "An Author", "EPUB Later");
    mp3(path.join(folder, "01.mp3"), { title: "EPUB Later", album: "EPUB Later", artist: "An Author" }, undefined, 150);
    await importAs(server, admin, reader);
    expect(await transcribed()).toEqual([]);
    const { app } = await aHearingDesktop();
    await app.downloadBook(book(app, "EPUB Later").book.id);
    expect(book(app, "EPUB Later").book.ebook).toBeUndefined();

    epub(path.join(folder, "EPUB Later.epub"), "Chapter One", SENTENCES);
    await importAs(server, admin, reader);

    await soon(transcribed).toEqual([expect.objectContaining({ title: "EPUB Later", done: 3, total: 3 })]);
    // The copy here has the EPUB beside it now, and stays: it was downloaded to keep, not only to be heard.
    expect(book(app, "EPUB Later").book.ebook).toBeDefined();
    expect(book(app, "EPUB Later").remote).toBeUndefined();
  }, 60_000);

  it("reads along once the transcript is whole, though it wasn't when the book was last opened", async () => {
    // The High Kâhl's Oath on the PC: opened while it was being transcribed, closed, transcribed whole in the background,
    // sent and taken off, then downloaded and opened again, it stayed read only until Ribbon was restarted. The reader
    // had kept the records it read the first time, and never read the whole transcript beside the book (#219).
    await serverWithTools();
    // Nine minutes: two calls to the speech model, the second held until the book has been opened and closed.
    await importAs(server, admin, toldBook("Told Book", 540));
    let calls = 0;
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const { app } = await aHearingDesktop(async () => {
      if (++calls > 1) await released;
    });
    await soon(() => calls).toBe(2);

    // Opened partway: eight minutes of nine transcribed, so it opens to read only.
    const id = book(app, "Told Book").book.id;
    await app.openReading(id);
    expect(app.getState().reading).toMatchObject({ bookId: id, status: "ready" });
    expect(app.getState().reading!.readsAlong).toBeFalsy();
    await app.closeReading();

    // The last minute heard, the whole transcript sent, and the download taken off, as it came.
    release();
    await soon(transcribed).toEqual([expect.objectContaining({ done: 9, total: 9 })]);
    await soon(() => book(app, "Told Book").remote).toBeTruthy();

    // Opened again in the same session: downloaded with the whole transcript, it reads along.
    await app.openReading(book(app, "Told Book").book.id);
    expect(app.getState().reading).toMatchObject({ bookId: id, status: "ready" });
    await soon(() => app.getState().reading!.readsAlong).toBe(true);
    await app.closeReading();
  }, 90_000);

  it("finds a line in a server's books, as the Apple app does, and opens the reader on it", async () => {
    // A line from The Lion searched on the desktop found thirty books by their titles and no line: the desktop never
    // asked the server, which finds it at once for the Apple app.
    await serverWithTools();
    await importAs(server, admin, toldBook("Told Book"));
    const { app } = await aDesktop("admin", { host: readsEpubs() });
    const told = book(app, "Told Book");
    expect(told.remote).toBeTruthy();

    const lines = await app.findLines("a giant circle of wraithbone");
    expect(lines[0]).toMatchObject({ bookId: told.book.id, sentence: 2, chapter: "Chapter One", text: SENTENCES[1], matches: [[7, 28]] });

    // Still on the server: downloaded, then opened on the line, marked.
    await app.readLine(lines[0]!);
    expect(book(app, "Told Book").remote).toBeUndefined();
    const r = app.getState().reading!;
    expect(r).toMatchObject({ bookId: told.book.id, status: "ready" });
    expect(r.text!.text(r.found!)).toBe(SENTENCES[1]);
    expect(r.place).toEqual(r.found!.from);

    // Reading on takes the mark away.
    app.moveReading({ ...r.place!, offset: 0 }, "seek");
    expect(app.getState().reading!.found).toBeUndefined();
    await app.closeReading();
  }, 60_000);

  it("finds no lines on a server out of reach, and says nothing", async () => {
    await stocked();
    const { app } = await aDesktop();
    await server.app.close();

    expect(await app.findLines("a giant circle of wraithbone")).toEqual([]);
    expect(app.getState().error).toBeNull();
  }, 30_000);
});
