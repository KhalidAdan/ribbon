/**
 * The built app, driven the way a reader drives it: real keys, clicks,
 * wheel and pen input sent through the webview, with the app's own state
 * read alongside to say what happened.
 *
 * Ribbon's webview on Windows is WebView2, which is Chromium: started with
 * a debugging port, playwright-core connects to it over CDP as it would to
 * any browser tab. Each run gets a fresh Ribbon folder and a fresh webview
 * profile (under `.e2e/run`), and opens the test library given to it, so
 * no run depends on the one before. macOS's WKWebView has no such port;
 * see docs/MAC.md.
 */
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import type { AppController } from "../../src/app/controller";

/** What the measurement build (RIBBON_PROFILE=1) puts on the page for the suite. */
declare global {
  interface Window {
    /** The app's controller (src/ui/App.tsx). */
    __ribbon: AppController;
    /** Speed measurements (src/app/perf.ts). */
    __ribbonPerf: { summary(): Record<string, { n: number; p50: number; p95: number; max: number }>; reset(): void };
    /** Where the suite sends the audio instead of the speakers. */
    __sink?: MediaStreamAudioDestinationNode;
  }
}

export interface Ribbon {
  page: Page;
  cdp: CDPSession;
  /** The test book: the first in the library. */
  bookId: string;
  /** Run the CPU this many times slower (1: as it is), as a slow laptop or a phone would. */
  slow(rate: number): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** The built app: target/release/ribbon.exe by default. */
  exe: string;
  /** A library folder with one book that has its audio, its EPUB and its transcript. Ribbon writes `.ribbon/` in it. */
  library: string;
  /** Where each run keeps its Ribbon folder and webview profile. */
  work: string;
  port: number;
  /** Connect to an app already running with the debugging port, rather than starting one. */
  attach: boolean;
}

export async function launch(o: LaunchOptions): Promise<Ribbon> {
  let child: ChildProcess | null = null;
  if (!o.attach) {
    if (process.platform !== "win32") throw new Error("The suite drives WebView2 over CDP, which only Windows has; see docs/MAC.md.");
    if (!existsSync(o.exe)) throw new Error(`No built app at ${o.exe}: run with --build, or build it with RIBBON_PROFILE=1 (tools/e2e/README.md).`);
    if (!existsSync(o.library)) throw new Error(`No test library at ${o.library}: see tools/e2e/README.md.`);
    await fs.rm(o.work, { recursive: true, force: true });
    await fs.mkdir(o.work, { recursive: true });
    child = spawn(o.exe, [], {
      env: {
        ...process.env,
        RIBBON_HOME: path.join(o.work, "home"),
        RIBBON_LIBRARY: o.library,
        WEBVIEW2_USER_DATA_FOLDER: path.join(o.work, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${o.port}`,
      },
      stdio: "ignore",
    });
  }
  const browser = await connect(o.port);
  const page = await firstPage(browser);
  const cdp = await page.context().newCDPSession(page);
  // tsx (esbuild, keeping names) wraps named functions in a __name() helper that only exists in Node; the
  // functions this suite sends into the page carry it along, so the page gets a stand-in, now and after any
  // reload. Sent as a string, which esbuild leaves alone.
  const shim = "window.__name = (f) => f";
  await page.addInitScript(shim);
  // The webview may still be loading the app when it is first reached: wait, through any reload, for its controller.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await page.evaluate(shim);
      if (await page.evaluate("!!window.__ribbon && !!window.__ribbonPerf")) break;
    } catch {
      // The page was replaced while it loaded: look again.
    }
    if (Date.now() > deadline) throw new Error("The app has no window.__ribbon: build it with RIBBON_PROFILE=1 (the measurement build).");
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.waitForFunction(() => window.__ribbon.getState().phase === "ready" && window.__ribbon.getState().books.length > 0 && !window.__ribbon.getState().scanning, null, { timeout: 120_000 });
  const bookId = await page.evaluate(() => window.__ribbon.getState().books[0]!.book.id);
  return {
    page,
    cdp,
    bookId,
    slow: async (rate) => void (await cdp.send("Emulation.setCPUThrottlingRate", { rate })),
    close: async () => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await browser.close().catch(() => undefined);
      child?.kill();
    },
  };
}

async function connect(port: number): Promise<Browser> {
  // A freshly built app's first start on CI's Windows runners has twice taken longer than half a minute (2026-10-25).
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Could not reach the app's webview on port ${port}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function firstPage(browser: Browser): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The app's webview has no page.");
}

/** The audio goes to a stream nobody hears rather than the speakers: the suite plays books in silence. */
export async function silence(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e = (window.__ribbon as unknown as { engine?: { ctx?: AudioContext; gainNode?: GainNode } }).engine;
    if (!e?.ctx || !e.gainNode || window.__sink) return;
    try {
      e.gainNode.disconnect(e.ctx.destination);
    } catch {
      // Not connected yet.
    }
    window.__sink = e.ctx.createMediaStreamDestination();
    e.gainNode.connect(window.__sink);
  });
}

/** The reader open on the test book, ready to read, in this layout. */
export async function reading(r: Ribbon, layout: "pages" | "scroll" = "pages"): Promise<void> {
  await r.page.evaluate((layout) => window.__ribbon.setReadingSettings({ layout }), layout);
  if (!(await r.page.evaluate((id) => window.__ribbon.getState().reading?.bookId === id && window.__ribbon.getState().reading?.status === "ready", r.bookId))) {
    await r.page.evaluate((id) => window.__ribbon.openReading(id), r.bookId);
    await r.page.waitForFunction(() => window.__ribbon.getState().reading?.status === "ready", null, { timeout: 60_000 });
  }
  await r.page.waitForFunction(() => document.querySelector("[role=dialog] [data-block]") !== null, null, { timeout: 30_000 });
  await r.page.waitForTimeout(300);
}

export async function closeReader(r: Ribbon): Promise<void> {
  if (await r.page.evaluate(() => !!window.__ribbon.getState().reading)) await r.page.evaluate(() => window.__ribbon.closeReading());
  await r.page.waitForTimeout(500);
}

/** Lines of the book on screen now: inside the window, not merely in the page. */
export function visibleLines(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("[role=dialog] [data-block]")].filter((e) => {
        const b = e.getBoundingClientRect();
        return b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
      }).length,
  );
}

/** Where the reader is, as a short string to compare. */
export function placeNow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = window.__ribbon.getState().reading?.place;
    return p ? `${p.section}:${p.block}:${p.offset}` : "(no place)";
  });
}
