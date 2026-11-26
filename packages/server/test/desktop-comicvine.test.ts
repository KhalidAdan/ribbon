import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Clock } from "@ribbon/core/comicvine-gate";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type Platform } from "../../desktop/src/app/controller.ts";
import { memorySettings, memorySources } from "../../desktop/src/app/platform.ts";
import type { RibbonServer } from "../src/app.ts";
import { STAND_IN_KEY, standIn, type StandIn } from "./comicvine/stand-in.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/** Time for the server's door to ComicVine that sleeps by moving on, so a test never waits its second and a half. */
function virtualClock(): Clock {
  let ahead = 0;
  return { now: () => Date.now() + ahead, sleep: async (ms) => void (ahead += ms) };
}

/**
 * The desktop looking a server's comic up on ComicVine (docs/BOOK-DETAILS.md,
 * section 7): the whole app, signed in as the admin over HTTP to a real
 * server whose owner set a key, with the server tests' stand-in for
 * ComicVine behind it. Every request to ComicVine is the server's; the
 * desktop asks the server's routes, and shows what it sends.
 */
describe("the desktop looking a server's comic up on ComicVine", () => {
  let dir: string;
  let stand: StandIn;
  let server: RibbonServer;
  let admin = "";
  let url = "";
  let app: AppController;

  const ISSUE_2 = "Made Up Saga #2: The Long Way Home";
  const ISSUE_1 = "Made Up Saga #1";
  const bookCalled = (title: string) => app.getState().books.find((b) => b.book.title === title)!;
  const soon = <T,>(value: () => T | Promise<T>) => expect.poll(value, { timeout: 10_000, interval: 50 });

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-desktop-comicvine-"));
    stand = await standIn();
    const library = path.join(dir, "library");
    // One comic whose file gives its issue's page on ComicVine, which the server matches by itself; one whose file gives none.
    await makeComic(path.join(library, "Made Up Saga", "Made Up Saga 002.cbz"), { pages: 2, comicInfo: comicInfoXml({ Series: "Made Up Saga", Number: "2", Writer: "Ada Quill", Web: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/" }) });
    await makeComic(path.join(library, "Made Up Saga", "Made Up Saga 001.cbz"), { pages: 2, comicInfo: comicInfoXml({ Series: "Made Up Saga", Number: "1", Writer: "Ada Quill" }) });
    ({ server, admin } = await serverWithAdmin(dir, { comicVine: { key: STAND_IN_KEY, api: stand.api } }, { comicVineClock: virtualClock() }));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    await importAs(server, admin, library);
    await server.jobs.idle("comicvine");

    const home = mkdtempSync(path.join(dir, "home-"));
    const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings(), home: { path: async () => home, reveal: async () => undefined, reset: async () => false } };
    app = new AppController(platform);
    await app.boot();
    await app.connectServer(url, "admin", "a long password");
    await vi.waitFor(() => expect(app.getState().books.length).toBe(2), { timeout: 10_000 });
    // The admin is known once the server says who's signed in.
    await vi.waitFor(() => expect(app.comicVineFor(bookCalled(ISSUE_1).book.id)).toBe("server"), { timeout: 10_000 });
  }, 60_000);

  afterAll(async () => {
    app.destroy();
    vi.restoreAllMocks();
    await server.app.close();
    server.db.close();
    await stand.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a comic the server matched with its own details and what ComicVine said, and a field's way back to ComicVine's", async () => {
    const matched = bookCalled(ISSUE_2);
    expect(matched.book).toMatchObject({ author: "Ada Quill; Ben Nib", series: "Made Up Saga (2018)" });
    // Its form asks for it in full: its people by role, its issue, its dates, and the match, to link back to.
    const shown = (await app.serverComicToEdit(matched.book.id))!;
    expect(shown.book).toMatchObject({ rawTitle: "The Long Way Home", issue: "2", coverDate: "2018-07", credits: { writers: ["Ada Quill"], letters: ["Di Pen"] }, publisher: "Made Up Press" });
    expect(shown.matched).toMatchObject({ address: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/", as: "issue", values: { title: "The Long Way Home" } });
    expect(shown.reference.rawTitle).toBe("The Long Way Home");

    // A person's edit beats it, and set back to ComicVine's it stops being one: on the server, for everyone.
    await app.saveEdits(matched.book.id, { title: "A Title Of My Own" }, shown);
    // On the shelf as the server names it: the title edit is only the story's own name.
    await soon(() => bookCalled("Made Up Saga #2: A Title Of My Own")?.book.rawTitle).toBe("A Title Of My Own");
    const edited = (await app.serverComicToEdit(matched.book.id))!;
    expect(edited.book.rawTitle).toBe("A Title Of My Own");
    expect(edited.reference.rawTitle).toBe("The Long Way Home");
    await app.saveEdits(matched.book.id, { title: "The Long Way Home" }, edited);
    await soon(() => bookCalled(ISSUE_2)).toBeDefined();
    expect(server.books.edits(matched.remote?.serverId ?? "")?.values ?? {}).toEqual({});
  }, 30_000);

  it("finds a run by its series' name, its pictures fetched by the server, and keeps a match only on Use these", async () => {
    const id = bookCalled(ISSUE_1).book.id;
    const runs = await app.comicVineRuns(id, { name: "Made Up Saga", year: 2018 });
    expect(runs[0]).toMatchObject({ id: "4050-9001", name: "Made Up Saga", startYear: 2018, publisher: "Made Up Press", issues: 12 });
    expect(runs[0]!.picture).toBe("/api/comicvine/runs/4050-9001/picture");
    const picture = await app.comicVineRunPicture(id, runs[0]!);
    expect(picture?.size).toBeGreaterThan(0);

    const found = await app.lookUpOnComicVine(id, { address: runs[0]!.id, issue: "1", as: "issue" });
    expect(found).toMatchObject({ as: "issue", values: { title: "Setting Out", issue: "1", series: "Made Up Saga (2018)" }, run: { id: "4050-9001" } });
    expect(bookCalled(ISSUE_1)).toBeDefined();

    await app.keepComicVineMatch(id, { address: runs[0]!.id, issue: "1", as: "issue" });
    await soon(() => app.getState().books.some((b) => b.book.title === "Made Up Saga #1: Setting Out")).toBe(true);
    expect((await app.serverComicToEdit(id))!.matched?.values.title).toBe("Setting Out");

    await app.forgetComicVineMatch(id);
    await soon(() => app.getState().books.some((b) => b.book.title === ISSUE_1)).toBe(true);
    expect((await app.serverComicToEdit(id))!.matched).toBeNull();
  }, 30_000);

  it("says the server's own words when ComicVine has nothing there", async () => {
    const id = bookCalled(ISSUE_1).book.id;
    await expect(app.lookUpOnComicVine(id, { address: "4050-9001", issue: "99", as: "issue" })).rejects.toThrow("ComicVine has no issue 99 in that run.");
    await expect(app.lookUpOnComicVine(id, { address: "https://elsewhere.example/4000-1/", as: "issue" })).rejects.toThrow(/isn't a page on ComicVine/);
  }, 30_000);
});
