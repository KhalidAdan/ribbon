import type { Check } from "../run";
import { reading, visibleLines } from "../app";

/**
 * Resizing the window, in both layouts: the text never leaves the screen
 * while the edge is dragged, and ends laid out for the new size. The
 * 0.12.0 regression went blank here and stayed blank.
 */
export const resizeCheck: Check = {
  name: "resize",
  about: "the text stays on screen while the window is resized, and reflows to the new size",
  async run(r, t) {
    const { page, cdp } = r;
    for (const layout of ["pages", "scroll"] as const) {
      await reading(r, layout);
      await page.waitForTimeout(1000);
      // Every frame from here on: did it have any of the book's text on screen?
      await page.evaluate(() => {
        const w = window as unknown as { __blank: number; __seen: number; __watching: boolean };
        w.__blank = 0;
        w.__seen = 0;
        w.__watching = true;
        const look = () => {
          const any = [...document.querySelectorAll("[role=dialog] [data-block]")].some((e) => {
            const b = e.getBoundingClientRect();
            return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
          });
          w.__seen++;
          if (!any) w.__blank++;
          if (w.__watching) requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      // A drag of the window's edge: twenty sizes, 30 ms apart.
      for (let i = 0; i < 20; i++) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200 - i * 25, height: 800 - i * 10, deviceScaleFactor: 0, mobile: false });
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(800);
      const { seen, blank } = await page.evaluate(() => {
        const w = window as unknown as { __blank: number; __seen: number; __watching: boolean };
        w.__watching = false;
        return { seen: w.__seen, blank: w.__blank };
      });
      t.expect(blank === 0, `${layout}: no frame without text while resizing`, `${blank} of ${seen} frames`);
      // A line laid out for the old, wider column overflows the new one.
      const tooWide = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] [data-block]")].filter((e) => e.scrollWidth > e.clientWidth + 2).length);
      t.expect(tooWide === 0, `${layout}: laid out again for the new size`, `${tooWide} lines too wide for the column`);
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await page.waitForTimeout(800);
      const lines = await visibleLines(page);
      t.expect(lines > 0, `${layout}: text after the window is back to its size`, `${lines} lines`);
    }
    await reading(r, "pages");
  },
};
