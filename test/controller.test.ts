import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, libraryRootOf, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { sourceId } from "../src/core/sources";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

/** The controller against real fixtures, with no window and no audio. */
function platform(root: string): Platform {
  return {
    host: nodeHost(),
    pickFolder: async () => root,
    allowFolder: async () => undefined,
    fileUrl: (p) => `file:///${p}`,
    sources: memorySources(),
  };
}

async function settle(c: AppController, until: () => boolean, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!until()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for controller");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AppController sources", () => {
  beforeAll(async () => {
    await fs.rm(path.join(FIXTURE_ROOT, ".ribbon"), { recursive: true, force: true });
    await fs.rm(path.join(FIXTURE_ROOT, ".odio"), { recursive: true, force: true });
    await fs.rm(path.join(FIXTURE_ROOT, "does-not-exist"), { recursive: true, force: true });
  });

  it("scans a never-seen folder in the foreground and ends ready with books", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    const progress: number[] = [];
    c.subscribe(() => {
      const s = c.getState();
      if (s.scanning && s.scanning.walked > 0) progress.push(s.scanning.done);
    });
    await c.pickLibrary();
    const s = c.getState();
    expect(s.phase).toBe("ready");
    expect(s.error).toBeNull();
    expect(s.books.length).toBe(11);
    expect(s.scanning).toBeNull();
    expect(s.scanErrors).toEqual([]);
    expect(progress.length).toBeGreaterThan(0);
    expect(Object.keys(s.positions)).toHaveLength(11);
  });

  it("paints from cache on the next open, then rescans behind it", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    const phases: string[] = [];
    c.subscribe(() => {
      const p = c.getState().phase;
      if (phases[phases.length - 1] !== p) phases.push(p);
    });
    await c.addSource(FIXTURE_ROOT);
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().books.length).toBe(11);
    // The background rescan is still running or just finished.
    await settle(c, () => c.getState().scanning === null && c.getState().lastScanMs !== null);
    expect(c.getState().books.length).toBe(11);
    expect(phases).toEqual(["loading", "ready"]);
  });

  it("treats a picked .ribbon folder as the library it belongs to", async () => {
    const c = new AppController(platform(path.join(FIXTURE_ROOT, ".ribbon")));
    await c.pickLibrary();
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().sources.map((s) => s.root)).toEqual([FIXTURE_ROOT]);
    expect(c.getState().books.length).toBe(11);
  });

  it("renames a legacy .odio records folder to .ribbon and keeps its contents", async () => {
    const current = path.join(FIXTURE_ROOT, ".ribbon");
    const legacy = path.join(FIXTURE_ROOT, ".odio");
    await fs.rm(legacy, { recursive: true, force: true });
    await fs.rename(current, legacy);
    await fs.writeFile(path.join(legacy, "marker.txt"), "kept");
    const c = new AppController(platform(FIXTURE_ROOT));
    await c.addSource(FIXTURE_ROOT);
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().books.length).toBe(11);
    expect(await fs.readFile(path.join(current, "marker.txt"), "utf8")).toBe("kept");
    await expect(fs.stat(legacy)).rejects.toThrow();
    await settle(c, () => c.getState().scanning === null && c.getState().lastScanMs !== null);
  });

  it("reports a bad folder as an error on the pick screen, not a hang", async () => {
    const c = new AppController(platform(path.join(FIXTURE_ROOT, "does-not-exist")));
    await c.pickLibrary();
    expect(c.getState().phase).toBe("pick");
    expect(c.getState().error).toMatch(/Could not open/);
    expect(c.getState().scanning).toBeNull();
  });
});

