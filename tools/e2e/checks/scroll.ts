import type { Check } from "../run";
import { placeNow, reading, visibleLines } from "../app";

const SCROLLER = "[role=dialog] .quiet-scroll.overflow-y-auto";

/** Scrolling: by wheel, and through the whole book as if the scrollbar were dragged, never without text. */
export const scrollCheck: Check = {
  name: "scroll",
  about: "the wheel scrolls and moves the place; the whole book scrolls through without a frame lacking text",
  async run(r, t) {
    const { page } = r;
    await reading(r, "scroll");
    await page.evaluate(() => window.__ribbon.moveReading({ section: 10, block: 0, offset: 0 }, "seek"));
    await page.waitForTimeout(1500);
    const at = await placeNow(page);
    const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.move(vp.w / 2, vp.h / 2);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(600);
    t.expect((await placeNow(page)) !== at, "the wheel scrolls and the place follows");
    t.expect((await visibleLines(page)) > 0, "with text on screen");

    // The whole book in 10 s: a scrollbar dragged top to bottom, every frame looked at.
    await page.waitForTimeout(2000);
    const drive = await page.evaluate(
      (sel) =>
        new Promise<{ px: number; frames: number; empty: number; ms: number }>((done) => {
          const el = document.querySelector(sel) as HTMLElement;
          const px = el.scrollHeight - el.clientHeight;
          const t0 = performance.now();
          let frames = 0;
          let empty = 0;
          const step = (now: number) => {
            const k = Math.min(1, (now - t0) / 10_000);
            el.scrollTop = k * px;
            frames++;
            if (!el.querySelector("[data-block]")) empty++;
            if (k < 1) requestAnimationFrame(step);
            else setTimeout(() => done({ px, frames, empty, ms: performance.now() - t0 }), 500);
          };
          requestAnimationFrame(step);
        }),
      SCROLLER,
    );
    t.expect(drive.empty === 0, "the whole book scrolls through without a frame lacking text", `${drive.empty} of ${drive.frames} frames`);
    const last = await page.evaluate(() => {
      const s = window.__ribbon.getState().reading!;
      const linear = s.text!.ebook.sections.map((x, i) => (x.linear ? i : -1)).filter((i) => i >= 0);
      return { section: s.place?.section, last: linear[linear.length - 1] };
    });
    t.expect(last.section === last.last, "and ends in the book's last section", `section ${last.section} of ${last.last}`);
    t.note(`whole book: ${Math.round(drive.px)} px in ${Math.round(drive.ms)} ms, ${Math.round(drive.frames / (drive.ms / 1000))} frames a second`);
    await reading(r, "pages");
  },
};
