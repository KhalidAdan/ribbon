import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import type { Host } from "@ribbon/core/host";
import { EBOOK_FORMAT } from "@ribbon/core/ebook";
import { parseLog, type ReadingRecord } from "@ribbon/core/poslog";
import { spentOn, totals } from "@ribbon/core/stats";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";

const ONE = "The lamp was lit at dusk, and the keeper sat down with the ledger.";
const TWO = "Nobody came to the door. By morning the sea was calm and grey.";

/** Time spent reading, kept beside the books as `reading` records (docs/POSITION-FORMAT.md, format 1.3). */
describe("time spent reading, in the app", () => {
  let root = "";
  const model = {
    format: EBOOK_FORMAT,
    meta: { title: "The Lamp", authors: ["Ann Writer"], identifiers: [{ scheme: "isbn", value: "9781836093152" }] },
    layout: "reflowable",
    sections: [
      { href: "s0.xhtml", linear: true, overlay: null, chars: ONE.length, blocks: [{ k: "p", runs: [{ t: ONE }] }] },
      { href: "s1.xhtml", linear: true, overlay: null, chars: TWO.length, blocks: [{ k: "p", runs: [{ t: TWO }] }] },
    ],
    toc: [],
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-reading-time-"));
    await fs.mkdir(path.join(root, "Ebooks"));
    await fs.writeFile(path.join(root, "Ebooks", "Lamp.epub"), "PK");
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function readingsInTheLog(): Promise<ReadingRecord[]> {
    const dir = path.join(root, ".ribbon", "positions");
    const out: ReadingRecord[] = [];
    for (const f of await fs.readdir(dir)) if (f.endsWith(".ndjson")) out.push(...parseLog(await fs.readFile(path.join(dir, f), "utf8")).records.filter((r): r is ReadingRecord => r.k === "reading"));
    return out;
  }

  it("keeps a stretch from the first move to the last and a minute after, ends it after five minutes away, and leaves out a short one", async () => {
    const host: Host = { ...nodeHost(), openEbook: async () => JSON.stringify(model) };
    const platform: Platform = { host, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books.find((b) => b.book.path === "Ebooks/Lamp.epub")!;
    await c.openReading(book.book.id);
    expect(c.getState().reading).toMatchObject({ status: "ready" });

    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-03T21:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    c.moveReading({ section: 0, block: 0, offset: 10 }, "periodic", "hand");
    vi.setSystemTime(t0 + 2 * 60_000);
    c.moveReading({ section: 1, block: 0, offset: 0 }, "periodic", "scroll");
    // Ten minutes on, the reader looked away after the last move: that stretch ends a minute after it.
    vi.setSystemTime(t0 + 10 * 60_000);
    c.moveReading({ section: 1, block: 0, offset: 20 }, "periodic", "hand");
    // Twenty seconds more, and closed: too short to keep.
    vi.setSystemTime(t0 + 10 * 60_000 + 20_000);
    await c.closeReading();
    await vi.waitFor(() => expect(c.getState().history.readings).toHaveLength(1));

    const kept = c.getState().history.readings[0]!;
    expect(kept).toMatchObject({ start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:03:00.000Z", read_ms: 180_000 });
    expect(kept.to!).toBeGreaterThan(kept.from!);
    expect(spentOn(kept)).toBe(book.book.id);

    // Beside the books, under the text's claims, as the reading place is.
    const logged = await readingsInTheLog();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ read_ms: 180_000, book: { ids: [`urn:ribbon:${book.book.id}-text`, "urn:isbn:9781836093152"] } });

    // The Stats count it with listening.
    expect(totals(c.getState().history.readings, [], t0 + 11 * 60_000, 0).todayMs).toBe(180_000);
    c.destroy();
  });

  it("keeps none while sessions aren't kept", async () => {
    const host: Host = { ...nodeHost(), openEbook: async () => JSON.stringify(model) };
    const platform: Platform = { host, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    await c.setRecordSessions(false);
    const book = c.getState().books.find((b) => b.book.path === "Ebooks/Lamp.epub")!;
    await c.openReading(book.book.id);
    const before = (await readingsInTheLog()).length;
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-04T21:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    c.moveReading({ section: 0, block: 0, offset: 5 }, "periodic", "hand");
    vi.setSystemTime(t0 + 4 * 60_000);
    c.moveReading({ section: 1, block: 0, offset: 5 }, "periodic", "hand");
    await c.closeReading();
    expect((await readingsInTheLog()).length).toBe(before);
    c.destroy();
  });


  it("says the daily goal was met, once, when reading meets it here", async () => {
    const host: Host = { ...nodeHost(), openEbook: async () => JSON.stringify(model) };
    const settings = memorySettings();
    const platform: Platform = { host, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    const check = (now: number) => (c as unknown as { checkGoal(now: number): void }).checkGoal(now);
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-05T21:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    await c.setGoal(1);
    expect(c.getState().goal).toMatchObject({ minutes: 1 });
    check(t0);
    expect(c.getState().goalMet).toBeNull();

    const book = c.getState().books.find((b) => b.book.path === "Ebooks/Lamp.epub")!;
    await c.openReading(book.book.id);
    vi.setSystemTime(t0);
    c.moveReading({ section: 0, block: 0, offset: 3 }, "periodic", "hand");
    vi.setSystemTime(t0 + 50_000);
    c.moveReading({ section: 1, block: 0, offset: 3 }, "periodic", "hand");
    // Seventy seconds of reading going on, not kept yet: a minute's goal is met.
    check(t0 + 70_000);
    expect(c.getState().goalMet).toEqual({ minutes: 1, streakDays: 1 });
    c.dismissGoalMet();
    check(t0 + 80_000);
    expect(c.getState().goalMet).toBeNull();
    // Kept on this machine, with the day it was said, a moment later.
    await vi.waitFor(async () => expect(await settings.read()).toMatchObject({ dailyGoal: { minutes: 1 }, goalCelebrated: expect.any(Number) }));
    await c.closeReading();
    c.destroy();
  });
});
