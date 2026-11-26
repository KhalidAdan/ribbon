import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { issueRequest, runRequest, type SharedMatch } from "@ribbon/core/comicvine";
import type { SharedEdits } from "@ribbon/core/edits";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import { buildServer, type RibbonServer } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { ComicVine, ComicVineBusy, ComicVineGate, ComicVineUnreachable, type Asker, type Clock } from "../src/library/comicvine.ts";
import { STAND_IN_KEY, standIn, type StandIn } from "./comicvine/stand-in.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/**
 * ComicVine on a server (docs/BOOK-DETAILS.md, section 7), against a
 * stand-in that answers from answers written by hand in the shape
 * ComicVine's documentation gives (test/comicvine/): never the real one.
 * Its door (one request at a time, a gap after each answer, a person
 * first, the hour's limit, blocked requests tried again, a day's cache);
 * and on a server: off unless a key is set, the match it makes by itself
 * only by a file's exact address, "Look it up" and its routes, the layer
 * between a comic's files and a person's edits, and the MCP's `comicvine`.
 */

const HOUR = 3_600_000;

/** Let every promise that can settle, settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Time that passes only when a test says, and wakes whoever slept until then. */
function manualClock(): Clock & { pass(ms: number): Promise<void> } {
  let t = 0;
  const sleepers: { at: number; wake: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise<void>((wake) => sleepers.push({ at: t + ms, wake })),
    async pass(ms) {
      t += ms;
      for (const s of [...sleepers]) {
        if (s.at > t) continue;
        sleepers.splice(sleepers.indexOf(s), 1);
        s.wake();
      }
      await settle();
    },
  };
}

/** Time that jumps ahead by whatever is slept, so a test never waits out a gap: what was slept is noted. */
function virtualClock(): Clock & { slept: number[] } {
  let ahead = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => Date.now() + ahead,
    sleep: async (ms) => {
      slept.push(ms);
      ahead += ms;
    },
  };
}

