import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { readsOf } from "../src/core/stats";
import { progressOf } from "../src/ui/progress";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

function platform(root: string, settings = memorySettings()): Platform {
  return { host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings };
}

describe("listening history through the app", () => {
  afterAll(async () => {
    const dir = path.join(FIXTURE_ROOT, ".ribbon", "positions");
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) if (f.endsWith(".ndjson") || f.endsWith(".json")) await fs.rm(path.join(dir, f), { force: true });
  });

  it("marks finished and not, starts again, corrects dates and deletes, and a fresh start sees it all", async () => {
    const settings = memorySettings();
    const c = new AppController(platform(FIXTURE_ROOT, settings));
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books.find((b) => b.book.path === "multi-mp3")!;
    const id = book.book.id;
    const s = () => c.getState();

    await c.markFinished(id);
    expect(progressOf(book, s()).finished).toBe(true);
    expect(readsOf(s().history.reads, id)).toHaveLength(1);

    await c.markUnfinished(id);
    expect(progressOf(book, s()).finished).toBe(false);
    expect(readsOf(s().history.reads, id)[0]!.finished).toBeUndefined();

    await c.markFinished(id);
    await c.listenAgain(id);
    const reads = readsOf(s().history.reads, id);
    expect(reads).toHaveLength(2);
    expect(reads[0]!.finished).toBeDefined();
    expect(reads[1]!.finished).toBeUndefined();

    await c.editRead(id, reads[0]!.id, "2025-01-01T12:00:00.000Z", "2025-02-01T12:00:00.000Z");
    expect(readsOf(s().history.reads, id)[0]!.finished).toBe("2025-02-01T12:00:00.000Z");

    await c.deleteRead(id, reads[1]!.id);
    expect(readsOf(s().history.reads, id)).toHaveLength(1);

    // Another start of the app, same settings (same device), reads the log beside the books.
    const again = new AppController(platform(FIXTURE_ROOT, settings));
    await again.boot();
    await again.pickLibrary();
    const back = readsOf(again.getState().history.reads, id);
    expect(back).toHaveLength(1);
    expect(back[0]!.started).toBe("2025-01-01T12:00:00.000Z");
    expect(progressOf(book, again.getState()).finished).toBe(true);
  });

  it("keeps the device id between starts", async () => {
    const settings = memorySettings();
    const a = new AppController(platform(FIXTURE_ROOT, settings));
    await a.boot();
    const first = (await settings.read()).deviceId;
    const b = new AppController(platform(FIXTURE_ROOT, settings));
    await b.boot();
    expect(typeof first).toBe("string");
    expect((await settings.read()).deviceId).toBe(first);
  });
});
