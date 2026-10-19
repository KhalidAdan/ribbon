import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import type { Host } from "../src/host/host";
import { EBOOK_FORMAT } from "../src/core/ebook";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { parseLog, type LogRecord, type MarkRecord } from "../src/core/poslog";

const ONE = "Section zero has exactly forty letters in.";
const TWO = "The waygate hung before them, a giant circle of wraithbone.";

describe("bookmarks from highlights, in the app", () => {
  let root = "";
  const model = {
    format: EBOOK_FORMAT,
    meta: { title: "The Lost Book", authors: ["Ann Writer"], identifiers: [{ scheme: "isbn", value: "9781836093152" }] },
    layout: "reflowable",
    sections: [
      { href: "s0.xhtml", linear: true, overlay: null, chars: ONE.length, blocks: [{ k: "p", runs: [{ t: ONE }] }] },
      { href: "s1.xhtml", linear: true, overlay: null, chars: TWO.length, blocks: [{ k: "p", runs: [{ t: TWO }] }] },
    ],
    toc: [],
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-highlights-app-"));
    await fs.mkdir(path.join(root, "Ebooks"));
    await fs.writeFile(path.join(root, "Ebooks", "Only.epub"), "PK");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function logRecords(): Promise<LogRecord[]> {
    const dir = path.join(root, ".ribbon", "positions");
    const out: LogRecord[] = [];
    for (const f of await fs.readdir(dir)) if (f.endsWith(".ndjson")) out.push(...parseLog(await fs.readFile(path.join(dir, f), "utf8")).records);
    return out;
  }

  it("keeps the words selected, draws them from the log, goes to them, and deletes them", async () => {
    const host: Host = { ...nodeHost(), openEbook: async () => JSON.stringify(model) };
    const platform: Platform = { host, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books.find((b) => b.book.path === "Ebooks/Only.epub")!;
    await c.openReading(book.book.id);
    expect(c.getState().reading).toMatchObject({ status: "ready" });
    expect(c.getState().reading!.highlights).toBeUndefined();

    // Selected from the end back to the start, with a space either side.
    const from = { section: 1, block: 0, offset: TWO.indexOf(" a giant") };
    const to = { section: 1, block: 0, offset: TWO.indexOf("wraithbone") + "wraithbone".length };
    const h = await c.addHighlight(to, from);
    expect(h).toMatchObject({ offsetMs: null, clip: "", text: { quote: "a giant circle of wraithbone", ids: [`urn:ribbon:${book.book.id}-text`, "urn:isbn:9781836093152"] } });
    expect(c.getState().reading!.highlights?.map((x) => x.id)).toEqual([h!.id]);

    // In the log beside the books, as a bookmark without a time.
    const marks = (await logRecords()).filter((r): r is MarkRecord => r.k === "mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ id: h!.id, motivation: "bookmarking", target: { text: { quote: "a giant circle of wraithbone" } } });
    expect(marks[0]!.target.ms).toBeUndefined();
    // Not in a bookmarks CSV, which earlier versions would read as a bookmark by time.
    await expect(fs.readdir(path.join(root, ".ribbon", "bookmarks"))).rejects.toThrow();

    // Opened from elsewhere, it goes to its words.
    c.moveReading({ section: 0, block: 0, offset: 0 }, "seek");
    await c.readHighlight(book.book.id, h!.id);
    expect(c.getState().reading!.place).toEqual({ section: 1, block: 0, offset: TWO.indexOf("a giant") });

    await c.removeBookmark(book.book.id, h!.id);
    expect(c.getState().reading!.highlights).toBeUndefined();
    expect((await logRecords()).some((r) => r.k === "del" && r.of === h!.id)).toBe(true);
    await c.closeReading();
    c.destroy();
  });
});
