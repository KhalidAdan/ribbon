import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { LibraryService } from "../src/app/library";
import { memorySettings, memorySources } from "../src/app/platform";
import { markId } from "../src/core/bookmarks";
import { parseLog, type LogRecord } from "../src/core/poslog";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

function platform(root: string, settings = memorySettings()): Platform {
  return { host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings };
}

const RIBBON = path.join(FIXTURE_ROOT, ".ribbon");

async function clean(): Promise<void> {
  const dir = path.join(RIBBON, "positions");
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) if (f.endsWith(".ndjson") || f.endsWith(".json")) await fs.rm(path.join(dir, f), { force: true });
  await fs.rm(path.join(RIBBON, "bookmarks"), { recursive: true, force: true });
}

async function started(settings: ReturnType<typeof memorySettings>): Promise<AppController> {
  const c = new AppController(platform(FIXTURE_ROOT, settings));
  await c.boot();
  await c.pickLibrary();
  return c;
}

/** Every record in the positions folder's logs. */
async function logRecords(): Promise<LogRecord[]> {
  const dir = path.join(RIBBON, "positions");
  const out: LogRecord[] = [];
  for (const f of await fs.readdir(dir)) if (f.endsWith(".ndjson")) out.push(...parseLog(await fs.readFile(path.join(dir, f), "utf8")).records);
  return out;
}

describe("bookmarks through the app", () => {
  beforeAll(clean);
  afterAll(clean);

  it("adds, edits and deletes as marks, on two devices, and keeps the CSV for earlier versions", async () => {
    const desktopSettings = memorySettings();
    const laptopSettings = memorySettings();
    const desktop = await started(desktopSettings);
    const book = desktop.getState().books.find((b) => b.book.path === "single-m4b")!;
    const id = book.book.id;
    const csv = path.join(RIBBON, "bookmarks", `${id}.csv`);

    // A read of the log that started before the write landed...
    const stale = await new LibraryService(nodeHost(), FIXTURE_ROOT).readPositionLog();
    const added = (await desktop.addBookmarkAt(id, 4500, "first"))!;
    expect(added.id).toBe(markId(id, 4500));
    expect(added.clip).toBe(`clips/${id}-4500.opus`);
    expect(desktop.bookmarksFor(id)).toEqual([added]);
    // ...cannot undo it.
    (desktop as unknown as { takeLog(o: unknown, r: LogRecord[]): void }).takeLog((desktop as unknown as { opened: Map<string, unknown> }).opened.values().next().value, stale.records);
    expect(desktop.bookmarksFor(id).map((b) => b.note)).toEqual(["first"]);

    const mark = (await logRecords()).find((r) => r.k === "mark");
    expect(mark).toMatchObject({ k: "mark", id: added.id, motivation: "bookmarking", body: "first", target: { ms: 4500, selector: { type: "FragmentSelector", value: "t=0,4.5" } } });
    expect(await fs.readFile(csv, "utf8")).toContain("first");

    await desktop.editBookmark(id, added.id, "second thoughts");
    expect(desktop.bookmarksFor(id).map((b) => b.note)).toEqual(["second thoughts"]);
    expect(await fs.readFile(csv, "utf8")).toContain("second thoughts");

    // The laptop sees the desktop's bookmark, edit and clip included.
    const laptop = await started(laptopSettings);
    const seen = await laptop.loadBookmarks(id);
    expect(seen.map((b) => [b.id, b.note, b.clip])).toEqual([[added.id, "second thoughts", added.clip]]);

    // A delete on the laptop removes it on the desktop, even with the desktop's CSV row put back.
    const before = await fs.readFile(csv);
    await laptop.removeBookmark(id, added.id);
    expect(laptop.bookmarksFor(id)).toEqual([]);
    await expect(fs.stat(path.join(RIBBON, "bookmarks", "clips", `${id}-4500.opus`))).rejects.toThrow();
    expect(await fs.readFile(csv, "utf8")).not.toContain("second thoughts");
    await fs.writeFile(csv, before);
    const desktopAgain = await started(desktopSettings);
    expect(await desktopAgain.loadBookmarks(id)).toEqual([]);
    expect((await logRecords()).some((r) => r.k === "del" && r.of === added.id)).toBe(true);
  });

  it("reads the CSV of Ribbon 0.4 as bookmarks, and an edit there becomes a mark", async () => {
    await clean();
    const desktop = await started(memorySettings());
    const book = desktop.getState().books.find((b) => b.book.path === "multi-mp3")!;
    const id = book.book.id;
    await fs.mkdir(path.join(RIBBON, "bookmarks"), { recursive: true });
    await fs.writeFile(path.join(RIBBON, "bookmarks", `${id}.csv`), `book_id,offset_ms,created_at,note,clip\n${id},9000,2025-01-01T00:00:00.000Z,from 0.4,\n`);

    const list = await desktop.loadBookmarks(id);
    expect(list).toEqual([{ id: markId(id, 9000), bookId: id, offsetMs: 9000, createdAt: "2025-01-01T00:00:00.000Z", note: "from 0.4", clip: "" }]);
    expect((await logRecords()).filter((r) => r.k === "mark")).toEqual([]);

    await desktop.editBookmark(id, markId(id, 9000), "edited in 0.5");
    const fresh = await started(memorySettings());
    expect((await fresh.loadBookmarks(id)).map((b) => [b.offsetMs, b.note])).toEqual([[9000, "edited in 0.5"]]);
  });
});
