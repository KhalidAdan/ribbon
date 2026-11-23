import type { Check } from "../run";
import type { Ribbon } from "../app";

const TRACK = "[role=dialog] [data-comic-track]";

/** The comic open and ready at this page (counted from 0), its picture drawn. */
async function shown(r: Ribbon, page: number, timeout = 15_000): Promise<boolean> {
  return r.page
    .waitForFunction(
      (at) => {
        const c = window.__ribbon.getState().comic;
        return c?.status === "ready" && c.page === at && !!document.querySelector(`[role=dialog] canvas[data-page="${at + 1}"][data-drawn]`);
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
 */
function turnByKey(r: Ribbon, key: string, to: number): Promise<number> {
  const timed = r.page.evaluate(
    ({ key, to }) =>
      new Promise<number>((done) => {
        let t0 = 0;
        const onKey = (e: KeyboardEvent) => {
          if (e.key !== key) return;
          window.removeEventListener("keydown", onKey, true);
          t0 = performance.now();
          const look = () => {
            if (document.querySelector(`[role=dialog] canvas[data-page="${to + 1}"][data-drawn]`)) return done(performance.now() - t0);
            if (performance.now() - t0 > 10_000) return done(-1);
            requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        };
        window.addEventListener("keydown", onKey, true);
      }),
    { key, to },
  );
  return r.page.keyboard.press(key).then(() => timed);
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

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
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one", fit: "page" }));

    const opened = await page.evaluate(async (id) => {
      const t0 = performance.now();
      await window.__ribbon.openComic(id);
      return { ms: Math.round(performance.now() - t0), status: window.__ribbon.getState().comic?.status ?? "closed" };
    }, r.comicId);
    t.expect(opened.status === "ready", "the comic opens", opened.status);
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

    // Two pages, as printed: the cover alone, then pairs, and the wide page (the eleventh) alone.
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "two" }));
    await page.evaluate(() => window.__ribbon.turnComic(1, "seek"));
    await shown(r, 1);
    const pair = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-comic-track] > div:first-child canvas[data-page]")].map((c) => (c as HTMLElement).dataset.page));
    t.expect(pair.join(",") === "2,3", "two pages up shows the second and third side by side", pair.join(","));
    await page.evaluate(() => window.__ribbon.turnComic(10, "seek"));
    await shown(r, 10);
    const wide = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-comic-track] > div:first-child canvas[data-page]")].map((c) => (c as HTMLElement).dataset.page));
    t.expect(wide.join(",") === "11", "a page drawn across two has the screen to itself", wide.join(","));
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "one" }));

    // Left at a page and closed, it opens there again.
    await page.evaluate(() => window.__ribbon.turnComic(7, "seek"));
    await shown(r, 7);
    await page.evaluate(() => window.__ribbon.closeComic());
    t.expect(await page.evaluate(() => window.__ribbon.getState().comic === null), "it closes");
    await page.evaluate((id) => window.__ribbon.openComic(id), r.comicId);
    t.expect(await shown(r, 7), "opened again, it is at the page it was left on", `page ${(await pageNow(r)) + 1}`);
    await page.evaluate(() => window.__ribbon.closeComic());
  },
};
