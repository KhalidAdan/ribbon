import type { Check } from "../run";
import { CHECKS_PDF, type Ribbon } from "../app";

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

    // Two pages, as printed: the cover alone, then pairs, and the wide page (the eleventh) alone.
    await page.evaluate(() => window.__ribbon.setComicSettings({ up: "two" }));
    await page.evaluate(() => window.__ribbon.turnComic(1, "seek"));
    await shown(r, 1);
    const pair = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-comic-track] [data-on-screen] canvas[data-page]")].map((c) => (c as HTMLElement).dataset.page));
    t.expect(pair.join(",") === "2,3", "two pages up shows the second and third side by side", pair.join(","));
    await page.evaluate(() => window.__ribbon.turnComic(10, "seek"));
    await shown(r, 10);
    const wide = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-comic-track] [data-on-screen] canvas[data-page]")].map((c) => (c as HTMLElement).dataset.page));
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
  },
};
