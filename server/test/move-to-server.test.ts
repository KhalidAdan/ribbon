import { mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppController, type Platform } from "../../src/app/controller.ts";
import { memorySettings, memorySources } from "../../src/app/platform.ts";
import { deviceFileName, encodeRecord, logName, mergePlaces, mergeTextPlaces, ribbonClaim, textClaim, type DeviceInfo, type LogRecord } from "../../src/core/poslog.ts";
import { localIdOf, type ServerBook } from "../../src/core/server-books.ts";
import { nodeHost } from "../../src/host/node.ts";
import type { RibbonServer } from "../src/app.ts";
import { epub, importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

const MAC: DeviceInfo = { id: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Ribbon on the Mac", app: "Ribbon 0.22" };
const PC: DeviceInfo = { id: "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Ribbon on the PC", app: "Ribbon 0.22" };
const START = 1_790_000_000_000;

/** When a record was written, `minutes` after the start of the test. */
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

/** A place in an audiobook, as the desktop appends it to its log (docs/POSITION-FORMAT.md, section 3.1). */
const pos = (dev: string, minutes: number, book: string, ms: number) => ({ v: 1, dev, seq: START + minutes * 60_000, t: at(minutes), k: "pos", book: { ids: [book] }, why: "pause", ms }) as LogRecord;

/**
 * Someone who used Ribbon alone and then added a server, with nothing stood
 * in for: the desktop's own controller, signed in to a real server, moving a
 * real folder whose logs say where they were.
 */
describe("moving to a server", () => {
  let dir: string;
  let shelf: string;
  let copies: string;
  let server: RibbonServer;
  let admin = "";
  let url = "";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-move-"));
    ({ shelf, copies } = makeLibraries(dir));
    ({ server, admin } = await serverWithAdmin(dir));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  }, 60_000);
  afterEach(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a device's log into a library's `.ribbon/positions/`, as the desktop leaves it. */
  const writeLog = async (library: string, device: DeviceInfo, records: readonly LogRecord[]) => {
    const positions = path.join(library, ".ribbon", "positions");
    await mkdir(positions, { recursive: true });
    await writeFile(path.join(positions, deviceFileName(device.id)), `${JSON.stringify(device)}\n`);
    await writeFile(path.join(positions, logName(device.id)), records.map((r) => encodeRecord(r)).join(""));
  };

  const asked = (at: string) => server.app.inject({ method: "GET", url: at, headers: { authorization: `Bearer ${admin}` } });
  const serverBooks = async () => ((await asked("/api/books")).json() as { books: ServerBook[] }).books;
  const placesOnServer = async () => ((await asked("/api/places")).json() as { records: LogRecord[]; devices: DeviceInfo[] });

  /** The book the desktop's scan calls `title` in a folder: the id its records are written under. */
  const folderBook = async (library: string, title: string) => {
    const app = desktop();
    await app.addFolder(library);
    const book = app.getState().books.find((b) => b.book.title === title)!.book;
    await app.removeSource(app.getState().sources[0]!.id);
    return book.id;
  };

  /** The desktop app on this computer, with a Ribbon folder of its own. */
  const desktop = () => {
    const home = path.join(dir, "home");
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    return new AppController(platform);
  };

  /** The whole of it, as a person does it: a folder on the shelf, sign in to the server, say yes. */
  const moveFolder = async (library: string) => {
    const app = desktop();
    await app.addFolder(library);
    await app.connectServer(url, "admin", "a long password");
    expect(app.getState().moveOffer).toHaveLength(1);
    await app.moveFolders();
    return app;
  };

  it("carries the place in each book over, under the server's own id for it", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000), pos(MAC.id, 5, ribbonClaim(red), 2200)]);

    const job = (await importAs(server, admin, shelf)).job;

    expect(job.state).toBe("done");
    expect(job.progress.places).toBe(2);
    const book = (await serverBooks()).find((b) => b.title === "Red Book")!;
    const { records, devices } = await placesOnServer();
    expect(mergePlaces(records).get(localIdOf(book))?.ms).toBe(2200);
    expect(devices).toContainEqual({ id: MAC.id, name: MAC.name });
  });

  it("keeps a reading place, a bookmark and a listening session too", async () => {
    const red = await folderBook(shelf, "Red Book");
    const reading = { v: 1, dev: MAC.id, seq: START + 1, t: at(1), k: "pos", book: { ids: [textClaim(red)] }, why: "pause", loc: { href: "chapter-1.xhtml", locations: { progression: 0.4, totalProgression: 0.4 } } };
    const mark = { v: 1, dev: MAC.id, seq: START + 2, t: at(2), k: "mark", book: { ids: [ribbonClaim(red)] }, id: "urn:uuid:11111111-1111-4111-8111-111111111111", motivation: "bookmarking", created: at(2), target: { ms: 1500 }, body: "Remember this" };
    const session = { v: 1, dev: MAC.id, seq: START + 3, t: at(3), k: "session", book: { ids: [ribbonClaim(red)] }, start: at(0), end: at(3), from_ms: 0, to_ms: 2500, listened_ms: 2500 };
    await writeLog(shelf, MAC, [reading, mark, session] as LogRecord[]);

    await importAs(server, admin, shelf);

    const book = (await serverBooks()).find((b) => b.title === "Red Book")!;
    const { records } = await placesOnServer();
    const here = localIdOf(book);
    expect(mergeTextPlaces(records).get(here)?.loc.locations?.progression).toBe(0.4);
    expect(records.find((r) => r.k === "mark")?.book.ids).toEqual([ribbonClaim(here)]);
    expect(records.find((r) => r.k === "session")?.book.ids).toEqual([ribbonClaim(here)]);
  });

  it("takes in every device that used the folder, each as itself", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000)]);
    await writeLog(shelf, PC, [pos(PC.id, 9, ribbonClaim(red), 2600)]);

    await importAs(server, admin, shelf);

    const book = (await serverBooks()).find((b) => b.title === "Red Book")!;
    const { records, devices } = await placesOnServer();
    expect(new Set(records.map((r) => r.dev))).toEqual(new Set([MAC.id, PC.id]));
    expect(mergePlaces(records).get(localIdOf(book))?.ms).toBe(2600);
    expect(devices.map((d) => d.name).sort()).toEqual([MAC.name, PC.name]);
  });

  it("adds nothing twice, and an old place never gets ahead of a newer one", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000)]);
    expect((await importAs(server, admin, shelf)).job.progress.places).toBe(1);
    const book = (await serverBooks()).find((b) => b.title === "Red Book")!;
    // Listening has gone on from the server's copy, on another device, since the folder came in.
    const newer = pos(PC.id, 60, ribbonClaim(localIdOf(book)), 2900);
    await server.app.inject({ method: "POST", url: "/api/places", headers: { authorization: `Bearer ${admin}` }, payload: { device: { id: PC.id, name: PC.name }, records: [newer] } });

    const again = (await importAs(server, admin, shelf)).job;

    expect(again.progress.places).toBe(0);
    expect(mergePlaces((await placesOnServer()).records).get(localIdOf(book))?.ms).toBe(2900);
  });

  it("brings a place in for a book the server already had", async () => {
    await importAs(server, admin, shelf);
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1700)]);

    const job = (await importAs(server, admin, shelf)).job;

    expect(job.progress.added).toBe(0);
    expect(job.progress.places).toBe(1);
    const book = (await serverBooks()).find((b) => b.title === "Red Book")!;
    expect(mergePlaces((await placesOnServer()).records).get(localIdOf(book))?.ms).toBe(1700);
  });

  it("finds a book's place in a library above the folder added", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1100)]);

    const job = (await importAs(server, admin, path.join(shelf, "Author One"))).job;

    expect(job.progress.places).toBe(1);
  });

  it("brings the place in a book with no audio", async () => {
    const reader = path.join(dir, "reader");
    epub(path.join(reader, "Only Text", "Only Text.epub"), "Only Text", ["One sentence.", "Another sentence."]);
    const only = await folderBook(reader, "Only Text");
    await writeLog(reader, MAC, [{ v: 1, dev: MAC.id, seq: START, t: at(0), k: "pos", book: { ids: [textClaim(only)] }, why: "pause", loc: { href: "chapter-1.xhtml", locations: { progression: 0.5, totalProgression: 0.5 } } } as LogRecord]);

    await importAs(server, admin, reader);

    const book = (await serverBooks()).find((b) => b.title === "Only Text")!;
    expect(mergeTextPlaces((await placesOnServer()).records).get(localIdOf(book))?.loc.locations?.progression).toBe(0.5);
  });

  it("leaves out records about other books, and writes nothing into the folder", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000), pos(MAC.id, 1, ribbonClaim("not-in-this-folder"), 500)]);
    const before = snapshot(shelf);

    await importAs(server, admin, shelf);

    expect((await placesOnServer()).records).toHaveLength(1);
    expect(snapshot(shelf)).toEqual(before);
  });

  it("reads only the logs in a folder's positions, whatever else has come to be there", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000)]);
    // A network drive's own folder of thumbnails, as a Synology leaves in what it indexes.
    await mkdir(path.join(shelf, ".ribbon", "positions", "@eaDir"));

    const job = (await importAs(server, admin, shelf)).job;

    expect(job.progress).toMatchObject({ failed: 0, places: 1 });
  });

  it("gives the places to the person who added the folder, and nobody else", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 1000)]);
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    const brother = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;

    await importAs(server, admin, shelf);

    const theirs = (await server.app.inject({ method: "GET", url: "/api/places", headers: { authorization: `Bearer ${brother}` } })).json() as { records: LogRecord[] };
    expect(theirs.records).toEqual([]);
  });

  it("shows each book once afterwards, from the server, with its place", async () => {
    const red = await folderBook(shelf, "Red Book");
    await writeLog(shelf, MAC, [pos(MAC.id, 0, ribbonClaim(red), 2100)]);

    const app = await moveFolder(shelf);

    expect(app.getState().sources.map((s) => s.server?.url)).toEqual([url]);
    await expect.poll(() => app.getState().books.filter((b) => b.book.title === "Red Book")).toHaveLength(1);
    const book = app.getState().books.find((b) => b.book.title === "Red Book")!;
    await expect.poll(() => app.getState().positions[book.book.id]?.offsetMs).toBe(2100);
    expect(statSync(path.join(shelf, ".ribbon", "positions", logName(MAC.id))).isFile()).toBe(true);
  }, 30_000);

  it("moves every folder offered, and a book in two of them is one book", async () => {
    const app = desktop();
    await app.addFolder(shelf);
    await app.addFolder(copies);
    await app.connectServer(url, "admin", "a long password");
    expect(app.getState().moveOffer).toHaveLength(2);

    await app.moveFolders();

    expect(app.getState().sources.every((s) => s.server)).toBe(true);
    await expect.poll(() => app.getState().books.map((b) => b.book.title).sort()).toEqual(["Long Book", "Red Book"]);
  }, 30_000);

  it("leaves everything as it was on Not now, and asks again from the folder", async () => {
    const app = desktop();
    await app.addFolder(shelf);
    await app.connectServer(url, "admin", "a long password");

    app.dismissMove();

    expect(app.getState().moveOffer).toBeNull();
    expect(app.getState().sources.some((s) => !s.server)).toBe(true);
    expect((await serverBooks()).length).toBe(0);
    const folder = app.getState().sources.find((s) => !s.server)!;
    app.offerMove(folder.id);
    expect(app.getState().moveOffer).toEqual([folder.id]);
  }, 30_000);

  it("keeps a folder the server can't reach on the shelf, and says why", async () => {
    const app = desktop();
    await app.addFolder(shelf);
    await app.connectServer(url, "admin", "a long password");
    const moved = path.join(dir, "moved-away");
    renameSync(shelf, moved);

    await app.moveFolders();

    expect(app.getState().sources.some((s) => !s.server)).toBe(true);
    expect(app.getState().error).toMatch(/can't see/);
  }, 30_000);

  it("offers nothing to someone signing in as anyone but the admin", async () => {
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } });
    const app = desktop();
    await app.addFolder(shelf);

    await app.connectServer(url, "brother", "a long password");

    expect(app.getState().moveOffer).toBeNull();
  }, 30_000);
});

/** Every file under a folder, with its size and when it last changed. */
function snapshot(folder: string): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const name of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
    const file = path.join(folder, name);
    const info = statSync(file);
    if (info.isFile()) seen[name] = `${info.size} ${info.mtimeMs}`;
  }
  return seen;
}
