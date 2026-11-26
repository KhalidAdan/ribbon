import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Check } from "../run";
import { CHECKS_COMIC, CHECKS_COMIC_INFO, CHECKS_LONG_COMIC, CHECKS_PDF, closeReader, type Ribbon } from "../app";

const TRACK = "[role=dialog] [data-comic-track]";

/** The comic open and ready at this page (counted from 0), its picture drawn. */
async function shown(r: Ribbon, page: number, timeout = 15_000): Promise<boolean> {
  return r.page
    .waitForFunction(
      (at) => {
        const c = window.__ribbon.getState().comic;
        return c?.status === "ready" && c.page === at && !!document.querySelector(`[role=dialog] [data-on-screen] canvas[data-page="${at + 1}"][data-drawn]`);
      },
      page,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

function pageNow(r: Ribbon): Promise<number> {
  return r.page.evaluate(() => {
    const c = window.__ribbon.getState().comic;
    return c?.status === "ready" ? c.page : -1;
  });
}

/**
 * Turn by a real key, and time it in the page: from the key going down to the first frame in which the page
 * turned to has its picture drawn. Inside the window of pages kept ready, that should be the next frame.
 * The page is set listening for the key before the key is pressed: pressed while the listener was still on its
 * way, at six times slower, the key was missed and the wait never ended.
 */
async function turnByKey(r: Ribbon, key: string, to: number): Promise<number> {
  await r.page.evaluate(
    ({ key, to }) => {
      (window as unknown as { __comicTurn: Promise<number> }).__comicTurn = new Promise<number>((done) => {
        const onKey = (e: KeyboardEvent) => {
          if (e.key !== key) return;
          window.removeEventListener("keydown", onKey, true);
          const t0 = performance.now();
          const look = () => {
            if (document.querySelector(`[role=dialog] [data-on-screen] canvas[data-page="${to + 1}"][data-drawn]`)) return done(performance.now() - t0);
            if (performance.now() - t0 > 10_000) return done(-1);
            requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        };
        window.addEventListener("keydown", onKey, true);
        // A key that never arrives is a failure to report, not a wait without end.
        setTimeout(() => done(-1), 20_000);
      });
    },
    { key, to },
  );
  await r.page.keyboard.press(key);
  return r.page.evaluate(() => (window as unknown as { __comicTurn: Promise<number> }).__comicTurn);
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

/** The strip of small pages: whether every slot of it in view has its picture drawn. Put on the page once, for the waits below. */
async function watchTheStrip(r: Ribbon): Promise<void> {
  await r.page.evaluate(() => {
    (window as unknown as { __stripFilled: () => boolean }).__stripFilled = () => {
      const scroller = document.querySelector("[role=dialog] [data-comic-strip] > div");
      if (!scroller) return false;
      const box = scroller.getBoundingClientRect();
      const inView = [...scroller.querySelectorAll("[data-strip-page]")].filter((slot) => {
        const b = slot.getBoundingClientRect();
        return b.right > box.left && b.left < box.right;
      });
      return inView.length > 0 && inView.every((slot) => !!slot.querySelector("canvas[data-drawn]"));
    };
  });
}

/**
 * Show the strip by a real key and time it in the page: from the key going down to the first frame in which
 * every small page in view is drawn. Listening before the key is pressed, as `turnByKey` does.
 */
async function stripByKey(r: Ribbon, timeout = 30_000): Promise<number> {
  await r.page.evaluate((timeout) => {
    const w = window as unknown as { __stripShown: Promise<number>; __stripFilled: () => boolean };
    w.__stripShown = new Promise<number>((done) => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "t") return;
        window.removeEventListener("keydown", onKey, true);
        const t0 = performance.now();
        const look = () => {
          if (w.__stripFilled()) return done(performance.now() - t0);
          if (performance.now() - t0 > timeout) return done(-1);
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      };
      window.addEventListener("keydown", onKey, true);
      setTimeout(() => done(-1), timeout + 10_000);
    });
  }, timeout);
  await r.page.keyboard.press("t");
  return r.page.evaluate(() => (window as unknown as { __stripShown: Promise<number> }).__stripShown);
}

/** Open a comic at a page with the strip shown, and time it: from asking to the first frame with every small page in view drawn. */
async function openToFilledStrip(r: Ribbon, id: string, page: number, timeout = 60_000): Promise<number> {
  return r.page.evaluate(
    async ({ id, page, timeout }) => {
      const w = window as unknown as { __stripFilled: () => boolean };
      const t0 = performance.now();
      await window.__ribbon.openComic(id);
      window.__ribbon.turnComic(page, "seek");
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        if (w.__stripFilled()) return performance.now() - t0;
        if (performance.now() - t0 > timeout) return -1;
      }
    },
    { id, page, timeout },
  );
}

/** How far the page being read sits from the middle of the strip, in pixels; null with no strip or no page outlined. */
function offCentre(r: Ribbon): Promise<number | null> {
  return r.page.evaluate(() => {
    const scroller = document.querySelector("[role=dialog] [data-comic-strip] > div");
    const reading = scroller?.querySelector("[aria-current=page]");
    if (!scroller || !reading) return null;
    const [s, p] = [scroller.getBoundingClientRect(), reading.getBoundingClientRect()];
    return Math.round(p.left + p.width / 2 - (s.left + s.width / 2));
  });
}

/**
 * The web view's memory, every one of its processes together, in megabytes: what Windows says they hold for
 * themselves. After a collection, so what is measured is what is kept. Null where it can't be asked.
 */
async function webviewMemory(r: Ribbon): Promise<number | null> {
  if (process.platform !== "win32") return null;
  await r.cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await r.page.waitForTimeout(1000);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum"], { encoding: "utf8" });
    const bytes = Number(out.trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : null;
  } catch {
    return null;
  }
}

/** The small pages kept for a comic in the run's Ribbon folder (comic_small.rs): how many, and their size on disk. */
async function keptSmallPages(r: Ribbon, comicFile: string): Promise<{ files: number; bytes: number } | null> {
  if (!r.home) return null;
  const base = path.join(r.home, "small-pages");
  for (const folder of await fs.readdir(base).catch(() => [] as string[])) {
    // Each comic's folder notes the file its pictures were made from.
    const about = await fs.readFile(path.join(base, folder, "about.txt"), "utf8").catch(() => "");
    if (!about.split("\n")[1]?.endsWith(comicFile)) continue;
    const pictures = (await fs.readdir(path.join(base, folder))).filter((f) => f.endsWith(".jpg"));
    const sizes = await Promise.all(pictures.map((f) => fs.stat(path.join(base, folder, f)).then((s) => s.size)));
    return { files: pictures.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  }
  return { files: 0, bytes: 0 };
}

const mb = (n: number | null) => (n === null ? "not measured" : `${n} MB`);

/**
 * Scroll the long scroll with the wheel, as a person does, a notch at a time, and time the frames meanwhile: the
 * gaps between them, and how many took longer than 50 ms. The page drawn with each notch is the scroll's to keep up with.
 */
async function wheelThrough(r: Ribbon, notches: number, by = 120): Promise<{ p50: number; p95: number; max: number; long: number; frames: number }> {
  await r.page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__frames = [];
    w.__recording = true;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__frames.push(now - last);
      last = now;
      if (w.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const view = await r.page.evaluate(() => {
    const b = document.querySelector("[data-comic-scroll]")!.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await r.page.mouse.move(view.x, view.y);
  for (let i = 0; i < notches; i++) {
    await r.page.mouse.wheel(0, by);
    await r.page.waitForTimeout(16);
  }
  await r.page.waitForTimeout(300);
  const frames = await r.page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__recording = false;
    return w.__frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0, long: frames.filter((f) => f > 50).length, frames: frames.length };
}

const frameNote = (f: { p50: number; p95: number; max: number; long: number; frames: number }) => `frames ${f.p50.toFixed(1)} ms at the median, ${f.p95.toFixed(1)} p95, ${f.max.toFixed(0)} slowest, ${f.long} of ${f.frames} over 50 ms`;

/** The long scroll's state: the page being read, where its place is in the view, and how many pages are drawn. */
function scrollState(r: Ribbon): Promise<{ page: number; top: number | null; width: number; canvases: number; slider: number }> {
  return r.page.evaluate(() => {
    const view = document.querySelector("[data-comic-scroll]");
    const reading = view?.querySelector("[data-reading]") as HTMLElement | null;
    const c = window.__ribbon.getState().comic;
    return {
      page: c?.status === "ready" ? c.page : -1,
      top: view && reading ? Math.round(reading.getBoundingClientRect().top - view.getBoundingClientRect().top) : null,
      width: reading ? parseFloat(reading.style.width) : 0,
      canvases: view?.querySelectorAll("canvas").length ?? 0,
      slider: Number((document.querySelector("[role=dialog] footer input[type=range]") as HTMLInputElement | null)?.value ?? 0),
    };
  });
}

/** A comic opens to its page, turns by key, click and pen, shows two pages as printed, and comes back where it was left. */
export const comicCheck: Check = {
  name: "comic",
  about: "a comic opens, turns by key, click and pen, puts a wide page alone, and opens again at the page it was left on",
  async run(r, t) {
    const { page, cdp } = r;
    if (!r.comicId) {
      t.expect(false, "the library has the checks' comic", "none was found; run.ts makes one");
      return;
    }
    // Its details, as its ComicInfo.xml gives them, read by the scan and named from on the shelf (docs/BOOK-DETAILS.md, step 3).
    const details = await page.evaluate((id) => {
      const b = window.__ribbon.getState().books.find((x) => x.book.id === id)!.book;
      return { title: b.title, author: b.author, issue: b.issue ?? "", coverDate: b.coverDate ?? "", colours: b.credits?.colours ?? [], arcs: b.storyArcs ?? [] };
    }, r.comicId);
    const info = CHECKS_COMIC_INFO;
    t.expect(
      details.title === CHECKS_COMIC.title && details.author === `${info.Writer}; ${info.Penciller}` && details.issue === info.Number && details.coverDate === "2024-07" && details.colours.join() === info.Colorist && details.arcs.join() === info.StoryArc,
      "the comic is named and credited from its ComicInfo.xml",
      JSON.stringify(details),
    );
    // Its page, from the library: the checks before may have left a book open to read, which covers it.
    await closeReader(r);
    await page.evaluate((id) => window.__ribbon.openReader(id), r.comicId);
    const names = [info.Inker, info.Letterer, info.CoverArtist, info.Editor, info.Imprint];
    const credited = await page
      .waitForFunction((all) => all.every((n) => document.body.innerText.includes(n)), names, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const missing = credited ? [] : await page.evaluate((all) => all.filter((n) => !document.body.innerText.includes(n)), names);
    t.expect(credited, "its page lists who made it, by role, and its imprint", missing.length > 0 ? `not on the page: ${missing.join(", ")}` : "");
    await page.evaluate(() => window.__ribbon.showLibrary());

    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one", fit: "page" }));

    const opened = await page.evaluate(async (id) => {
      const t0 = performance.now();
      await window.__ribbon.openComic(id);
      return { ms: Math.round(performance.now() - t0), status: window.__ribbon.getState().comic?.status ?? "closed" };
    }, r.comicId);
    t.expect(opened.status === "ready", "the comic opens", opened.status);
    // From its first page, wherever an earlier run in this library left it.
    await page.evaluate(() => window.__ribbon.turnComic(0, "seek"));
    t.expect(await shown(r, 0), "its first page is drawn");
    t.note(`opened in ${opened.ms} ms`);
    // The window of pages around the first fills: turns after this are from pages kept ready.
    await page.waitForTimeout(1500);

    const turns: number[] = [];
    for (let to = 1; to <= 20; to++) {
      const ms = await turnByKey(r, "ArrowRight", to);
      if (ms >= 0) turns.push(ms);
      await page.waitForTimeout(150);
    }
    t.expect(turns.length === 20 && (await pageNow(r)) === 20, "twenty presses of the right arrow turn twenty pages, each drawn", `${turns.length} drawn, at page ${(await pageNow(r)) + 1}`);
    const sorted = [...turns].sort((a, b) => a - b);
    t.note(`a turn by key, to the frame its page is drawn: median ${percentile(sorted, 0.5).toFixed(1)} ms, p95 ${percentile(sorted, 0.95).toFixed(1)} ms, slowest ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`);
    t.expect(percentile(sorted, 0.5) < 100, "a turn inside the window of pages kept ready is drawn within a tenth of a second", `median ${percentile(sorted, 0.5).toFixed(1)} ms`);

    const back = await turnByKey(r, "ArrowLeft", 19);
    t.expect(back >= 0 && (await pageNow(r)) === 19, "the left arrow turns back");

    const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.click(box.w * 0.9, box.h / 2);
    t.expect(await shown(r, 20), "a click on the right of the page turns it");
    await page.mouse.click(box.w * 0.1, box.h / 2);
    t.expect(await shown(r, 19), "a click on the left turns back");

    // A pen dragged left across the page, a frame between moves, as swipe.ts drags the reader's.
    const start = Date.now() / 1000;
    const y = box.h / 2;
    const pen = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, i: number) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", timestamp: start + (i * 16) / 1000 });
    await pen("mousePressed", box.w * 0.8, 0);
    let midway = "";
    for (let i = 1; i <= 12; i++) {
      await pen("mouseMoved", box.w * (0.8 - (0.6 * i) / 12), i);
      await page.waitForTimeout(16);
      if (i === 6) midway = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.style.transform ?? "", TRACK);
    }
    await pen("mouseReleased", box.w * 0.2, 12.5);
    t.expect(midway.includes("translate3d(-"), "the page follows a pen", midway || "(no transform)");
    t.expect(await shown(r, 20, 5000), "a long drag left turns to the next page");
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLElement | null)?.style.transform === "", TRACK, { timeout: 3000 }).catch(() => undefined);

    await page.keyboard.press("End");
    const last = await page.evaluate(() => {
      const c = window.__ribbon.getState().comic;
      return c?.status === "ready" ? c.pages.length - 1 : -1;
    });
    t.expect(await shown(r, last), "End goes to the last page, drawn though it was nowhere near the window", `page ${last + 1}`);
    await page.keyboard.press("Home");
    t.expect(await shown(r, 0), "Home goes to the first");

    // The strip of small pages (docs/COMICS.md, section 15): hidden to start with, as a reader first finds it.
    await watchTheStrip(r);
    await page.evaluate(() => window.__ribbon.setComicSettings({ strip: false }));
    await page.evaluate(() => window.__ribbon.turnComic(12, "seek"));
    await shown(r, 12);
    t.expect(await page.evaluate(() => !document.querySelector("[data-comic-strip]")), "the strip is hidden until asked for");
    // What the strip costs a turn: the same ten turns from page 13, without it and then with it, each after the
    // window of pages around page 13 has had the same while to fill.
    const tenTurns = async (): Promise<number[]> => {
      await page.waitForTimeout(1500);
      const times: number[] = [];
      for (let to = 13; to <= 22; to++) {
        const ms = await turnByKey(r, "ArrowRight", to);
        if (ms >= 0) times.push(ms);
        await page.waitForTimeout(150);
      }
      return times.sort((a, b) => a - b);
    };
    const plainSorted = await tenTurns();
    await page.evaluate(() => window.__ribbon.turnComic(12, "seek"));
    await shown(r, 12);
    const withoutStrip = await webviewMemory(r);
    const fill = await stripByKey(r);
    t.expect(fill >= 0, "T shows the strip, every small page in view drawn", fill < 0 ? `not within 30 s; the page said: ${r.said.slice(-4).join(" | ") || "nothing"}` : undefined);
    t.note(`the strip's first fill, ${await page.evaluate(() => document.querySelectorAll("[data-comic-strip] [data-strip-page]").length)} slots drawn, every small page made then: ${fill.toFixed(0)} ms`);
    const centred = await offCentre(r);
    t.expect(centred !== null && Math.abs(centred) <= 40, "the page being read is outlined in the middle of the strip", `${centred ?? "none"} px from the middle`);
    const withStrip = await webviewMemory(r);

    const stripSorted = await tenTurns();
    t.expect(stripSorted.length === 10 && percentile(stripSorted, 0.5) < 100, "with the strip shown, a turn is still drawn within a tenth of a second", `median ${percentile(stripSorted, 0.5).toFixed(1)} ms`);
    t.note(`ten turns by key from page 13, to the frame each page is drawn: median ${percentile(plainSorted, 0.5).toFixed(1)} ms without the strip, ${percentile(stripSorted, 0.5).toFixed(1)} ms with it; p95 ${percentile(plainSorted, 0.95).toFixed(1)} and ${percentile(stripSorted, 0.95).toFixed(1)} ms`);
    t.expect(Math.abs((await offCentre(r)) ?? 999) <= 40, "turning keeps the page being read in the middle of the strip", `${await offCentre(r)} px from the middle`);

    await page.click('[role=dialog] [data-comic-strip] [data-strip-page="26"]');
    t.expect(await shown(r, 25), "a click on a small page goes to it");
    const kept = await keptSmallPages(r, CHECKS_COMIC.file);
    if (kept) t.note(`kept for the 40-page comic: ${kept.files} small pages, ${(kept.bytes / 1024).toFixed(0)} KB, ${(kept.bytes / 1024 / Math.max(1, kept.files)).toFixed(1)} KB each`);

    if (r.longComicId) {
      // An omnibus: the strip costs what it does for an issue, wherever in it the reader is.
      await page.evaluate(() => window.__ribbon.closeComic());
      const cold = await openToFilledStrip(r, r.longComicId, 299);
      t.expect(cold >= 0, "a 600-page comic opens in its middle with the strip filled", cold < 0 ? `the page said: ${r.said.slice(-4).join(" | ") || "nothing"}` : undefined);
      await page.evaluate(() => window.__ribbon.closeComic());
      const warm = await openToFilledStrip(r, r.longComicId, 299);
      t.note(`600 pages, opened at page 300 to the strip filled: ${cold.toFixed(0)} ms with its small pages made, ${warm.toFixed(0)} ms with them kept`);
      const keptLong = await keptSmallPages(r, CHECKS_LONG_COMIC.file);
      t.expect(!!keptLong && keptLong.files > 0 && keptLong.files < 60, "only the small pages near what the strip shows are made, not the book's 600", `${keptLong?.files ?? "?"} made`);
      // Along a hundred pages of the strip, a frame at a time, and the pictures fill where it stops.
      const along = await page.evaluate(async () => {
        const w = window as unknown as { __stripFilled: () => boolean };
        const scroller = document.querySelector("[role=dialog] [data-comic-strip] > div")!;
        for (let i = 0; i < 100; i++) {
          scroller.scrollLeft += 72;
          await new Promise((r) => requestAnimationFrame(r));
        }
        const t0 = performance.now();
        while (!w.__stripFilled() && performance.now() - t0 < 30_000) await new Promise((r) => requestAnimationFrame(r));
        return { filled: w.__stripFilled(), ms: performance.now() - t0 };
      });
      t.expect(along.filled, "scrolled a hundred pages along, the strip fills where it stops", `${along.ms.toFixed(0)} ms`);
      const afterLong = await webviewMemory(r);
      const keptAlong = await keptSmallPages(r, CHECKS_LONG_COMIC.file);
      t.note(`the web view's memory: ${mb(withoutStrip)} reading without the strip, ${mb(withStrip)} with it, ${mb(afterLong)} after a hundred pages along an omnibus's strip; ${keptAlong?.files ?? "?"} of its small pages kept, ${((keptAlong?.bytes ?? 0) / 1024).toFixed(0)} KB`);
      await page.evaluate(() => window.__ribbon.closeComic());
      await page.evaluate((id) => window.__ribbon.openComic(id), r.comicId);
      await page.evaluate(() => window.__ribbon.turnComic(25, "seek"));
      await shown(r, 25);
    }

    await page.keyboard.press("t");
    t.expect(await page.waitForFunction(() => !document.querySelector("[data-comic-strip]"), null, { timeout: 5000 }).then(() => true, () => false), "T hides the strip again");
    await page.evaluate(() => window.__ribbon.setComicSettings({ strip: false }));

    // The view's keys, going to a page, the ground and the zoom (docs/COMICS.md, section 15), from settings of the check's own.
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one", fit: "page", ground: "ribbon", strip: false }));
    await page.evaluate(() => window.__ribbon.turnComic(5, "seek"));
    await shown(r, 5);
    const boxHasKeys = () => page.waitForFunction(() => document.activeElement?.id === "comic-jump-page", null, { timeout: 5000 }).then(() => true, () => false);
    const noDialog = () => page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 5000 }).then(() => true, () => false);
    /** What the box was doing, for a failure: whether it is open, what it holds, and what has the keys. */
    const theBox = () =>
      page.evaluate(() => {
        const field = document.querySelector("#comic-jump-page") as HTMLInputElement | null;
        const keys = document.activeElement;
        return `box ${document.querySelector("dialog[open]") ? "open" : "closed"}, holding "${field?.value ?? ""}", the keys with ${keys?.tagName.toLowerCase() ?? "nothing"}${keys?.id ? `#${keys.id}` : ""}`;
      });
    await page.keyboard.press("g");
    t.expect(await boxHasKeys(), "G opens Go to page, its box taking the keys");
    t.expect((await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value)) === "6", "the box holds the page being read");
    // G again in the very task the box closes in, before the browser's close event for it arrives (a task later): the
    // box opened again must not be closed by that late event (ui/modal.ts, `closedOnItsOwn`). Done by hand, this is a race
    // a check can lose by luck either way; here it is the same every run.
    await page.evaluate(() => {
      const close = HTMLDialogElement.prototype.close;
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, ...args: Parameters<typeof close>) {
        HTMLDialogElement.prototype.close = close;
        close.apply(this, args);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
      };
    });
    await page.keyboard.type("30");
    await page.keyboard.press("Enter");
    t.expect(await shown(r, 29), "a number typed and Enter go to that page", `at page ${(await pageNow(r)) + 1}`);
    const reopened = await boxHasKeys();
    t.expect(reopened, "G pressed as the box goes opens it again, and its old close doesn't shut the new one");
    await page.keyboard.type("999");
    const typed = await theBox();
    await page.keyboard.press("Enter");
    t.expect(await shown(r, 39), "a number past the end goes to the last page", `at page ${(await pageNow(r)) + 1}; G ${reopened ? "opened" : "did not open"} the box; when Enter was pressed, ${typed}; the page said: ${r.said.slice(-3).join(" | ") || "nothing"}`);
    await noDialog();
    await page.keyboard.press("g");
    await boxHasKeys();
    await page.keyboard.press("Escape");
    t.expect((await noDialog()) && (await page.evaluate(() => window.__ribbon.getState().comic?.status)) === "ready", "Escape closes the box, and not the comic");
    await page.keyboard.press("?");
    const listed = await page.waitForFunction(() => document.querySelector("dialog[open]")?.textContent?.includes("Go to a page") ?? false, null, { timeout: 5000 }).then(() => true, () => false);
    t.expect(listed, "? shows the keys");
    await page.keyboard.press("Escape");
    t.expect(await noDialog(), "and Escape puts the list away");

    await page.evaluate(() => window.__ribbon.turnComic(5, "seek"));
    await shown(r, 5);
    const canvasWidth = (at: number) => page.evaluate((at) => parseFloat((document.querySelector(`[role=dialog] [data-on-screen] canvas[data-page="${at}"]`) as HTMLElement | null)?.style.width ?? "0"), at);
    const whole = await canvasWidth(6);
    await page.keyboard.press("+");
    await page.waitForFunction(() => document.querySelector("[data-comic-view]")?.getAttribute("data-zoom") === "1", null, { timeout: 5000 }).catch(() => undefined);
    const larger = await canvasWidth(6);
    t.expect(Math.abs(larger / Math.max(1, whole) - 1.5) < 0.02, "+ draws the page half as large again", `${whole} to ${larger} px wide`);
    const zoomedTurn = await turnByKey(r, "ArrowRight", 6);
    const after = await page.evaluate(() => {
      const view = document.querySelector("[data-comic-view]") as HTMLElement;
      return { zoom: view.dataset.zoom, top: view.scrollTop };
    });
    t.expect(zoomedTurn >= 0 && after.zoom === "1" && after.top === 0, "turned, the next page keeps the zoom and comes in at its top", JSON.stringify(after));
    t.note(`a turn by key, zoomed one and a half times: ${zoomedTurn.toFixed(1)} ms to its page drawn`);
    await page.keyboard.press("0");
    await page.waitForFunction(() => document.querySelector("[data-comic-view]")?.getAttribute("data-zoom") === "0", null, { timeout: 5000 }).catch(() => undefined);
    t.expect(Math.abs((await canvasWidth(7)) - whole) <= 1, "0 goes back to the whole page");
    await page.mouse.click(box.w / 2, box.h / 2);
    const doubled = await page.waitForFunction(() => document.querySelector("[data-comic-view]")?.getAttribute("data-zoom") === "2", null, { timeout: 5000 }).then(() => true, () => false);
    t.expect(doubled && Math.abs((await canvasWidth(7)) / Math.max(1, whole) - 2) < 0.02, "a click in the middle draws the page twice as large");
    await page.mouse.click(box.w / 2, box.h / 2);
    t.expect(await page.waitForFunction(() => document.querySelector("[data-comic-view]")?.getAttribute("data-zoom") === "0", null, { timeout: 5000 }).then(() => true, () => false), "and another goes back to the whole page");

    await page.keyboard.press("b");
    const ground = await page.waitForFunction(() => (document.querySelector("[data-comic-view]") as HTMLElement | null)?.style.backgroundColor === "rgb(0, 0, 0)", null, { timeout: 5000 }).then(() => true, () => false);
    t.expect(ground, "B puts a black ground behind the page");
    await page.keyboard.press("3");
    const tall = await page.waitForFunction(() => {
      const view = document.querySelector("[data-comic-view]") as HTMLElement | null;
      const canvas = document.querySelector('[role=dialog] [data-on-screen] canvas[data-page="7"]') as HTMLElement | null;
      return !!view && !!canvas && Math.abs(parseFloat(canvas.style.height) - view.clientHeight) <= 1;
    }, null, { timeout: 5000 }).then(() => true, () => false);
    t.expect(tall, "3 fits the page to the height");
    await page.keyboard.press("d");
    t.expect(await page.waitForFunction(() => window.__ribbon.getState().comicSettings.up === "two", null, { timeout: 5000 }).then(() => true, () => false), "D puts two pages side by side");
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one", fit: "page", ground: "ribbon" }));

    // One long scroll (docs/COMICS.md, section 15): the pages one under another, read by the wheel.
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one", fit: "page", scroll: false, column: 1, strip: false }));
    await page.evaluate(() => window.__ribbon.turnComic(5, "seek"));
    await shown(r, 5);
    await page.keyboard.press("s");
    const scrolling = await page.waitForFunction(() => !!document.querySelector("[data-comic-scroll] [data-reading] canvas[data-drawn]"), null, { timeout: 15_000 }).then(() => true, () => false);
    let at = await scrollState(r);
    t.expect(scrolling && at.page === 5 && at.top !== null && Math.abs(at.top) <= 2, "S puts the pages in one long scroll, at the page being read", JSON.stringify(at));
    const issueFrames = await wheelThrough(r, 60);
    at = await scrollState(r);
    t.expect(at.page > 5 && at.slider === at.page + 1, "the wheel scrolls, and the place and the slider follow the page filling the top third", JSON.stringify(at));
    t.expect(at.canvases <= 6, "only the pages near the window are drawn", `${at.canvases} drawn`);
    t.note(`the long scroll of 40 pages, sixty notches of the wheel: ${frameNote(issueFrames)}`);
    await page.keyboard.press("g");
    await boxHasKeys();
    await page.keyboard.type("20");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__ribbon.getState().comic?.status === "ready" && (window.__ribbon.getState().comic as { page: number }).page === 19, null, { timeout: 5000 }).catch(() => undefined);
    await noDialog();
    await page.waitForTimeout(300);
    at = await scrollState(r);
    t.expect(at.page === 19 && at.top !== null && Math.abs(at.top) <= 2, "Go to page scrolls to the page, its top at the window's", JSON.stringify(at));
    const fullWidth = at.width;
    await page.keyboard.press("-");
    await page.waitForTimeout(300);
    at = await scrollState(r);
    t.expect(at.width < fullWidth && at.page === 19, "- makes the column narrower, keeping the page being read", `${fullWidth} to ${at.width} px wide, at page ${at.page + 1}`);
    await page.keyboard.press("0");
    await page.keyboard.press("End");
    await page.waitForTimeout(500);
    t.expect((await scrollState(r)).page === 39, "End scrolls to the last page");
    await page.keyboard.press("Home");
    await page.waitForTimeout(500);
    t.expect((await scrollState(r)).page === 0, "Home to the first");

    if (r.longComicId) {
      await page.evaluate(() => window.__ribbon.closeComic());
      await page.evaluate((id) => window.__ribbon.openComic(id), r.longComicId);
      await page.evaluate(() => window.__ribbon.turnComic(299, "seek"));
      const opened = await page.waitForFunction(() => !!document.querySelector('[data-comic-scroll] [data-scroll-page="300"] canvas[data-drawn]'), null, { timeout: 15_000 }).then(() => true, () => false);
      t.expect(opened, "a 600-page comic opens in the scroll at its page");
      const before = await webviewMemory(r);
      const bookFrames = await wheelThrough(r, 120);
      at = await scrollState(r);
      const scrolled = await webviewMemory(r);
      t.expect(at.page > 299 && at.canvases <= 6, "scrolled through an omnibus, only the pages near the window are drawn", JSON.stringify(at));
      t.note(`the long scroll of 600 pages, a hundred and twenty notches: ${frameNote(bookFrames)}; to page ${at.page + 1}`);
      t.note(`the web view's memory in the long scroll of 600 pages: ${mb(before)} opened, ${mb(scrolled)} after scrolling`);
      await page.evaluate(() => window.__ribbon.closeComic());
      await page.evaluate((id) => window.__ribbon.openComic(id), r.comicId);
    }
    await page.keyboard.press("s");
    await page.evaluate(() => window.__ribbon.setComicSettings({ scroll: false, column: 1 }));
    await page.evaluate(() => window.__ribbon.turnComic(5, "seek"));
    t.expect(await shown(r, 5), "S goes back to turning the pages");

    // Two pages, as printed: the cover alone, then pairs, and the wide page (the eleventh) alone. Each spread is
    // waited for whole: a page is placed once its file has come, and the reader may have just been made afresh
    // (leaving the long scroll does that), its pages still on their way.
    const spread = async (expected: string): Promise<string> => {
      await page.waitForFunction((expected) => [...document.querySelectorAll("[role=dialog] [data-comic-track] [data-on-screen] canvas[data-page][data-drawn]")].map((c) => (c as HTMLElement).dataset.page).join(",") === expected, expected, { timeout: 10_000 }).catch(() => undefined);
      return page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-comic-track] [data-on-screen] canvas[data-page]")].map((c) => (c as HTMLElement).dataset.page).join(","));
    };
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "two" }));
    await page.evaluate(() => window.__ribbon.turnComic(1, "seek"));
    await shown(r, 1);
    const pair = await spread("2,3");
    t.expect(pair === "2,3", "two pages up shows the second and third side by side", pair);
    await page.evaluate(() => window.__ribbon.turnComic(10, "seek"));
    await shown(r, 10);
    const wide = await spread("11");
    t.expect(wide === "11", "a page drawn across two has the screen to itself", wide);
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one" }));

    // Left at a page and closed, it opens there again.
    await page.evaluate(() => window.__ribbon.turnComic(7, "seek"));
    await shown(r, 7);
    await page.evaluate(() => window.__ribbon.closeComic());
    t.expect(await page.evaluate(() => window.__ribbon.getState().comic === null), "it closes");
    await page.evaluate((id) => window.__ribbon.openComic(id), r.comicId);
    t.expect(await shown(r, 7), "opened again, it is at the page it was left on", `page ${(await pageNow(r)) + 1}`);
    await page.evaluate(() => window.__ribbon.closeComic());

    // A PDF, read the same way: its pages drawn by pdf.js (docs/COMICS.md, section 12).
    if (!r.pdfId) {
      // Why, as far as the page can say: the book as the app has it, pdf.js asked to open it, and what the page wrote to its console.
      const why = await page.evaluate(async (title) => {
        const state = window.__ribbon.getState();
        const found = state.books.find((b) => b.book.title === title || (b.book.comic ?? "").toLowerCase().endsWith(".pdf"));
        if (!found) return `no such book among ${state.books.length} (comics: ${state.books.filter((b) => !!b.book.comic).map((b) => b.book.comic).join(", ")})`;
        const out = [`found as "${found.book.title}", ${found.book.pages ?? "no"} pages, ${found.book.sizeBytes} bytes`];
        try {
          await window.__ribbon.openComic(found.book.id);
          const c = window.__ribbon.getState().comic;
          out.push(`opening it: ${c?.status ?? "closed"}${c?.status === "failed" ? ` (${c.message})` : c?.status === "ready" ? `, ${c.pages.length} pages` : ""}`);
        } catch (e) {
          out.push(`threw: ${String(e)}`);
        }
        return out.join("; ");
      }, CHECKS_PDF.title);
      // Its file, fetched as pdf.js fetches it: the address is in what the app said.
      const address = r.said.map((line) => line.match(/https?:\/\/asset\.localhost\/\S+|asset:\/\/\S+/)?.[0]).find(Boolean);
      const fetched = address
        ? await page.evaluate(async (url) => {
            const lines: string[] = [];
            for (const range of ["bytes=0-99", "bytes=0-12480", ""]) {
              try {
                const answer = await fetch(url, range ? { headers: { range } } : {});
                const bytes = new Uint8Array(await answer.arrayBuffer());
                lines.push(`${range || "whole"}: ${answer.status}, ${bytes.length} bytes, starts "${String.fromCharCode(...bytes.subarray(0, 8))}", ${answer.headers.get("content-range") ?? "no content-range"}`);
              } catch (e) {
                lines.push(`${range || "whole"}: threw ${String(e)}`);
              }
            }
            return lines.join("; ");
          }, address)
        : "no address was said";
      t.expect(false, "the library has the checks' PDF, its pages counted", `${why}; fetched: ${fetched}; the page said: ${r.said.slice(-6).join(" | ") || "nothing"}`);
      return;
    }
    const pdf = await page.evaluate(async (id) => {
      const t0 = performance.now();
      await window.__ribbon.openComic(id);
      const c = window.__ribbon.getState().comic;
      return { ms: Math.round(performance.now() - t0), status: c?.status ?? "closed", pages: c?.status === "ready" ? c.pages.length : 0 };
    }, r.pdfId);
    t.expect(pdf.status === "ready" && pdf.pages === 30, "a PDF opens, with its pages counted", `${pdf.status}, ${pdf.pages} pages`);
    await page.evaluate(() => window.__ribbon.turnComic(0, "seek"));
    t.expect(await shown(r, 0, 30_000), "its first page is drawn");
    t.note(`the PDF opened in ${pdf.ms} ms`);
    await page.waitForTimeout(2500);
    const pdfTurns: number[] = [];
    for (let to = 1; to <= 10; to++) {
      const ms = await turnByKey(r, "ArrowRight", to);
      if (ms >= 0) pdfTurns.push(ms);
      await page.waitForTimeout(400);
    }
    const pdfSorted = [...pdfTurns].sort((a, b) => a - b);
    t.expect(pdfTurns.length === 10 && (await pageNow(r)) === 10, "ten presses of the right arrow turn ten of its pages, each drawn", `${pdfTurns.length} drawn, at page ${(await pageNow(r)) + 1}`);
    t.note(`a turn in the PDF, to the frame its page is drawn: median ${percentile(pdfSorted, 0.5).toFixed(1)} ms, p95 ${percentile(pdfSorted, 0.95).toFixed(1)} ms`);
    await page.keyboard.press("End");
    t.expect(await shown(r, 29, 30_000), "End goes to its last page, drawn out of the far end of the file");
    await page.evaluate(() => window.__ribbon.closeComic());
    await page.evaluate((id) => window.__ribbon.openComic(id), r.pdfId);
    t.expect(await shown(r, 29, 30_000), "opened again, it is at the page it was left on");
    await page.evaluate(() => window.__ribbon.closeComic());

    // A PDF's small pages are drawn by pdf.js and handed to Ribbon to keep (comic_small_keep): the first time drawn,
    // the next time fetched as a comic's are.
    await page.evaluate(() => window.__ribbon.setComicSettings({ strip: true }));
    const drawnSmall = await openToFilledStrip(r, r.pdfId, 14);
    t.expect(drawnSmall >= 0, "a PDF's strip fills, its small pages drawn by pdf.js", drawnSmall < 0 ? `the page said: ${r.said.slice(-4).join(" | ") || "nothing"}` : undefined);
    await page.waitForTimeout(500);
    const keptPdf = await keptSmallPages(r, CHECKS_PDF.file);
    t.expect(keptPdf === null || keptPdf.files > 0, "and kept by Ribbon", `${keptPdf?.files ?? "?"} kept`);
    await page.evaluate(() => window.__ribbon.closeComic());
    const keptSmall = await openToFilledStrip(r, r.pdfId, 14);
    t.note(`a PDF's strip, opened at page 15 to filled: ${drawnSmall.toFixed(0)} ms drawing its small pages, ${keptSmall.toFixed(0)} ms with them kept; ${keptPdf?.files ?? "?"} kept, ${((keptPdf?.bytes ?? 0) / 1024).toFixed(0)} KB`);
    await page.evaluate(() => window.__ribbon.closeComic());
    await page.evaluate(() => window.__ribbon.setComicSettings({ strip: false }));
  },
};
