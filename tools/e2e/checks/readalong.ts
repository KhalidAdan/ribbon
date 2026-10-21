import type { Check } from "../run";
import { closeReader, reading, silence } from "../app";

const BAR = "[role=group][aria-label=Listening]";

/**
 * Read-along on a book opened afresh: the narrator's sentence is marked and
 * the mark moves on, the page turns with the narrator, the bar counts down;
 * turning away stops following and offers the way back, which works.
 */
export const readAlongCheck: Check = {
  name: "readalong",
  about: "the mark follows the narrator, pages turn with it, and Go to the narrator brings it back",
  async run(r, t) {
    const { page } = r;
    await closeReader(r);
    await reading(r, "pages");
    await page.evaluate(() => window.__ribbon.moveReading({ section: 10, block: 3, offset: 0 }, "seek"));
    await page.waitForTimeout(800);
    // Listening opens the bar under the text, which makes the page shorter and lays the book out again: start, let it settle.
    await page.evaluate(() => window.__ribbon.listenFromHere());
    await silence(page);
    await page.waitForTimeout(2000);
    // From the last line of the spread showing (not of the pages drawn beside it for a swipe, which are inert),
    // so the narrator runs off it within seconds.
    await page.evaluate(() => {
      const lines = [...document.querySelectorAll<HTMLElement>("[role=dialog] [data-block]")].filter((e) => !e.closest("[inert]"));
      const last = lines[lines.length - 1]!;
      return window.__ribbon.listenFromHere({ section: Number(last.dataset.section), block: Number(last.dataset.block), offset: Number(last.dataset.start) });
    });
    await silence(page);
    await page.waitForTimeout(1500);
    const look = () =>
      page.evaluate((bar) => {
        const s = window.__ribbon.getState().reading!;
        return {
          // The sentence marked, by what it is rather than how it looks.
          mark: document.querySelector("[role=dialog] [data-mark=sentence]")?.textContent?.slice(0, 30) ?? null,
          place: `${s.place?.section}:${s.place?.block}:${s.place?.offset}`,
          following: !!s.following,
          bar: document.querySelector(`${bar} p`)?.textContent ?? "",
          buttons: [...document.querySelectorAll(`${bar} button`)].map((b) => b.textContent?.trim()).filter(Boolean).join(" / "),
        };
      }, BAR);
    const marks = new Set<string>();
    const places = new Set<string>();
    let bar = "";
    for (let i = 0; i < 40; i++) {
      const l = await look();
      if (l.mark) marks.add(l.mark);
      places.add(l.place);
      bar = l.bar;
      await page.waitForTimeout(500);
    }
    const playing = await look();
    t.expect(marks.size >= 2, "the narrator's sentence is marked, and the mark moves on", `${marks.size} sentences in 20 s`);
    t.expect(places.size >= 2, "the page turns with the narrator", `${places.size} places shown`);
    t.expect(playing.following, "it is following the narrator");
    t.expect(/left$/.test(bar), "the bar says where and how long is left", bar);

    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(700);
    const away = await look();
    t.expect(!away.following, "turning away by hand stops following");
    t.expect(away.buttons.includes("Go to the narrator"), "and offers Go to the narrator", away.buttons);

    await page.locator(`${BAR} button`, { hasText: "Go to the narrator" }).click();
    await page.waitForTimeout(1500);
    const back = await look();
    t.expect(back.following && !!back.mark, "Go to the narrator brings following and the mark back", back.buttons);
    await page.evaluate(() => window.__ribbon.pause());
  },
};
