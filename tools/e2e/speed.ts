import { closeReader, reading, silence, type Ribbon } from "./app";

/**
 * How fast Ribbon feels, measured with real input through the webview:
 * opening a book, turning pages by key and click, scrolling, the whole
 * book scrolled through, reading along, and playing with the library
 * showing. Each part prints what the app measured of itself (src/app/perf.ts):
 * React's renders, input to the frame that showed it, long tasks, layout,
 * time between frames. Not a pass or a fail: compare it with the last
 * release's numbers (docs/RELEASING.md), at 1x and at 6x.
 */
export async function speedReport(r: Ribbon, slow: number): Promise<void> {
  const { page } = r;
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const hz = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        const gaps: number[] = [];
        let last = 0;
        const step = (now: number) => {
          if (last) gaps.push(now - last);
          last = now;
          if (gaps.length < 120) requestAnimationFrame(step);
          else done(Math.round(1000 / gaps.sort((a, b) => a - b)[60]!));
        };
        requestAnimationFrame(step);
      }),
  );
  await r.slow(slow);
  console.log(`CPU ${slow === 1 ? "as it is" : `${slow}x slower`}; display ${hz} Hz, a frame every ${(1000 / hz).toFixed(1)} ms`);
  const reset = () => page.evaluate(() => window.__ribbonPerf.reset());
  const part = async (title: string) => {
    await page.waitForTimeout(600);
    console.log(`\n## ${title}`);
    const all = await page.evaluate(() => window.__ribbonPerf.summary());
    for (const [k, v] of Object.entries(all).sort()) console.log(`${k.padEnd(56)} n=${String(v.n).padStart(4)}  p50=${String(v.p50).padStart(6)}  p95=${String(v.p95).padStart(6)}  max=${String(v.max).padStart(6)}`);
    await reset();
  };
  const start = async () => {
    await page.evaluate(() => window.__ribbon.moveReading({ section: 10, block: 0, offset: 0 }, "seek"));
    await page.waitForTimeout(800);
    await reset();
  };

  await closeReader(r);
  await reset();
  await page.evaluate(() => window.__ribbon.setReadingSettings({ layout: "pages" }));
  await page.evaluate((id) => window.__ribbon.openReading(id), r.bookId);
  await page.waitForTimeout(3000);
  await closeReader(r);
  await page.evaluate((id) => window.__ribbon.openReading(id), r.bookId);
  await page.waitForTimeout(2000);
  await part("Opening the reader (first, then again)");

  await start();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
  }
  await part("Page turns by key (ArrowRight), 60");

  await start();
  for (let i = 0; i < 60; i++) {
    await page.mouse.click(vp.w - 30, vp.h / 2);
    await page.waitForTimeout(250);
  }
  await part("Page turns by click (right edge), 60");

  await start();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(40);
  }
  await part("Fast page turns by key, 40 at 40 ms");

  await reading(r, "scroll");
  await page.waitForTimeout(1500);
  await reset();
  await page.mouse.move(vp.w / 2, vp.h / 2);
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(30);
  }
  await part("Scrolling, 80 wheel steps");

  await page.waitForTimeout(3000);
  await reset();
  const drive = await page.evaluate(
    () =>
      new Promise<{ px: number; frames: number; empty: number; ms: number }>((done) => {
        const el = document.querySelector("[role=dialog] .quiet-scroll.overflow-y-auto") as HTMLElement;
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
  );
  console.log(`whole book: ${Math.round(drive.px)} px in ${Math.round(drive.ms)} ms, ${drive.frames} frames (${Math.round(drive.frames / (drive.ms / 1000))} a second), ${drive.empty} with no text drawn`);
  await part("Whole book, top to bottom in 10 s");

  await reading(r, "pages");
  await start();
  await page.evaluate(() => window.__ribbon.listenFromHere());
  await silence(page);
  await page.waitForTimeout(1500);
  await reset();
  const from = await page.evaluate(() => window.__ribbon.getState().player.positionMs);
  await page.waitForTimeout(20_000);
  const played = Math.round(((await page.evaluate(() => window.__ribbon.getState().player.positionMs)) - from) / 1000);
  console.log(`played ${played} s, following: ${await page.evaluate(() => !!window.__ribbon.getState().reading?.following)}`);
  await page.evaluate(() => window.__ribbon.pause());
  await part("Reading along for 20 s (following, the mark moving)");

  await page.evaluate(() => window.__ribbon.play());
  await silence(page);
  await closeReader(r);
  await page.waitForTimeout(1000);
  await reset();
  await page.waitForTimeout(10_000);
  await page.evaluate(() => window.__ribbon.pause());
  await part("Playing for 10 s with the library showing");
  await r.slow(1);
}