describe("AppController with two sources", () => {
  const second = path.join(os.tmpdir(), `ribbon-second-source-${process.pid}`);

  beforeAll(async () => {
    await fs.rm(second, { recursive: true, force: true });
    await fs.mkdir(second, { recursive: true });
    await fs.cp(path.join(FIXTURE_ROOT, "single-m4b"), path.join(second, "Another Single"), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(second, { recursive: true, force: true });
  });

  it("shelves the books of every folder, tagged with their source, and remembers the folders", async () => {
    const p = platform(FIXTURE_ROOT);
    const c = new AppController(p);
    await c.addSource(FIXTURE_ROOT);
    await c.addSource(second);
    await settle(c, () => c.getState().scanning === null && c.getState().sourceStatus[sourceId(second)]?.lastScanMs !== null);
    const s = c.getState();
    expect(s.phase).toBe("ready");
    expect(s.sources.map((x) => x.name)).toEqual(["generated", path.basename(second)]);
    expect(s.books.length).toBe(12);
    expect(s.books.filter((b) => b.source === sourceId(second)).map((b) => b.book.path)).toEqual(["Another Single"]);
    expect(s.books.filter((b) => b.source === sourceId(FIXTURE_ROOT)).length).toBe(11);
    expect(await p.sources.load()).toEqual(s.sources.map((x) => ({ root: x.root, addedAt: x.addedAt })));
    // Adding a folder again only checks it for changes.
    await c.addSource(second);
    expect(c.getState().sources.length).toBe(2);
    expect(c.getState().books.length).toBe(12);
  });

  it("reopens every remembered folder at boot, with the folder given at launch added once", async () => {
    const p = platform(FIXTURE_ROOT);
    await p.sources.save([{ root: FIXTURE_ROOT, addedAt: "2026-09-07T00:00:00Z" }]);
    p.defaultRoot = async () => second;
    const c = new AppController(p);
    await c.boot();
    await settle(c, () => c.getState().scanning === null && c.getState().books.length === 12);
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().sources.map((x) => x.root)).toEqual([FIXTURE_ROOT, second]);
    expect((await p.sources.load()).length).toBe(2);
  });

  it("removes a folder from the shelf without touching it on disk", async () => {
    const p = platform(FIXTURE_ROOT);
    const c = new AppController(p);
    await c.addSource(FIXTURE_ROOT);
    await c.addSource(second);
    await settle(c, () => c.getState().scanning === null);
    await c.removeSource(sourceId(second));
    const s = c.getState();
    expect(s.phase).toBe("ready");
    expect(s.sources.map((x) => x.root)).toEqual([FIXTURE_ROOT]);
    expect(s.books.length).toBe(11);
    expect(await p.sources.load()).toEqual([{ root: FIXTURE_ROOT, addedAt: s.sources[0]!.addedAt }]);
    expect((await fs.stat(path.join(second, ".ribbon", "library.csv"))).isFile()).toBe(true);
    await c.removeSource(sourceId(FIXTURE_ROOT));
    expect(c.getState().phase).toBe("pick");
    expect(c.getState().books).toEqual([]);
  });

  it("boots to the first screen with the error when the only folder is gone", async () => {
    const p = platform(FIXTURE_ROOT);
    await p.sources.save([{ root: path.join(FIXTURE_ROOT, "does-not-exist"), addedAt: "2026-09-07T00:00:00Z" }]);
    const c = new AppController(p);
    await c.boot();
    expect(c.getState().phase).toBe("pick");
    expect(c.getState().error).toMatch(/Could not open/);
  });
});

describe("AppController series by hand", () => {
  it("creates a series from picked books, shows it, and deletes it again", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    await c.addSource(FIXTURE_ROOT);
    await settle(c, () => c.getState().scanning === null);
    const [a, b] = c.getState().books.slice(0, 2).map((x) => x.book.id) as [string, string];
    await c.createSeries("My Picks", [b, a]);
    const g = c.getState().series["my-picks"];
    expect(g?.choices.map((ch) => ch.bookId)).toEqual([b, a]);
    expect(c.detectedSeries().find((x) => x.key === "my-picks")).toEqual({ key: "my-picks", name: "My Picks", bookIds: [b, a], added: [b, a] });
    expect((await fs.stat(path.join(FIXTURE_ROOT, ".ribbon", "series", "my-picks.csv"))).isFile()).toBe(true);
    // A second one of the same name gets its own key.
    await c.createSeries("My Picks", [a]);
    expect(Object.keys(c.getState().series).sort()).toEqual(["my-picks", "my-picks-2"]);
    await c.deleteSeries("my-picks");
    await c.deleteSeries("my-picks-2");
    expect(c.getState().series).toEqual({});
    expect(c.detectedSeries().some((x) => x.key.startsWith("my-picks"))).toBe(false);
    await expect(fs.stat(path.join(FIXTURE_ROOT, ".ribbon", "series", "my-picks.csv"))).rejects.toThrow();
  });
});

describe("libraryRootOf", () => {
  it("strips a trailing .ribbon in either slash style", () => {
    expect(libraryRootOf("\\\\nas\\media\\Books\\.ribbon")).toBe("\\\\nas\\media\\Books");
    expect(libraryRootOf("E:\\books\\.ribbon\\")).toBe("E:\\books");
    expect(libraryRootOf("/home/k/books/.ribbon")).toBe("/home/k/books");
    expect(libraryRootOf("E:\\books")).toBe("E:\\books");
    expect(libraryRootOf("E:\\books\\.ribbonus")).toBe("E:\\books\\.ribbonus");
  });
});
