import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController, type Platform } from "../src/app/controller";
import { FakeMedia } from "./support/fake-media";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";
import type { MemoryHost } from "./support/memory-host";

/** A second folder, which the tests make go missing and come back. */
const OTHER = "/other";

/** The library's lifecycle (core/lifecycle.ts): folders opening, failing, removed, and the app's phase from them. */
describe("the library's lifecycle", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = proofWorld();
  });
  afterEach(() => restore());

  async function app(m: MemoryHost, roots: readonly string[], extra: Partial<Platform> = {}): Promise<AppController> {
    const c = new AppController(proofPlatform(proofHost(m, new Holds()), extra, roots));
    await c.boot();
    await settle();
    return c;
  }

  const otherArrives = (m: MemoryHost) => m.put(`${OTHER}/Elsewhere.epub`, "PK4");
  const idOf = (c: AppController, root: string) => c.getState().sources.find((s) => s.root === root)!.id;
  const bookId = (c: AppController, title: string) => c.getState().books.find((b) => b.book.title === title)!.book.id;

  it("opens a folder that failed at boot when it's picked again, and says no more that it couldn't", async () => {
    // A share that was away at launch, back and picked again, opened, and "Could not open" stayed: on the
    // library as an error, and in Settings beside the folder.
    const m = proofLibrary();
    const c = await app(m, [OTHER], { pickFolder: async () => OTHER });
    expect(c.getState().phase).toBe("pick");
    expect(c.getState().error).toMatch(/^Could not open \/other/);

    otherArrives(m);
    await c.pickLibrary();
    await settle();
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().books.map((b) => b.book.title)).toEqual(["Elsewhere"]);
    expect(c.getState().error).toBeNull();
    expect(c.getState().sourceStatus[idOf(c, OTHER)]).toMatchObject({ state: { status: "open" }, scanError: null });
    c.destroy();
  });

  it("goes back to the first screen when the one folder that opened is removed, though another that didn't is still listed", async () => {
    // Two tests for "no library" disagreed: whether any folder was listed, and whether any was open.
    const c = await app(proofLibrary(), [ROOT, OTHER]);
    expect(c.getState().phase).toBe("ready");
    expect(c.getState().sourceStatus[idOf(c, OTHER)]!.state).toEqual({ status: "failed", why: `not a directory: ${OTHER}` });

    await c.removeSource(idOf(c, ROOT));
    await settle();
    expect(c.getState().books).toEqual([]);
    expect(c.getState().phase).toBe("pick");
    c.destroy();
  });

  it("closes what showed a removed folder's books: the reader, a book's details, the end of one, a series' page", async () => {
    const c = await app(proofLibrary(), [ROOT]);
    // The end of a book, as it plays out.
    await c.playBook(c.getState().books.find((b) => b.book.title === "Paired")!);
    c.seek(119_500);
    await settle();
    for (const a of FakeMedia.all) a.advance(1_000);
    await settle();
    expect(c.getState().theEnd).toBe(bookId(c, "Paired"));
    await c.createSeries("A reading list", [bookId(c, "Only"), bookId(c, "Paired")]);
    c.openSeries(c.detectedSeries().find((g) => g.name === "A reading list")!.key);
    c.openEditBook(bookId(c, "Only"));
    await c.openReading(bookId(c, "Only"));
    expect(c.getState().reading).toMatchObject({ status: "ready" });

    await c.removeSource(idOf(c, ROOT));
    await settle();
    expect(c.getState()).toMatchObject({ reading: null, theEnd: null, editBook: null, screen: { pane: "library" } });
    c.destroy();
  });

  it("closes the reader and stops the sleep timer when Ribbon's folder is reset", async () => {
    // The reset went back to the first screen with the book still open to read over it, and the sleep timer ticking.
    vi.stubGlobal("window", { setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t) });
    const c = await app(proofLibrary(), [ROOT], { home: { path: async () => "/home", reveal: async () => undefined, reset: async () => true } });
    await c.playBook(c.getState().books.find((b) => b.book.title === "Paired")!);
    c.startSleep({ kind: "duration", ms: 600_000 });
    await c.openReading(bookId(c, "Only"));
    const timers = vi.getTimerCount();

    await c.resetHome();
    await settle();
    expect(c.getState()).toMatchObject({ phase: "pick", reading: null, sleep: { state: { status: "off" } } });
    // The sleep timer's tick is gone with it.
    expect(vi.getTimerCount()).toBeLessThan(timers);
    c.destroy();
  });
});
