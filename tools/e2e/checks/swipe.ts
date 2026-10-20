import type { Check } from "../run";
import { placeNow, reading, type Ribbon } from "../app";

const TRACK = "[role=dialog] .will-change-transform";

/** Drag a pen across the page from one fraction of its width to another, in `moves` steps `gap` ms apart. */
async function drag(r: Ribbon, from: number, to: number, moves: number, gap: number): Promise<{ midway: string; after: string; framesP95: number }> {
  const { page, cdp } = r;
  const box = await page.evaluate((sel) => {
    const b = document.querySelector(sel)!.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, TRACK);
  const y = box.y + box.h / 2;
  const x = (f: number) => box.x + box.w * f;
  const pen = (type: "mousePressed" | "mouseMoved" | "mouseReleased", at: number) => cdp.send("Input.dispatchMouseEvent", { type, x: at, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen" });
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __watching: boolean };
    w.__frames = [];
    w.__watching = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (w.__watching) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await pen("mousePressed", x(from));
  let midway = "";
  for (let i = 1; i <= moves; i++) {
    await pen("mouseMoved", x(from + ((to - from) * i) / moves));
    if (gap) await page.waitForTimeout(gap);
    if (i === Math.ceil(moves / 2)) midway = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).style.transform, TRACK);
  }
  await pen("mouseReleased", x(to));
  await page.waitForTimeout(700);
  const framesP95 = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __watching: boolean };
    w.__watching = false;
    const f = w.__frames.slice(1).sort((a, b) => a - b);
    return f[Math.floor(f.length * 0.95)] ?? 0;
  });
  const after = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).style.transform, TRACK);
  return { midway, after, framesP95 };
}

/** Swiping pages as in Apple Books, a trackpad's swipe, and a mouse turning on the press. */
export const swipeCheck: Check = {
  name: "swipe",
  about: "pages follow a swipe and turn or spring back; a trackpad swipes; a mouse turns on the press",
  async run(r, t) {
    const { page } = r;
    await reading(r, "pages");
    await page.evaluate(() => window.__ribbon.moveReading({ section: 10, block: 0, offset: 0 }, "seek"));
    await page.waitForTimeout(1200);

    let at = await placeNow(page);
    let d = await drag(r, 0.8, 0.2, 12, 16);
    let now = await placeNow(page);
    t.expect(d.midway.includes("translate3d(-"), "the page follows the finger", d.midway);
    t.expect(now !== at, "a long drag left turns to the next page");
    t.expect(d.after === "", "the track is back in the middle after the turn", d.after || "(none)");
    t.note(`frames while dragging: p95 ${d.framesP95.toFixed(1)} ms`);

    at = now;
    await drag(r, 0.6, 0.5, 6, 90);
    now = await placeNow(page);
    t.expect(now === at, "a short, slow drag springs back");

    d = await drag(r, 0.6, 0.45, 3, 0);
    now = await placeNow(page);
    t.expect(now !== at, "a quick flick turns however short it was");

    at = now;
    await drag(r, 0.2, 0.8, 12, 16);
    now = await placeNow(page);
    t.expect(now !== at, "a long drag right turns back");

    at = now;
    const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.move(box.w / 2, box.h / 2);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(40, 0);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(800);
    now = await placeNow(page);
    t.expect(now !== at, "a trackpad's sideways swipe turns");

    at = now;
    await page.mouse.move(box.w * 0.95, box.h / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    const onPress = await placeNow(page);
    await page.mouse.up();
    await page.waitForTimeout(300);
    now = await placeNow(page);
    t.expect(onPress !== at, "a mouse on the page's edge turns on the press");
    t.expect(now === onPress, "and its click does not turn again");
  },
};
