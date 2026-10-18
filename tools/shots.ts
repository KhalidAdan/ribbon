/**
 * Eyes for the interface. Opens the browser harness in Edge (or Chrome)
 * through playwright-core, puts the app into each scene through the dev
 * controller (`window.__ribbon`), and saves a screenshot per scene, theme
 * and width under `shots/`.
 *
 *   npm run dev -- --mode demo        # in one terminal
 *   npm run shots                      # every scene, light and dark, desktop and narrow
 *   npm run shots -- player reader     # only scenes whose name contains one of these
 *   npm run shots -- --dark --wide     # one theme, one width
 *   npm run shots -- --sheet           # also tile each theme and width into shots/sheet-*.png
 *
 * RIBBON_SHOTS_URL changes the address; RIBBON_BROWSER the browser binary.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright-core";

const URL = process.env.RIBBON_SHOTS_URL ?? "http://localhost:1420";
const OUT = path.resolve("shots");

const BROWSERS = [
  process.env.RIBBON_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter((p): p is string => !!p);

/** A scene runs in the page with `c` bound to the controller; it may return a promise. */
interface Scene {
  name: string;
  setup: string;
}

const PICK_SERIES_BOOK = `c.getState().books.find((b) => b.book.series && b.book.seriesIndex === 1) ?? c.getState().books[0]`;
const PICK_LOOSE_BOOK = `c.getState().books.find((b) => !b.book.series && c.getState().positions[b.book.id]) ?? c.getState().books[c.getState().books.length - 1]`;

const SCENES: Scene[] = [
  { name: "library", setup: `` },
  { name: "library-playing", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: false })` },
  { name: "reader-series", setup: `const b = ${PICK_SERIES_BOOK}; await c.openBook(b, { expand: false }); c.openReader(b.book.id)` },
  { name: "reader-book", setup: `c.openReader((${PICK_LOOSE_BOOK}).book.id)` },
  { name: "player", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: true })` },
  { name: "player-chapters", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: true }); c.setPlayerDrawer("chapters")` },
  { name: "player-bookmarks", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: true }); await c.addBookmark("The Warmaster's first doubt"); c.setPlayerDrawer("bookmarks")` },
  { name: "player-speed", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: true }); c.setPlayerDrawer("speed")` },
  { name: "settings", setup: `c.showSettings()` },
  { name: "series-new", setup: `c.openNewSeries()` },
  { name: "series-setup", setup: `const g = c.detectedSeries()[0]; if (g) c.openSeriesSetup(g.key)` },
  { name: "edit-book", setup: `const b = ${PICK_SERIES_BOOK}; c.openReader(b.book.id); c.openEditBook(b.book.id)` },
  { name: "library-filtered", setup: `c.setView({ filter: { standing: ["started"], author: ["Dan Abnett"] }, sort: "listened", reverse: false })` },
  { name: "filter-panel", setup: `c.setView({ filter: { standing: ["started"] }, sort: "shelf", reverse: false }); await new Promise((r) => setTimeout(r, 100)); [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Filter")).click()` },
  // States that are hard to reach on purpose, set straight on the controller.
  { name: "first-run", setup: `c.set({ phase: "pick" })` },
  { name: "loading", setup: `c.set({ phase: "loading", scanning: { walked: 1586, done: 412, background: false } })` },
  { name: "error", setup: `c.set({ error: "Could not open \\server\media: the network name cannot be found." })` },
  { name: "reconnecting", setup: `await c.openBook(${PICK_SERIES_BOOK}, { expand: false }); c.set({ player: { ...c.getState().player, reconnecting: true }, placeKept: { local: true, pendingShare: 1, shareFailing: true } }); c.expandPlayer()` },
];

interface Options {
  sheet: boolean;
  filters: string[];
  themes: ("light" | "dark")[];
  widths: { name: string; width: number; height: number }[];
}

function parseArgs(argv: string[]): Options {
  const filters = argv.filter((a) => !a.startsWith("--"));
  const themes: Options["themes"] = argv.includes("--dark") ? ["dark"] : argv.includes("--light") ? ["light"] : ["light", "dark"];
  const all = [
    { name: "wide", width: 1440, height: 900 },
    { name: "narrow", width: 390, height: 844 },
  ];
  const widths = argv.includes("--wide") ? all.slice(0, 1) : argv.includes("--narrow") ? all.slice(1) : all;
  return { sheet: argv.includes("--sheet"), filters, themes, widths };
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const c = (window as unknown as { __ribbon?: { getState(): { phase: string; scanning: unknown } } }).__ribbon;
    return !!c && c.getState().phase === "ready";
  }, null, { timeout: 60_000 });
  // Let covers decode and the first scan settle.
  await page.waitForTimeout(1200);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let executablePath: string | undefined;
  for (const b of BROWSERS) {
    try {
      await fs.access(b);
      executablePath = b;
      break;
    } catch {
      /* next */
    }
  }
  if (!executablePath) throw new Error("no Edge or Chrome found; set RIBBON_BROWSER");
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  const scenes = SCENES.filter((s) => opts.filters.length === 0 || opts.filters.some((f) => s.name.includes(f)));
  const made: string[] = [];
  try {
    for (const theme of opts.themes) {
      for (const w of opts.widths) {
        const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, colorScheme: theme, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on("pageerror", (e) => console.error(`[${theme} ${w.name}] page error:`, e.message));
        for (const scene of scenes) {
          await page.goto(URL, { waitUntil: "load" });
          await ready(page);
          // The series offer opens by itself after a scan; only its own scene wants it.
          await page.evaluate(`(async () => { const c = window.__ribbon; if (c.getState().seriesSetup) c.closeSeriesSetup(); ${scene.setup}; })()`);
          await page.waitForTimeout(500);
          const file = path.join(OUT, `${scene.name}-${theme}-${w.name}.png`);
          await page.screenshot({ path: file });
          made.push(path.relative(process.cwd(), file));
        }
        await context.close();
        if (opts.sheet) made.push(await sheet(browser, scenes.map((sc) => path.join(OUT, `${sc.name}-${theme}-${w.name}.png`)), path.join(OUT, `sheet-${theme}-${w.name}.png`), w.width));
      }
    }
  } finally {
    await browser.close();
  }
  console.log(made.join("\n"));
}

/** Tile screenshots into one image, each labelled, so a whole run can be looked at at once. */
async function sheet(browser: import("playwright-core").Browser, files: string[], out: string, width: number): Promise<string> {
  const cols = width < 600 ? 4 : 2;
  const cell = width < 600 ? 300 : 700;
  const tiles = await Promise.all(
    files.map(async (f) => `<figure><img src="data:image/png;base64,${(await fs.readFile(f)).toString("base64")}"><figcaption>${path.basename(f, ".png")}</figcaption></figure>`),
  );
  const page = await browser.newPage({ viewport: { width: cols * (cell + 16) + 16, height: 600 } });
  await page.setContent(`<style>body{margin:0;padding:8px;background:#777;display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:16px;font:12px system-ui;color:#fff}figure{margin:0}img{width:100%;display:block}figcaption{padding:4px 0}</style>${tiles.join("")}`);
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return path.relative(process.cwd(), out);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
