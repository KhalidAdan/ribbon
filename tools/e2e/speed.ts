import type { Stat } from "../../src/app/perf";
import { closeReader, reading, silence, type Ribbon } from "./app";

/** One part of the report: what the app measured of itself while it ran, and what the script saw. */
export interface SpeedPart {
  title: string;
  /** Each measurement (src/app/perf.ts): how many, the median, the 95th percentile and the worst, in ms. */
  stats: Record<string, Stat>;
  /** What the script counted itself, such as frames drawn without text. */
  facts?: Record<string, number | boolean>;
}

export interface SpeedReport {
  slow: number;
  /** The display's refresh rate, as measured. */
  hz: number;
  parts: SpeedPart[];
  /** What was measured, where and when, added when the report is written (run.ts, --json): numbers from another machine or another book do not compare. */
  version?: string;
  commit?: string;
  measured?: string;
  where?: string;
  library?: string;
}

/**
 * How fast Ribbon feels, measured with real input through the webview:
 * opening a book, turning pages by key and click, scrolling, the whole
 * book scrolled through, reading along, and playing with the library
 * showing. Each part prints what the app measured of itself (src/app/perf.ts):
 * React's renders, input to the frame that showed it, long tasks, layout,
 * time between frames, and the report returns it all (`--json` writes it).
 * Not a pass or a fail: compare it with the last release's numbers
 * (speed-compare.ts, docs/RELEASING.md), at 1x and at 6x.
 */
export async function speedReport(r: Ribbon, slow: number): Promise<SpeedReport> {
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
  const report: SpeedReport = { slow, hz, parts: [] };
  const part = async (title: string, facts?: SpeedPart["facts"]) => {
    await page.waitForTimeout(600);
    console.log(`\n## ${title}`);
    const all = await page.evaluate(() => window.__ribbonPerf.summary());
    for (const [k, v] of Object.entries(all).sort()) console.log(`${k.padEnd(56)} n=${String(v.n).padStart(4)}  p50=${String(v.p50).padStart(6)}  p95=${String(v.p95).padStart(6)}  max=${String(v.max).padStart(6)}`);
    report.parts.push({ title, stats: all, ...(facts ? { facts } : {}) });
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
  const perSecond = Math.round(drive.frames / (drive.ms / 1000));
  console.log(`whole book: ${Math.round(drive.px)} px in ${Math.round(drive.ms)} ms, ${drive.frames} frames (${perSecond} a second), ${drive.empty} with no text drawn`);
  await part("Whole book, top to bottom in 10 s", { px: Math.round(drive.px), frames: drive.frames, "frames a second": perSecond, "frames with no text": drive.empty });

  await reading(r, "pages");
  await start();
  await page.evaluate(() => window.__ribbon.listenFromHere());
  await silence(page);
  await page.waitForTimeout(1500);
  await reset();
  const from = await page.evaluate(() => window.__ribbon.getState().player.positionMs);
  await page.waitForTimeout(20_000);
  const played = Math.round(((await page.evaluate(() => window.__ribbon.getState().player.positionMs)) - from) / 1000);
  const following = await page.evaluate(() => !!window.__ribbon.getState().reading?.following);
  console.log(`played ${played} s, following: ${following}`);
  await page.evaluate(() => window.__ribbon.pause());
  await part("Reading along for 20 s (following, the mark moving)", { "seconds played": played, following });

  await page.evaluate(() => window.__ribbon.play());
  await silence(page);
  await closeReader(r);
  await page.waitForTimeout(1000);
  await reset();
  await page.waitForTimeout(10_000);
  await page.evaluate(() => window.__ribbon.pause());
  await part("Playing for 10 s with the library showing");
  await r.slow(1);
  return report;
}
