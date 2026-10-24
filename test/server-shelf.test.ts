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
import { localIdOf, type ServerBook, type ServerBookDetail } from "../src/core/server-books";
import { nodeHost } from "../src/host/node";

const SERVER_ID = "a1b2c3d4e5f60718";
const TOKEN = "the-token";
const COVER = "c0ffee00c0ffee00";

/**
 * A stand-in for a Ribbon server: the four answers the app's shelf asks
 * for (server/src/library/api.ts), from files made here, signed in with
 * one token.
 */
describe("a server's shelf on this device", () => {
  let fixtures: string;
  let server: Server;
  let url: string;
  let listed: ServerBook;
  let detail: ServerBookDetail;
  const asked: string[] = [];

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
      if (at === "/api/books") {
        if (req.headers["if-none-match"] === 'W/"1"') res.writeHead(304).end();
        else res.writeHead(200, { "content-type": "application/json", etag: 'W/"1"' }).end(JSON.stringify({ books: [listed] }));
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
      const picture = at.match(new RegExp(`^/covers/${COVER}-(400|800)\\.jpg$`));
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
