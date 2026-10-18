import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import type { Host } from "../src/host/host";

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], (e) => (e ? reject(e) : resolve())));
}

const MIN = 60_000;
const NAMES = ["Opening Credits", "The Middle", "End Credits"];

let root = "";
let catalogCalls = 0;

function host(): Host {
  return {
    ...nodeHost(),
    async catalogSearch(title: string) {
      catalogCalls++;
      return JSON.stringify({ products: [{ asin: "B0TESTTEST", title, authors: [{ name: "An Author" }], narrators: [{ name: "A Reader" }], runtime_length_min: 3 }] });
    },
  };
}

function platform(settings = memorySettings()): Platform {
  return { host: host(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-names-"));
  const dir = path.join(root, "Test Book");
  await fs.mkdir(dir);
  const meta = path.join(root, "meta.txt");
  await fs.writeFile(meta, [";FFMETADATA1", "title=Test Book", "artist=An Author", "album=Test Book", ...[0, 1, 2].flatMap((i) => ["[CHAPTER]", "TIMEBASE=1/1000", `START=${i * MIN}`, `END=${(i + 1) * MIN}`, `title=Chapter ${i + 1}`])].join("\n"));
  await ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=180", "-i", meta, "-map_metadata", "1", "-map_chapters", "1", "-c:a", "aac", "-b:a", "32k", path.join(dir, "book.m4b")]);
  await fs.rm(meta);
  // Audnexus, as the app asks it; anything else (Open Library) has nothing.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("https://api.audnex.us/books/B0TESTTEST/chapters")) {
        return new Response(JSON.stringify({ asin: "B0TESTTEST", runtimeLengthMs: 3 * MIN, chapters: NAMES.map((title, i) => ({ title, startOffsetMs: i * MIN + 300, lengthMs: MIN })) }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}, 60_000);

afterEach(() => {
  catalogCalls = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

async function settleNames(c: AppController): Promise<void> {
  for (let i = 0; i < 200 && Object.keys(c.getState().namedChapters).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  await (c as unknown as { naming: Promise<unknown> }).naming;
}

describe("real chapter names", () => {
  it("do nothing with the online lookups off", async () => {
    const c = new AppController(platform());
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books[0]!;
    await c.maybeNameChapters(book.book.id);
    expect(catalogCalls).toBe(0);
    expect(c.getState().books[0]!.chapters.map((ch) => ch.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("go on when the file only numbers its chapters, are asked once, and keep the times", async () => {
    const settings = memorySettings();
    const c = new AppController(platform(settings));
    await c.boot();
    await c.pickLibrary();
    const before = c.getState().books[0]!.chapters;
    await c.setLookup(true);
    await settleNames(c);
    const after = c.getState().books[0]!;
    expect(after.chapters.map((ch) => ch.title)).toEqual(NAMES);
    expect(after.chapters.map((ch) => ch.startMs)).toEqual(before.map((ch) => ch.startMs));
    expect(c.getState().namedChapters[after.book.id]).toBe("B0TESTTEST");
    expect(catalogCalls).toBe(1);
    const record = await fs.readFile(path.join(root, ".ribbon", "chapter-names.csv"), "utf8");
    expect(record).toContain("B0TESTTEST");
    expect(record).toContain("applied");

    // Another start: the names are there from the corrections, and nobody is asked again.
    const again = new AppController(platform(settings));
    await again.boot();
    await again.pickLibrary();
    await again.maybeNameChapters(after.book.id);
    expect(again.getState().books[0]!.chapters.map((ch) => ch.title)).toEqual(NAMES);
    expect(again.getState().namedChapters[after.book.id]).toBe("B0TESTTEST");
    expect(catalogCalls).toBe(1);
  });
});