describe("ComicVine's door", () => {
  it("lets one request through at a time, a second and a half after the last one's answer, a person before the background job", async () => {
    const clock = manualClock();
    const gate = new ComicVineGate(clock);
    const sent: string[] = [];
    const answer = new Map<string, () => void>();
    const ask = (name: string, asker: Asker) =>
      gate.through("issue", asker, () => {
        sent.push(`${name} at ${clock.now()}`);
        return new Promise<void>((done) => answer.set(name, done));
      });
    void ask("a", "background");
    void ask("b", "background");
    void ask("c", "background");
    await settle();
    expect(sent).toEqual(["a at 0"]);
    // Nothing more while a's answer is out, however long it takes.
    await clock.pass(10_000);
    expect(sent).toEqual(["a at 0"]);
    void ask("p", "person");
    answer.get("a")!();
    await settle();
    await clock.pass(1_499);
    expect(sent).toEqual(["a at 0"]);
    await clock.pass(1);
    expect(sent).toEqual(["a at 0", "p at 11500"]);
    answer.get("p")!();
    await settle();
    await clock.pass(1_500);
    expect(sent).toEqual(["a at 0", "p at 11500", "b at 13000"]);
  });

  it("asks a resource no more than 180 times an hour: the background job waits at 160, so a person still has room, and a person past 180 is told when", async () => {
    const clock = manualClock();
    const gate = new ComicVineGate(clock, 0);
    const go = (asker: Asker) => gate.through("volumes", asker, async () => clock.now());
    for (let i = 0; i < 160; i++) await go("background");
    let late: number | null = null;
    const waiting = go("background").then((at) => (late = at));
    await settle();
    expect(late).toBeNull();
    for (let i = 0; i < 20; i++) expect(await go("person")).toBe(0);
    const refused = await go("person").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ComicVineBusy);
    expect((refused as ComicVineBusy).until).toBe(HOUR);
    // Each resource has an hour of its own.
    expect(await gate.through("issue", "background", async () => "an issue")).toBe("an issue");
    expect(gate.sentInTheHour("volumes")).toBe(180);
    await clock.pass(HOUR);
    await waiting;
    expect(late).toBe(HOUR);
  });

  describe("asking", () => {
    let dir: string;
    let db: DatabaseSync;
    let stand: StandIn;
    let clock: ReturnType<typeof virtualClock>;
    let comicVine: ComicVine;

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "ribbon-comicvine-door-"));
      db = openDatabase(dir);
      stand = await standIn();
      clock = virtualClock();
      comicVine = new ComicVine(db, { key: STAND_IN_KEY, api: stand.api, clock });
    });

    afterAll(async () => {
      db.close();
      await stand.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    afterEach(() => {
      stand.asked.length = 0;
      stand.next.length = 0;
      clock.slept.length = 0;
    });

    it("keeps an answer for a day, and asks again after", async () => {
      const first = await comicVine.ask<{ name: string }>(issueRequest(123456), "person");
      expect(first?.name).toBe("The Long Way Home");
      expect(await comicVine.ask(issueRequest(123456), "person")).toEqual(first);
      expect(stand.asked).toHaveLength(1);
      expect(stand.asked[0]).toMatch(/^issue\/4000-123456\/\?field_list=/);
      await clock.sleep(24 * HOUR);
      await comicVine.ask(issueRequest(123456), "person");
      expect(stand.asked).toHaveLength(2);
    });

    it("keeps that ComicVine has no such thing, too", async () => {
      expect(await comicVine.ask(issueRequest(404404), "person")).toBeNull();
      expect(await comicVine.ask(issueRequest(404404), "person")).toBeNull();
      expect(stand.asked).toHaveLength(1);
    });

    it("keeps a search's runs as each run's own answer, so picking one asks nothing more", async () => {
      const runs = await comicVine.runs({ name: "Made Up Saga", year: null }, "person");
      expect(runs.map((r) => [r.id, r.start_year])).toEqual([
        [9001, "2018"],
        [9002, "2021"],
        [9004, "2019"],
        [9003, "2019"],
      ]);
      expect(await comicVine.ask(runRequest(9003), "person")).toMatchObject({ name: "Made Up Saga Tales" });
      expect(stand.asked).toEqual([expect.stringMatching(/^volumes\/\?filter=name%3AMade\+Up\+Saga&field_list=/)]);
    });

    it("waits out a blocked request and tries it twice more, waiting twice as long the second time", async () => {
      stand.next.push("429", "107");
      expect(await comicVine.ask(issueRequest(700007), "background")).toMatchObject({ issue_number: "7" });
      expect(stand.asked).toHaveLength(3);
      expect(clock.slept.filter((ms) => ms > 1_500)).toEqual([3_000, 6_000]);
    });

    it("says ComicVine is turning it away when it is still blocked after that", async () => {
      stand.next.push("420", "429", "107");
      await expect(comicVine.ask(issueRequest(700010), "background")).rejects.toThrow(/too many, too fast/);
      expect(stand.asked).toHaveLength(3);
    });

    it("says a refused key is refused, never what the key is, and that a ComicVine out of reach is", async () => {
      const wrong = new ComicVine(db, { key: "not-the-stand-in-key", api: stand.api, clock });
      const refused = (await wrong.ask(issueRequest(123455), "person").catch((e: unknown) => e)) as Error;
      expect(refused).toBeInstanceOf(ComicVineUnreachable);
      expect(refused.message).toBe("ComicVine refused this server's key: check RIBBON_COMICVINE_KEY.");
      const away = new ComicVine(db, { key: STAND_IN_KEY, api: "http://127.0.0.1:9/api", clock });
      await expect(away.ask(issueRequest(123455), "person")).rejects.toThrow("ComicVine can't be reached from this server just now.");
      stand.next.push("502");
      await expect(comicVine.ask(issueRequest(123455), "person")).rejects.toThrow("ComicVine couldn't answer just now (502).");
    });

    it("never keeps the key in its cache", () => {
      const rows = db.prepare("SELECT key, answer FROM comicvine_cache").all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(`${String(row.key)} ${String(row.answer)}`).not.toContain(STAND_IN_KEY);
    });

    it("fetches a run's picture only from ComicVine's own hosts", async () => {
      const fetched: string[] = [];
      const careful = new ComicVine(db, {
        key: STAND_IN_KEY,
        api: stand.api,
        clock,
        fetch: async (url, init) => {
          fetched.push(String(url));
          return fetch(url, init);
        },
      });
      const elsewhere = { status_code: 1, error: "OK", results: { id: 8001, name: "Elsewhere", image: { thumb_url: "http://169.254.169.254/latest/meta-data" } } };
      // As if ComicVine had answered with a picture somewhere else: kept as the door keeps an answer.
      db.prepare("INSERT INTO comicvine_cache (key, answer, asked_at) VALUES (?, ?, ?)").run(`volume/4050-8001/?${new URLSearchParams(runRequest(8001).params).toString()}`, JSON.stringify(elsewhere), clock.now());
      expect(await careful.runPicture(8001, "person")).toBeNull();
      expect(fetched.some((url) => url.includes("169.254"))).toBe(false);
      const ours = await careful.runPicture(9001, "person");
      expect(ours?.type).toBe("image/jpeg");
      expect(stand.pictures).toContain("/a/uploads/scale_avatar/9/9001/made-up-saga-1.jpg");
    });
  });
});

