import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppController, serverUrl, type Platform } from "../src/app/controller";
import { LibraryService } from "../src/app/library";
import { memorySettings, memorySources } from "../src/app/platform";
import { ServerClient, ServerError, takeEvents } from "../src/app/server/client";
import { NotEnoughSpace, ServerShelf } from "../src/app/server/shelf";
import { scanLibrary } from "../src/core/scan/scan";
import { localIdOf, type ServerBook, type ServerBookDetail, type ServerSeries } from "../src/core/server-books";
import { nodeHost } from "../src/host/node";

const SERVER_ID = "a1b2c3d4e5f60718";
const TOKEN = "the-token";
const COVER = "c0ffee00c0ffee00";
/** The hash of the cover the admin chooses here, as the server makes it from their picture. */
const CHOSEN = "c0ffee00c0ffee01";

/**
 * A stand-in for a Ribbon server: the answers the app's shelf asks for
 * (server/src/library/api.ts), from files made here, signed in with one
 * token, and its series, which the admin changes (routes.ts).
 */
describe("a server's shelf on this device", () => {
  let fixtures: string;
  let server: Server;
  let url: string;
  let listed: ServerBook;
  let detail: ServerBookDetail;
  const asked: string[] = [];
  /** The server's series; null makes it a server from before it kept series. */
  let series: ServerSeries[] | null = null;
  /** What was asked of its series and its books' edits: method, address and body. */
  const changes: { method: string; at: string; body: unknown }[] = [];
  /** Who the one person signed in is; null answers as a server that doesn't say, so the app isn't its admin. */
  let role: string | null = null;
  /** The edits its admin made to its book, laid over the list as the server does (server/src/library/books.ts). */
  let bookEdits: { values: Record<string, string>; updatedAt: string } | null = null;
  /** The picture its admin chose for the book's cover, as it came, or null for the book's own. */
  let chosenPicture: Buffer | null = null;
  /** Counts changes to the edits, for the list's ETag. */
  let editsVersion = 0;
  /** The book as the server lists it: edited, with what its files say for each listed field edited, and the cover chosen for it. */
  const served = (): ServerBook => {
    if (!bookEdits && !chosenPicture) return listed;
    const values = bookEdits?.values ?? {};
    const fields = (["title", "author", "narrator"] as const).filter((f) => values[f] !== undefined);
    const chosen = chosenPicture ? { cover: { hash: CHOSEN, aspect: 0.667, colour: "#00fe00" } } : {};
    return { ...listed, ...Object.fromEntries(fields.map((f) => [f, values[f]])), ...chosen, edited: { values, original: Object.fromEntries(fields.map((f) => [f, listed[f]])), updatedAt: bookEdits?.updatedAt ?? "", ...(chosenPicture ? { chosenCover: true as const } : {}) } };
  };

  beforeAll(async () => {
    fixtures = mkdtempSync(path.join(tmpdir(), "ribbon-shelf-fixtures-"));
    for (const n of ["01", "02"]) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", path.join(fixtures, `${n}.mp3`)]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=200x300:d=1", "-frames:v", "1", path.join(fixtures, "cover.jpg")]);
    const sizes = ["01", "02"].map((n) => statSync(path.join(fixtures, `${n}.mp3`)).size);
    const cover = { hash: COVER, aspect: 0.667, colour: "#0000fe" };
    listed = { id: SERVER_ID, title: "The Blue Book", author: "Ann Author", narrator: "Nell Narrator", series: "", seriesIndex: null, durationMs: 6000, sizeBytes: sizes[0]! + sizes[1]!, audio: true, ebook: false, ebookBytes: null, cover, addedAt: "2026-10-22T00:00:00.000Z" };
    detail = {
      book: { id: SERVER_ID, title: "The Blue Book", author: "Ann Author", narrator: "Nell Narrator", series: "", seriesIndex: null },
      files: [
        { path: "audio/01.mp3", sizeBytes: sizes[0]! },
        { path: "audio/02.mp3", sizeBytes: sizes[1]! },
      ],
      cover,
      // Measured once on the server: a device keeps this rather than measuring the book itself.
      analysis: { loudness: { integratedLufs: -20, truePeakDbtp: -3 }, silence: [{ file: 0, ranges: [{ startMs: 1_000, endMs: 2_000 }] }] },
      // What was heard of it, carried in from its folder: a device keeps it rather than listening again.
      records: ["heard"],
    };

    server = createServer((req, res) => {
      const at = req.url ?? "";
      asked.push(at);
      if (at === "/api/auth/sign-in/username" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const { username, password } = JSON.parse(body) as { username: string; password: string };
          if (username === "Ann" && password === "the-password") res.writeHead(200, { "content-type": "application/json", "set-auth-token": TOKEN }).end("{}");
          else res.writeHead(401).end();
        });
        return;
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (at === "/api/me") {
        if (role) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: { name: "Ann", role } }));
        else res.writeHead(404).end();
        return;
      }
      if (at === `/api/books/${SERVER_ID}/edits` && req.method === "PUT") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const asked = JSON.parse(body) as { values: Record<string, string>; cover?: { image: string } | null };
          changes.push({ method: "PUT", at, body: asked });
          // As the server does: only its admin edits, and the last edits sent stand, none taking them back.
          if (role !== "admin") {
            res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Only the admin can edit the library's books." }));
            return;
          }
          bookEdits = Object.keys(asked.values).length > 0 ? { values: asked.values, updatedAt: new Date().toISOString() } : null;
          if (asked.cover !== undefined) chosenPicture = asked.cover && Buffer.from(asked.cover.image, "base64");
          editsVersion++;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ edits: asked }));
        });
        return;
      }
      if (at.startsWith("/api/series")) {
        if (!series) {
          res.writeHead(404).end();
          return;
        }
        if (req.method === "GET") {
          const etag = `W/"${JSON.stringify(series).length}"`;
          if (req.headers["if-none-match"] === etag) res.writeHead(304).end();
          else res.writeHead(200, { "content-type": "application/json", etag }).end(JSON.stringify({ series }));
          return;
        }
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const asked = body ? (JSON.parse(body) as { name: string; books: { id: string; number?: number | null; shelved: boolean }[] }) : null;
          changes.push({ method: req.method!, at, body: asked });
          const id = decodeURIComponent(at.split("/")[3] ?? "");
          if (req.method === "DELETE") series = series!.filter((s) => s.id !== id);
          else {
            const had = series!.find((s) => s.id === id);
            // As the server does: a number left out keeps the one the book had in this series, and a null clears it.
            const books = asked!.books.map((b) => ({ id: b.id, number: b.number !== undefined ? b.number : (had?.books.find((x) => x.id === b.id)?.number ?? null), title: had?.books.find((x) => x.id === b.id)?.title ?? null, shelved: b.shelved }));
            series = [...series!.filter((s) => s.id !== id), { id: id || asked!.name.toLowerCase().replace(/\W+/g, "-"), name: asked!.name, books }];
          }
          res.writeHead(req.method === "DELETE" ? 204 : 200, { "content-type": "application/json" }).end(req.method === "DELETE" ? undefined : "{}");
        });
        return;
      }
      if (at === "/api/books") {
        const answer = JSON.stringify({ books: [served()] });
        const etag = `W/"${answer.length}-${editsVersion}"`;
        if (req.headers["if-none-match"] === etag) res.writeHead(304).end();
        else res.writeHead(200, { "content-type": "application/json", etag }).end(answer);
        return;
      }
      if (at === `/api/books/${SERVER_ID}`) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(detail));
        return;
      }
      if (at === `/api/books/${SERVER_ID}/files/records/heard.csv`) {
        res.writeHead(200).end("audio_ms,words,chars\n0,In the beginning,\n");
        return;
      }
      if (at === `/api/books/${SERVER_ID}/files/records/corrections.csv`) {
        res.writeHead(200).end("op,index,start_ms,title\nrename,0,,One\nrename,1,,Two\n");
        return;
      }
      const file = at.match(new RegExp(`^/api/books/${SERVER_ID}/files/audio/(0[12]\\.mp3)$`))?.[1];
      const picture = at.match(new RegExp(`^/covers/(${COVER}|${CHOSEN})-(400|800)\\.jpg$`));
      if (file || picture) {
        res.writeHead(200).end(readFileSync(path.join(fixtures, file ?? "cover.jpg")));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    rmSync(fixtures, { recursive: true, force: true });
  });

  const folder = () => mkdtempSync(path.join(tmpdir(), "ribbon-shelf-"));

  it("asks for the list, then only whether it changed", async () => {
    const root = folder();
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    expect(await shelf.refresh()).toBe(true);
    expect(await shelf.refresh()).toBe(false);
    expect(shelf.remote([]).map((b) => b.book.id)).toEqual([localIdOf(listed)]);

    // Next launch: the list kept in the folder draws the shelf before the server answers.
    const again = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await again.loadCached();
    expect(again.remote([]).map((b) => b.book.title)).toEqual(["The Blue Book"]);
    expect(await again.refresh()).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("fetches each cover once, and shows it only once it's here", async () => {
    const root = folder();
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await shelf.refresh();
    expect(shelf.hasCover(COVER)).toBe(false);
    asked.length = 0;
    expect(await shelf.fetchCovers()).toBe(1);
    expect(shelf.hasCover(COVER)).toBe(true);
    expect(await shelf.fetchCovers()).toBe(0);
    expect(asked.filter((a) => a.startsWith("/covers/"))).toHaveLength(1);

    // Out of reach: the cover already here still counts.
    const offline = new ServerShelf(new ServerClient("http://127.0.0.1:9", TOKEN), nodeHost(), root);
    await offline.loadCached();
    expect(await offline.fetchCovers()).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("downloads a book the scanner then knows by the id the shelf showed", async () => {
    const root = folder();
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await shelf.refresh();
    const [remote] = shelf.remote([]);
    const seen: number[] = [];
    await shelf.download(remote!, (done) => seen.push(done));
    expect(seen.at(-1)).toBe(listed.sizeBytes);

    const { books } = await scanLibrary(nodeHost(), root, { write: false });
    expect(books).toHaveLength(1);
    expect(books[0]!.book).toMatchObject({ id: remote!.book.id, title: "The Blue Book", narrator: "Nell Narrator", cover: `${SERVER_ID}/cover.jpg` });
    expect(shelf.remote(books)).toEqual([]);

    // Taken off this device: the book goes, the records stay.
    await shelf.removeAll();
    expect((await scanLibrary(nodeHost(), root, { write: false })).books).toEqual([]);
    expect(statSync(path.join(root, ".ribbon", "server-books.json")).isFile()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("describes and names a book downloaded before the server filled them in, from the next scan", async () => {
    const root = folder();
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await shelf.refresh();
    const [remote] = shelf.remote([]);
    await shelf.download(remote!, () => undefined);
    const before = (await scanLibrary(nodeHost(), root, { write: false })).books[0]!;
    expect(before.book.description).toBeUndefined();
    expect(before.chapters.map((c) => c.title)).toEqual(["01", "02"]);

    // The server filled in the description and the chapters' names from the book's EPUB since.
    detail.book.description = "A book about the colour blue.";
    detail.records = ["heard", "corrections"];
    try {
      // What the app does before the book next opens.
      const now = await shelf.client.book(SERVER_ID);
      await shelf.keepRecords(now, remote!.book.id);
      await shelf.keepDetails(now);
      const after = (await scanLibrary(nodeHost(), root, { write: false })).books[0]!;
      expect(after.book).toMatchObject({ title: "The Blue Book", description: "A book about the colour blue." });
      expect(after.chapters.map((c) => c.title)).toEqual(["One", "Two"]);
    } finally {
      delete detail.book.description;
      detail.records = ["heard"];
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says how much room a book needs before downloading any of it", async () => {
    const root = folder();
    const host = { ...nodeHost(), freeSpace: async () => 1024 };
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), host, root);
    await shelf.refresh();
    const error = await shelf.download(shelf.remote([])[0]!, () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotEnoughSpace);
    expect((error as NotEnoughSpace).neededBytes).toBeGreaterThan(listed.sizeBytes);
    expect((error as NotEnoughSpace).freeBytes).toBe(1024);
    expect((await scanLibrary(nodeHost(), root, { write: false })).books).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("joins the shelf when connected, and is found again on the next start, wherever the app's folder moved", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const settings = memorySettings();
    const sources = memorySources();
    const platform = (home: string): Platform => ({ host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources, appSettings: settings, home: { path: async () => home, reveal: async () => undefined, reset: async () => false } });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    };

    const home = folder();
    const first = new AppController(platform(home));
    await first.boot();
    await expect(first.connectServer(url, "Ann", "not-it")).rejects.toThrow(/don't match/);
    await first.connectServer(url.replace("http://", ""), "Ann", "the-password");
    await until(() => first.getState().books.some((b) => b.remote));
    const remote = first.getState().books.find((b) => b.remote)!;
    expect(remote.book.title).toBe("The Blue Book");
    await first.downloadBook(remote.book.id);
    expect(first.getState().books.find((b) => b.book.id === remote.book.id)?.remote).toBeUndefined();
    // What the server measured is kept beside the book, so this device never measures it.
    const kept = new LibraryService(nodeHost(), first.getState().sources[0]!.root);
    expect(await kept.readLoudness(remote.book.id)).toMatchObject({ measurement: { integratedLufs: -20, truePeakDbtp: -3 } });
    expect((await kept.readSilence(remote.book.id))?.get(0)).toEqual([{ startMs: 1_000, endMs: 2_000 }]);
    expect((await kept.readHeard(remote.book.id)).heard).toEqual(new Map([[0, "In the beginning"]]));

    // An iPhone's app folder moves when the app is updated: the server's folder moves with it.
    const moved = `${home}-moved`;
    await fsp.rename(home, moved);
    const next = new AppController(platform(moved));
    await next.boot();
    await until(() => next.getState().books.length > 0);
    expect(next.getState().sources.map((s) => s.server)).toEqual([{ url, person: "Ann" }]);
    expect(next.getState().sources[0]!.root.startsWith(moved)).toBe(true);
    expect(next.getState().books.map((b) => [b.book.id, !!b.remote])).toEqual([[remote.book.id, false]]);

    // Taken off this device: the book goes back to the server, and what was kept beside it goes too.
    await next.removeDownload(remote.book.id);
    expect(next.getState().books.map((b) => [b.book.id, !!b.remote])).toEqual([[remote.book.id, true]]);
    const left = new LibraryService(nodeHost(), next.getState().sources[0]!.root);
    expect((await left.readHeard(remote.book.id)).heard.size).toBe(0);
    expect(await left.readLoudness(remote.book.id)).toBeNull();

    // Disconnecting takes the downloads and the sign-in.
    await next.removeSource(next.getState().sources[0]!.id);
    expect((await settings.read()).serverTokens).toEqual({});
    vi.restoreAllMocks();
    rmSync(moved, { recursive: true, force: true });
  });

  it("keeps an edit and a chosen cover on the server, and shows them on the next start and once downloaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    role = "admin";
    const home = folder();
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const id = localIdOf(listed);
    const bookIn = (app: AppController) => app.getState().books.find((b) => b.book.id === id);
    changes.length = 0;

    const app = new AppController(platform);
    await app.boot();
    await app.connectServer(url, "Ann", "the-password");
    await until(() => !!bookIn(app)?.remote);
    await app.saveEdits(id, { title: "The Bluest Book", narrator: "Someone Else", author: "Ann Author" });
    // Only what changed in the form goes, and the shelf shows what the server then lists.
    expect(changes.at(-1)).toEqual({ method: "PUT", at: `/api/books/${SERVER_ID}/edits`, body: { values: { title: "The Bluest Book", narrator: "Someone Else" } } });
    expect(bookIn(app)).toMatchObject({ book: { title: "The Bluest Book", narrator: "Someone Else" }, original: { title: "The Blue Book" }, remote: { serverId: SERVER_ID } });

    // A cover chosen here goes to the server as a picture, with the edits it has, and shows as the server lists it.
    const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await app.setCover(id, picture, "jpg");
    expect(changes.at(-1)!.body).toEqual({ values: { title: "The Bluest Book", narrator: "Someone Else" }, cover: { image: Buffer.from(picture).toString("base64") } });
    await until(() => bookIn(app)?.edits?.cover !== undefined);
    expect(app.coverUrl(bookIn(app)!)).toContain(CHOSEN);

    // The next start shows the edits and the cover before anything is downloaded.
    const next = new AppController(platform);
    await next.boot();
    await until(() => !!bookIn(next)?.remote);
    expect(bookIn(next)!.book).toMatchObject({ title: "The Bluest Book", narrator: "Someone Else" });
    await until(() => bookIn(next)?.edits?.cover !== undefined);
    expect(next.coverUrl(bookIn(next)!)).toContain(CHOSEN);

    // Downloaded, the book keeps its id, and so its edits, against what the server's files say.
    await next.downloadBook(id);
    expect(bookIn(next)?.remote).toBeUndefined();
    expect(bookIn(next)).toMatchObject({ book: { title: "The Bluest Book", narrator: "Someone Else" }, original: { title: "The Blue Book", narrator: "Nell Narrator" } });
    // With the cover the server lists, not the one downloaded beside it.
    await until(() => !!next.coverUrl(bookIn(next)!));
    expect(next.coverUrl(bookIn(next)!)).toContain(CHOSEN);
    await next.removeSource(next.getState().sources[0]!.id);
    role = null;
    bookEdits = null;
    chosenPicture = null;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("sends a change with the server's edits, the last standing, takes them back, and says so when refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const home = folder();
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const id = localIdOf(listed);
    const bookIn = (app: AppController) => app.getState().books.find((b) => b.book.id === id);
    const sent = () => changes.filter((c) => c.at === `/api/books/${SERVER_ID}/edits`).map((c) => (c.body as { values: Record<string, string> }).values);
    changes.length = 0;

    // Someone who isn't the admin: refused, said so, and nothing changes.
    const app = new AppController(platform);
    await app.boot();
    await app.connectServer(url, "Ann", "the-password");
    await until(() => !!bookIn(app)?.remote);
    await app.saveEdits(id, { title: "Not Mine To Name" });
    expect(app.getState().error).toMatch(/Couldn't change The Blue Book on the server: Only the admin/);
    expect(bookIn(app)!.book.title).toBe("The Blue Book");

    // The admin: each change goes with the edits the server has, and the last stands.
    role = "admin";
    await app.saveEdits(id, { title: "Blue, Once" });
    await app.saveEdits(id, { title: "Blue, Once", narrator: "Another Voice" });
    expect(sent().slice(-2)).toEqual([{ title: "Blue, Once" }, { title: "Blue, Once", narrator: "Another Voice" }]);
    expect(bookIn(app)!.book).toMatchObject({ title: "Blue, Once", narrator: "Another Voice" });

    // Edited on another device: the next start shows it.
    bookEdits = { values: { title: "Blue, Elsewhere" }, updatedAt: new Date().toISOString() };
    editsVersion++;
    const next = new AppController(platform);
    await next.boot();
    await until(() => bookIn(next)?.book.title === "Blue, Elsewhere");
    expect(bookIn(next)).toMatchObject({ book: { title: "Blue, Elsewhere", narrator: "Nell Narrator" }, original: { title: "The Blue Book" } });

    // Taken back, one field, leaving the cover as it is, and then all of them, the cover too.
    await next.saveEdits(id, { narrator: "A Third Voice" });
    await next.resetEdits(id, "narrator");
    expect(changes.at(-1)!.body).toEqual({ values: { title: "Blue, Elsewhere" } });
    await next.resetEdits(id);
    expect(changes.at(-1)!.body).toEqual({ values: {}, cover: null });
    expect(bookIn(next)!.book.title).toBe("The Blue Book");

    await next.removeSource(next.getState().sources[0]!.id);
    role = null;
    bookEdits = null;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("takes the server's series, its books by their ids here, and finds none itself from a server that keeps none", async () => {
    const root = folder();
    const shelf = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await shelf.refresh();
    series = null;
    expect(await shelf.refreshSeries()).toBe(false);
    expect(shelf.keepsSeries).toBe(false);

    series = [{ id: "blue-books", name: "The Blue Books", books: [{ id: SERVER_ID, number: 1, title: "Blue", shelved: true }] }];
    expect(await shelf.refreshSeries()).toBe(true);
    expect(await shelf.refreshSeries()).toBe(false);
    expect(shelf.seriesOnShelf()).toEqual({
      groups: [{ key: "blue-books", name: "The Blue Books", bookIds: [localIdOf(listed)], titles: { [localIdOf(listed)]: "Blue" } }],
      // Its number is the record's, where the series editor shows it as a person's.
      records: [{ key: "blue-books", name: "The Blue Books", decidedAt: "", choices: [{ bookId: localIdOf(listed), included: true, order: 1, number: 1 }] }],
    });
    // Next launch: the series kept in the folder show before the server answers.
    const again = new ServerShelf(new ServerClient(url, TOKEN), nodeHost(), root);
    await again.loadCached();
    expect(again.keepsSeries).toBe(true);
    expect(again.hasSeries("blue-books")).toBe(true);
    series = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("shows the server's series on the shelf, and keeps a change to one on the server, for every device", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    series = [{ id: "blue-books", name: "The Blue Books", books: [{ id: SERVER_ID, number: 1, title: "Blue", shelved: true }] }];
    changes.length = 0;
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => folder(), reveal: async () => undefined, reset: async () => false } };
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const app = new AppController(platform);
    await app.boot();
    await app.connectServer(url, "Ann", "the-password");
    // The record, not only the group: the shelf has the series a moment before the app's state does, while it keeps them in the folder.
    await until(() => app.getState().series["blue-books"] !== undefined);
    const local = localIdOf(listed);
    expect(app.detectedSeries()).toEqual([{ key: "blue-books", name: "The Blue Books", bookIds: [local], titles: { [local]: "Blue" } }]);

    // Renamed here, from the record the editor starts with: the server keeps it, by the book's id there, its number with it, and the shelf shows what the server says.
    app.openSeriesSetup("blue-books");
    await app.saveSeries(app.getState().series["blue-books"]!.choices, { name: "Blue, all of it" });
    expect(changes).toEqual([{ method: "PUT", at: "/api/series/blue-books", body: { name: "Blue, all of it", books: [{ id: SERVER_ID, shelved: true, number: 1 }] } }]);
    expect(app.detectedSeries().map((g) => [g.name, g.titles])).toEqual([["Blue, all of it", { [local]: "Blue" }]]);

    // Its number cleared in the editor: cleared on the server, not kept.
    app.openSeriesSetup("blue-books");
    await app.saveSeries([{ bookId: local, included: true, order: 1 }], { name: "Blue, all of it" });
    expect(changes.at(-1)).toEqual({ method: "PUT", at: "/api/series/blue-books", body: { name: "Blue, all of it", books: [{ id: SERVER_ID, shelved: true, number: null }] } });
    expect(series![0]!.books[0]!.number).toBeNull();
    expect(app.getState().series["blue-books"]!.choices).toEqual([{ bookId: local, included: true, order: 1 }]);

    // Deleted here: deleted on the server.
    await app.deleteSeries("blue-books");
    expect(changes.at(-1)).toMatchObject({ method: "DELETE", at: "/api/series/blue-books" });
    expect(app.detectedSeries()).toEqual([]);
    await app.removeSource(app.getState().sources[0]!.id);
    series = null;
    vi.restoreAllMocks();
  });

  it("asks to sign in again when the server no longer takes the sign-in", async () => {
    const shelf = new ServerShelf(new ServerClient(url, "an-old-token"), nodeHost(), folder());
    const error = await shelf.refresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(401);
  });
});

describe("a server's address as typed", () => {
  it("gets a scheme, plain HTTP only on this machine", () => {
    expect(serverUrl("localhost:7766")).toBe("http://localhost:7766");
    expect(serverUrl("127.0.0.1:7766/")).toBe("http://127.0.0.1:7766");
    expect(serverUrl(" books.example.net/ ")).toBe("https://books.example.net");
    expect(serverUrl("http://books.example.net:7766")).toBe("http://books.example.net:7766");
    expect(serverUrl("https://example.net/ribbon/")).toBe("https://example.net/ribbon");
  });
});

describe("the server's event stream", () => {
  it("reads whole events, skips comments, and keeps an event still arriving", () => {
    const { events, rest } = takeEvents(': connected\n\nevent: places\ndata: {"device":"urn:uuid:a"}\n\n: still here\n\nevent: books\ndata: {"add');
    expect(events).toEqual([{ type: "places", data: { device: "urn:uuid:a" } }]);
    expect(takeEvents(`${rest}ed":2}\n\n`).events).toEqual([{ type: "books", data: { added: 2 } }]);
  });
});
