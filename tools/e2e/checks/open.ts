import type { Check } from "../run";
import { closeReader, placeNow, reading, silence, type Ribbon } from "../app";

interface Opened {
  /** ms from the open to the first frame with the book's text on screen, while it was still opening (the snapshot). */
  snapshot: number | null;
  /** ms to the first frame the reader was ready. */
  ready: number;
  /** ms to the first frame it had its pairing. */
  paired: number | null;
  /** The first line on screen in each of those frames, and where: the snapshot and the real page should agree. */
  firstLines: string[];
  place: string;
  narrator: string | null;
}

/** Open the test book, watching every frame until it is ready and paired (or 15 s). */
function open(r: Ribbon): Promise<Opened> {
  return r.page.evaluate(
    (id) =>
      new Promise<Opened>((done) => {
        const c = window.__ribbon;
        const t0 = performance.now();
        let snapshot: number | null = null;
        let ready: number | null = null;
        let paired: number | null = null;
        const firstLines = new Set<string>();
        void c.openReading(id);
        const look = () => {
          const s = c.getState().reading;
          const t = Math.round(performance.now() - t0);
          const line = document.querySelector("[role=dialog] [data-block]");
          if (line) {
            const b = line.getBoundingClientRect();
            firstLines.add(`${line.textContent?.slice(0, 30)} @ ${Math.round(b.left)},${Math.round(b.top)}`);
            if (snapshot === null && s?.status === "opening") snapshot = t;
          }
          if (ready === null && s?.status === "ready") ready = t;
          if (paired === null && s?.alignment) paired = t;
          if ((ready !== null && paired !== null && t - ready > 100) || t > 15_000) {
            const p = s?.place;
            const n = c.narratorInText();
            done({ snapshot, ready: ready ?? -1, paired, firstLines: [...firstLines], place: p ? `${p.section}:${p.block}:${p.offset}` : "", narrator: n ? `${n.section}:${n.block}:${n.offset}` : null });
          } else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
    r.bookId,
  );
}

/**
 * Opening a book: from cold; again, closed just after a page was turned, to
 * the page left, drawn at once from its snapshot and replaced in place; read
 * last, ready before its pairing; listened to last, at the narrator.
 */
export const openCheck: Check = {
  name: "open",
  about: "a book opens at once to the page left, and at the narrator when you listened last",
  async run(r, t) {
    const { page } = r;
    await closeReader(r);
    await page.evaluate(() => window.__ribbon.pause());
    let o = await open(r);
    t.expect(o.ready > 0, "opens from cold", `ready in ${o.ready} ms`);

    // Read last: go to a chapter, turn a page by hand once it is on screen, as a reader would, and close at once.
    // The page is on screen when the layout worker has laid the chapter out; its first chapter on the first launch
    // after a build can take most of a second. Closing at once comes before the reader keeps the chapter on its own
    // (it waits a moment after the chapter arrives): it is kept as the book closes.
    await page.evaluate(() => window.__ribbon.moveReading({ section: 12, block: 2, offset: 0 }, "seek"));
    await page.waitForFunction(() => document.querySelector('[role=dialog] [data-section="12"]') !== null, null, { timeout: 15_000 });
    const went = await placeNow(page);
    await page.keyboard.press("ArrowRight");
    const turned = await page
      .waitForFunction((from) => { const p = window.__ribbon.getState().reading?.place; return !!p && `${p.section}:${p.block}:${p.offset}` !== from; }, went, { timeout: 5_000 })
      .then(() => true, () => false);
    const left = await placeNow(page);
    t.expect(turned, "turns a page by hand", `${went} to ${left}`);
    await closeReader(r);
    await page.waitForTimeout(500);
    o = await open(r);
    t.expect(o.place === left, "opens at the page left", `${o.place}, left at ${left}`);
    // At once: from its snapshot while the book opens, or the book itself within the first frames. A
    // fast machine can be ready before any frame shows the opening (GitHub's runner: ready in 17 ms),
    // and a frame is all this sees; at 6x the opening takes most of a second, so the snapshot still shows.
    t.expect(o.snapshot !== null || o.ready <= 50, "draws the page left at once", `${o.snapshot === null ? "no frame while opening" : `snapshot at ${o.snapshot} ms`}, ready in ${o.ready} ms`);
    t.expect(o.firstLines.length === 1, "the real page replaces the snapshot in place", o.firstLines.join(" | "));
    t.expect(o.paired !== null && o.ready <= o.paired, "is ready no later than its pairing", `ready ${o.ready} ms, paired ${o.paired} ms`);

    // Listened last: with the reader closed, play from the library, pause, open.
    await page.evaluate(() => window.__ribbon.moveReading({ section: 20, block: 1, offset: 0 }, "seek"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__ribbon.listenFromHere());
    await silence(page);
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__ribbon.pause());
    await closeReader(r);
    await page.evaluate(() => window.__ribbon.play());
    await silence(page);
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.__ribbon.pause());
    await page.waitForTimeout(1200);
    o = await open(r);
    t.expect(o.narrator !== null && o.place === o.narrator, "opens at the narrator when you listened last", `${o.place}, narrator at ${o.narrator}`);
    t.note(`listened last: ready ${o.ready} ms, paired ${o.paired} ms`);
    await reading(r);
  },
};