/** The made library: each comic's file, its pages (a different count each, so no two are the same file) and its ComicInfo.xml. */
const COMICS: { file: string; pages: number; info?: Record<string, string | number> }[] = [
  { file: "Made Up Saga/Made Up Saga 001.cbz", pages: 3 },
  {
    file: "Made Up Saga/anything.cbz",
    pages: 4,
    info: { Title: "The Long Way", Series: "Made Up Saga", Number: 2, Writer: "Ada Quill", Penciller: "Ben Nib", Year: 2018, Month: 7, Web: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/" },
  },
  { file: "Made Up Saga/Made Up Saga Compendium.cbz", pages: 5, info: { Title: "Compendium One", Series: "Made Up Saga", Number: 1, Format: "TPB", Writer: "Ada Quill" } },
  { file: "Lost Things 001.cbz", pages: 6, info: { Series: "Lost Things", Number: 1, Web: "https://comicvine.gamespot.com/lost-things-1/4000-404404/" } },
  { file: "Steel Giants/Steel Giants 007.cbz", pages: 7, info: { Series: "Steel Giants", Volume: 2023, Number: 7, Web: "https://comicvine.gamespot.com/steel-giants-7/4000-700007/" } },
  { file: "Steel Giants/Steel Giants 010.cbz", pages: 8, info: { Series: "Steel Giants", Volume: 2023, Number: 10, Web: "https://comicvine.gamespot.com/steel-giants-10-iron-dusk/4000-700010/" } },
  { file: "Paper Lanterns.cbz", pages: 2, info: { Writer: "Mo Brush" } },
];

describe("looking comics up on a server", () => {
  let dir: string;
  let library: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-comicvine-"));
    library = path.join(dir, "library");
    for (const c of COMICS) await makeComic(path.join(library, c.file), { pages: c.pages, ...(c.info ? { comicInfo: comicInfoXml(c.info) } : {}) });
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /** Requests to a server, as someone. */
  const client = (server: RibbonServer, token: string) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const ask = {
      get: (url: string) => server.app.inject({ method: "GET", url, headers }),
      put: (url: string, body: unknown) => server.app.inject({ method: "PUT", url, headers, payload: JSON.stringify(body) }),
      delete: (url: string) => server.app.inject({ method: "DELETE", url, headers: { authorization: headers.authorization } }),
      library: async () => (await ask.get("/api/books")).json() as { books: ListedBook[]; comicVine?: true },
      book: async (id: string) => (await ask.get(`/api/books/${id}`)).json() as StoredBook & { edited?: SharedEdits; matched?: SharedMatch },
      mcp: async (method: string, params: unknown) => (await server.app.inject({ method: "POST", url: "/mcp", headers, payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json().result,
    };
    return ask;
  };

  /** What a tool said, as text. */
  const words = (answer: { content: { type: string; text?: string }[]; isError?: boolean }) => answer.content.map((c) => c.text ?? "").join("\n");

  describe("with no key", () => {
    let server: RibbonServer;
    let ask: ReturnType<typeof client>;
    let fetched: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      fetched = vi.spyOn(globalThis, "fetch");
      const made = await serverWithAdmin(path.join(dir, "off"));
      server = made.server;
      ask = client(server, made.admin);
      await importAs(server, made.admin, library);
      await server.jobs.idle();
    }, 60_000);

    afterAll(async () => {
      fetched.mockRestore();
      await server.app.close();
      server.db.close();
    });

    it("asks no one, and says so: no comicVine in the library answer, and the routes say why", async () => {
      expect(await ask.library()).not.toHaveProperty("comicVine");
      const comic = (await ask.library()).books.find((b) => b.title === "Made Up Saga #2: The Long Way")!;
      for (const url of ["/api/comicvine/runs?name=Made%20Up%20Saga", `/api/books/${comic.id}/comicvine`, "/api/comicvine/runs/4050-9001/picture"]) {
        const r = await ask.get(url);
        expect(r.statusCode).toBe(404);
        expect(r.json()).toEqual({ error: "This server doesn't look comics up on ComicVine: its admin hasn't set RIBBON_COMICVINE_KEY." });
      }
      expect((await ask.put(`/api/books/${comic.id}/comicvine`, { address: "4000-123456" })).statusCode).toBe(404);
      // A comic matched by its file's address is not, and nothing was fetched from anywhere.
      expect((await ask.book(comic.id)).matched).toBeUndefined();
      expect((await ask.book(comic.id)).book.comicvine).toBe("4000-123456");
      expect(fetched).not.toHaveBeenCalled();
    });

    it("gives the MCP no comicvine, and refuses one", async () => {
      const tools = (await ask.mcp("tools/list", {})).tools as { name: string; inputSchema: { properties: { details?: { properties: Record<string, unknown> } } } }[];
      expect(Object.keys(tools.find((t) => t.name === "set_details")!.inputSchema.properties.details!.properties)).not.toContain("comicvine");
      const comic = (await ask.library()).books.find((b) => b.title === "Made Up Saga #2: The Long Way")!;
      const refused = await ask.mcp("tools/call", { name: "set_details", arguments: { book: comic.id, details: { comicvine: "4000-123456" } } });
      expect(refused.isError).toBe(true);
      expect(words(refused)).toContain("RIBBON_COMICVINE_KEY");
      expect(fetched).not.toHaveBeenCalled();
    });
  });

  describe("with a key", () => {
    let stand: StandIn;
    let server: RibbonServer;
    let admin: string;
    let ask: ReturnType<typeof client>;
    let reader: ReturnType<typeof client>;
    let readerToken: string;
    const data = () => path.join(dir, "on");
    const config = () => ({ comicVine: { key: STAND_IN_KEY, api: stand.api } });
    const id = async (title: string) => (await ask.library()).books.find((b) => b.title === title)?.id ?? `none called ${title}`;
    const matchedBy = (book: string) => server.db.prepare("SELECT matched_by FROM book_match WHERE book_id = ?").get(book)?.matched_by;
    let ids: Record<string, string>;

    /** The server started again on the same data, as after an update. */
    const startAgain = async () => {
      await server.app.close();
      server.db.close();
      server = await buildServer({ dataDir: path.join(data(), "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!", ...config() }, { comicVineClock: virtualClock() });
      // Their sessions are kept in the data: their tokens still work.
      ask = client(server, admin);
      reader = client(server, readerToken);
      await server.jobs.idle("comicvine");
    };

    beforeAll(async () => {
      stand = await standIn();
      const made = await serverWithAdmin(data(), config(), { comicVineClock: virtualClock() });
      server = made.server;
      admin = made.admin;
      ask = client(server, admin);
      const invite = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
      readerToken = ((await server.app.inject({ method: "POST", url: `/api/invites/${invite.code}/accept`, payload: { name: "reader", password: "another long password" } })).json() as { token: string }).token;
      reader = client(server, readerToken);
    }, 60_000);

    afterAll(async () => {
      await server.app.close();
      server.db.close();
      await stand.close();
    });

    it("says comics can be looked up here", async () => {
      expect((await ask.library()).comicVine).toBe(true);
    });

    it("stops matching by the files' addresses after three comics ComicVine couldn't be asked about, and asks again at the next start", async () => {
      stand.failing = true;
      await importAs(server, admin, library);
      await server.jobs.idle("comicvine");
      const progress = JSON.parse(String(server.db.prepare("SELECT progress FROM job WHERE kind = 'comicvine' ORDER BY created_at DESC LIMIT 1").get()!.progress));
      expect(progress).toMatchObject({ comics: 4, done: 3, matched: 0 });
      expect(stand.asked).toHaveLength(3);
      expect(server.db.prepare("SELECT count(*) AS n FROM book_match").get()!.n).toBe(0);
      expect(server.db.prepare("SELECT count(*) AS n FROM comicvine_asked").get()!.n).toBe(0);
      stand.failing = false;
      stand.asked.length = 0;
      await startAgain();
      ids = Object.fromEntries((await ask.library()).books.map((b) => [b.title, b.id]));
    }, 60_000);

    it("matches by itself only the comics whose files give their issue's address, and never searches", async () => {
      expect(Object.keys(ids).sort()).toEqual(["Lost Things #1", "Made Up Saga #1", "Made Up Saga #2: The Long Way Home", "Made Up Saga Vol. 1: Compendium One", "Paper Lanterns", "Steel Giants #10: Iron Dusk", "Steel Giants #7"]);
      expect(stand.asked.map((a) => a.split("?")[0]).sort()).toEqual(["issue/4000-123456/", "issue/4000-404404/", "issue/4000-700007/", "issue/4000-700010/", "volume/4050-7001/", "volume/4050-9001/"]);
      for (const title of ["Made Up Saga #2: The Long Way Home", "Steel Giants #7", "Steel Giants #10: Iron Dusk"]) {
        expect((await ask.book(ids[title]!)).matched).toBeDefined();
        expect(matchedBy(ids[title]!)).toBeNull();
      }
      for (const title of ["Lost Things #1", "Made Up Saga #1", "Paper Lanterns"]) expect((await ask.book(ids[title]!)).matched).toBeUndefined();
      // ComicVine had no issue for Lost Things: it's noted as asked, and not asked again.
      expect(server.db.prepare("SELECT book_id FROM comicvine_asked ORDER BY book_id").all().map((r) => r.book_id)).toContain(ids["Lost Things #1"]);
    });

    it("lists and serves a matched comic with what ComicVine said, beside no edits, and its page to link back to", async () => {
      const giants = (await ask.library()).books.find((b) => b.id === ids["Steel Giants #7"])!;
      expect(giants).toMatchObject({ title: "Steel Giants #7", author: "Dana Pen; Eli Ink", series: "Steel Giants (2023)", seriesIndex: 7 });
      expect(giants).not.toHaveProperty("edited");
      const served = await ask.book(ids["Made Up Saga #2: The Long Way Home"]!);
      expect(served.edited).toBeUndefined();
      expect(served.matched).toEqual({
        address: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way-home/4000-123456/",
        as: "issue",
        values: expect.objectContaining({ series: "Made Up Saga (2018)", issue: "2", title: "The Long Way Home", letters: "Di Pen", publisher: "Made Up Press" }),
        matchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(served.book).toMatchObject({
        title: "Made Up Saga #2: The Long Way Home",
        rawTitle: "The Long Way Home",
        author: "Ada Quill; Ben Nib",
        series: "Made Up Saga (2018)",
        issue: "2",
        publisher: "Made Up Press",
        coverDate: "2018-07",
        onSale: "2018-07-04",
        storyArcs: ["The Lighthouse"],
        credits: { writers: ["Ada Quill"], pencils: ["Ben Nib"], inks: ["Ben Nib"], coverArtists: ["Ben Nib"], colours: ["Cy Hue"], letters: ["Di Pen"], editors: ["Ed Itor"] },
        description: "Ada and Ben take the long way home & meet the lighthouse keeper.\n\nNotes\n\nA made-up issue, written by hand for Ribbon's tests.",
        comicvine: "4000-123456",
      });
    });

    it("lets a person's edit beat what ComicVine said, and taking it back goes to ComicVine's", async () => {
      const book = ids["Made Up Saga #2: The Long Way Home"]!;
      expect((await ask.put(`/api/books/${book}/edits`, { values: { title: "My Own Way", publisher: "" } })).statusCode).toBe(200);
      expect((await ask.library()).books.find((b) => b.id === book)!.title).toBe("Made Up Saga #2: My Own Way");
      const served = await ask.book(book);
      expect(served.book.publisher).toBe("");
      expect(served.edited?.original).toEqual({ title: "The Long Way Home", publisher: "Made Up Press" });
      expect(served.matched?.values.title).toBe("The Long Way Home");
      await ask.put(`/api/books/${book}/edits`, { values: {} });
      expect((await ask.book(book)).book).toMatchObject({ title: "Made Up Saga #2: The Long Way Home", publisher: "Made Up Press" });
    });

    it("asks nothing more when it starts again", async () => {
      stand.asked.length = 0;
      await startAgain();
      expect(stand.asked).toEqual([]);
    });

    it("searches ComicVine's runs by name, with the year when given, and fetches each run's picture itself", async () => {
      const once = await ask.get("/api/comicvine/runs?name=Made%20Up%20Saga&year=2018");
      expect(once.json()).toEqual({
        runs: [{ id: "4050-9001", name: "Made Up Saga", startYear: 2018, publisher: "Made Up Press", issues: 12, address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/", picture: "/api/comicvine/runs/4050-9001/picture" }],
      });
      const all = (await ask.get("/api/comicvine/runs?name=Made%20Up%20Saga")).json() as { runs: { id: string; startYear: number; picture: string | null }[] };
      expect(all.runs.map((r) => [r.id, r.startYear, r.picture !== null])).toEqual([
        ["4050-9001", 2018, true],
        ["4050-9002", 2021, false],
        ["4050-9004", 2019, true],
        ["4050-9003", 2019, true],
      ]);
      stand.asked.length = 0;
      const picture = await ask.get("/api/comicvine/runs/4050-9001/picture");
      expect(picture.statusCode).toBe(200);
      expect(picture.headers["content-type"]).toBe("image/jpeg");
      expect(picture.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      // The run was in the search's answer: its picture asked ComicVine's API nothing more.
      expect(stand.asked).toEqual([]);
      expect((await ask.get("/api/comicvine/runs/4050-9002/picture")).statusCode).toBe(404);
      expect((await ask.get("/api/comicvine/runs?name=")).statusCode).toBe(400);
      expect((await ask.get("/api/comicvine/runs?name=Made%20Up%20Saga&year=last")).statusCode).toBe(400);
    });

    it("looks a comic up by a run a person picked and its issue's number, and keeps nothing until Use these", async () => {
      const book = ids["Made Up Saga #1"]!;
      stand.asked.length = 0;
      const looked = await ask.get(`/api/books/${book}/comicvine?address=4050-9001&issue=1`);
      expect(looked.statusCode).toBe(200);
      expect(looked.json()).toEqual({
        lookedUp: {
          address: "https://comicvine.gamespot.com/made-up-saga-1-setting-out/4000-123455/",
          as: "issue",
          values: { series: "Made Up Saga (2018)", volume: "", collects: "", issue: "1", title: "Setting Out", writers: "Ada Quill", pencils: "Ben Nib", inks: "Ben Nib", coverArtists: "Fay Tint", coverDate: "2018-06", onSale: "2018-06-06", publisher: "Made Up Press", description: "Where the saga starts." },
          run: { id: "4050-9001", name: "Made Up Saga", startYear: 2018, publisher: "Made Up Press", issues: 12, address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/" },
        },
      });
      // The run came from the search: two requests, its issue by number and the issue whole.
      expect(stand.asked.map((a) => a.split("?")[0])).toEqual(["issues/", "issue/4000-123455/"]);
      expect((await ask.book(book)).matched).toBeUndefined();
      expect((await ask.library()).books.find((b) => b.id === book)!.title).toBe("Made Up Saga #1");
      // Use these: the run's address, and the comic's own number.
      const kept = await ask.put(`/api/books/${book}/comicvine`, { address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/" });
      expect(kept.statusCode).toBe(200);
      expect((kept.json() as { matched: SharedMatch }).matched).toMatchObject({ address: "https://comicvine.gamespot.com/made-up-saga-1-setting-out/4000-123455/", as: "issue" });
      expect((await ask.library()).books.find((b) => b.id === book)).toMatchObject({ title: "Made Up Saga #1: Setting Out", author: "Ada Quill; Ben Nib" });
      expect((await ask.book(book)).book.comicvine).toBe("4000-123455");
      expect(matchedBy(book)).toBeTruthy();
    });

    it("reads a collection's number on ComicVine as its volume", async () => {
      const book = ids["Made Up Saga Vol. 1: Compendium One"]!;
      const asIssue = (await ask.get(`/api/books/${book}/comicvine?address=4000-777001&as=issue`)).json() as { lookedUp: { values: Record<string, string> } };
      expect(asIssue.lookedUp.values).toMatchObject({ issue: "1", volume: "", collects: "" });
      // As it is, a collection: by its run, and its own volume as the number.
      const kept = await ask.put(`/api/books/${book}/comicvine`, { address: "4050-9004" });
      expect((kept.json() as { matched: SharedMatch }).matched).toMatchObject({ as: "collection", values: { volume: "1", issue: "", series: "Made Up Saga (2019)", description: "Collects Made Up Saga #1–6." } });
      const served = await ask.book(book);
      expect(served.book).toMatchObject({ title: "Made Up Saga Vol. 1: Compendium One", volume: "1" });
      expect(served.book.issue).toBeUndefined();
    });

    it("forgets a match whole, and doesn't match the comic by itself again", async () => {
      const book = ids["Made Up Saga #2: The Long Way Home"]!;
      expect((await ask.delete(`/api/books/${book}/comicvine`)).statusCode).toBe(204);
      const served = await ask.book(book);
      expect(served.matched).toBeUndefined();
      expect(served.book).toMatchObject({ title: "Made Up Saga #2: The Long Way", series: "Made Up Saga", comicvine: "4000-123456" });
      expect(served.book.publisher).toBeUndefined();
      expect((await ask.delete(`/api/books/${book}/comicvine`)).statusCode).toBe(404);
      await startAgain();
      expect((await ask.book(book)).matched).toBeUndefined();
    });

    it("says why a comic can't be looked up", async () => {
      const lanterns = ids["Paper Lanterns"]!;
      const said = async (url: string) => {
        const r = await ask.get(url);
        return [r.statusCode, (r.json() as { error: string }).error];
      };
      expect(await said(`/api/books/${lanterns}/comicvine`)).toEqual([400, expect.stringContaining("Give the comic's page on ComicVine")]);
      expect(await said(`/api/books/${lanterns}/comicvine?address=https://example.com/lanterns/4000-1/`)).toEqual([400, expect.stringContaining("isn't a page on ComicVine")]);
      expect(await said(`/api/books/${lanterns}/comicvine?address=4050-9001`)).toEqual([400, "Give the number of the issue in that run: a collection's is its volume."]);
      expect(await said(`/api/books/${lanterns}/comicvine?address=4000-999999`)).toEqual([404, "ComicVine has no such issue."]);
      expect(await said(`/api/books/${lanterns}/comicvine?address=4050-9001&issue=99`)).toEqual([404, "ComicVine has no issue 99 in that run."]);
      expect(await said("/api/books/0123456789abcdef/comicvine?address=4000-123456")).toEqual([404, "No such comic on this server."]);
      stand.failing = true;
      expect(await said(`/api/books/${lanterns}/comicvine?address=4000-31337`)).toEqual([503, "ComicVine couldn't answer just now (502)."]);
      stand.failing = false;
    });

    it("is the admin's alone", async () => {
      const book = ids["Lost Things #1"]!;
      for (const r of [await reader.get("/api/comicvine/runs?name=Made%20Up%20Saga"), await reader.get(`/api/books/${book}/comicvine?address=4000-123456`), await reader.put(`/api/books/${book}/comicvine`, { address: "4000-123456" }), await reader.delete(`/api/books/${book}/comicvine`)]) {
        expect(r.statusCode).toBe(403);
      }
      expect((await ask.book(book)).matched).toBeUndefined();
    });

    describe("through the MCP", () => {
      const call = async (name: string, args: unknown) => (await ask.mcp("tools/call", { name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
      const details = async (book: string, given?: Record<string, unknown>) => JSON.parse(words(await call(given ? "set_details" : "comic_details", { book, ...(given ? { details: given } : {}) }))) as Record<string, unknown>;

      it("offers comicvine to set_details, and says what it is", async () => {
        const tools = (await ask.mcp("tools/list", {})).tools as { name: string; description: string; inputSchema: { properties: { details?: { properties: Record<string, unknown> } } } }[];
        const set = tools.find((t) => t.name === "set_details")!;
        expect(Object.keys(set.inputSchema.properties.details!.properties)).toContain("comicvine");
        expect(set.description).toContain("comicvine is the comic's page on ComicVine");
      });

      it("says which details came from ComicVine, and its page", async () => {
        const said = await details(ids["Steel Giants #10: Iron Dusk"]!);
        expect(said).toMatchObject({ name: "Steel Giants #10: Iron Dusk", comicvine: "4000-700010", corrected: [], from_comicvine: { page: "https://comicvine.gamespot.com/steel-giants-10-iron-dusk/4000-700010/" } });
        expect((said.from_comicvine as { details: string[] }).details).toEqual(expect.arrayContaining(["series", "issue", "title", "writers", "pencils", "inks", "colours", "cover_date", "on_sale", "story_arcs", "publisher", "description"]));
      });

      it("forgets a match given comicvine as null, and matches by an address as Use these does, under the corrections given with it", async () => {
        const book = ids["Steel Giants #10: Iron Dusk"]!;
        const forgotten = await details(book, { comicvine: null });
        expect(forgotten).toMatchObject({ name: "Steel Giants #10", comicvine: "4000-700010", corrected: [] });
        expect(forgotten).not.toHaveProperty("from_comicvine");
        const matched = await details(book, { comicvine: "https://comicvine.gamespot.com/steel-giants-10-iron-dusk/4000-700010/", colours: "Gil Line" });
        expect(matched).toMatchObject({ name: "Steel Giants #10: Iron Dusk", colours: "Gil Line", writers: "Dana Pen", corrected: ["colours"] });
        expect((matched.from_comicvine as { details: string[] }).details).not.toContain("colours");
        expect(matchedBy(book)).toBeTruthy();
      });

      it("refuses an address ComicVine has nothing at, and changes nothing", async () => {
        const book = ids["Lost Things #1"]!;
        const refused = await call("set_details", { book, details: { comicvine: "4000-404404", writers: "Nobody" } });
        expect(refused.isError).toBe(true);
        expect(words(refused)).toContain("ComicVine has no such issue");
        expect(await details(book)).toMatchObject({ writers: "", corrected: [] });
        const lanterns = await call("set_details", { book: ids["Paper Lanterns"]!, details: { comicvine: "4050-7001" } });
        expect(words(lanterns)).toContain("Give the number of the issue in that run");
      });
    });
  });
});
