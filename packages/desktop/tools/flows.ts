/**
 * Flows a unit test cannot see: real clicks and keys in a real browser,
 * checking which dialog is on top. Runs against the browser harness.
 *
 *   npm run dev -- --mode demo     # in one terminal
 *   npm run flows
 *
 * Exits non-zero, saying which step failed, when a flow breaks.
 */
import { chromium, type Page } from "playwright-core";
import { promises as fs } from "node:fs";

const URL = process.env.RIBBON_SHOTS_URL ?? "http://localhost:1420";
const BROWSERS = [process.env.RIBBON_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome"].filter((p): p is string => !!p);

interface View {
  drawer: string | null;
  expanded: boolean;
  /** The dialog under a point in the side panel's column, if any. */
  top: string | null;
}

function view(page: Page): Promise<View> {
  return page.evaluate(() => {
    const c = (window as unknown as { __ribbon: { getState(): { playerDrawer: string | null; playerExpanded: boolean } } }).__ribbon;
    const el = document.elementFromPoint(innerWidth - 200, 200);
    return { drawer: c.getState().playerDrawer, expanded: c.getState().playerExpanded, top: el?.closest("dialog")?.getAttribute("aria-label") ?? null };
  });
}

let failures = 0;
async function expect(page: Page, step: string, want: Partial<View>): Promise<void> {
  await page.waitForTimeout(500);
  const got = await view(page);
  const bad = Object.entries(want).filter(([k, v]) => got[k as keyof View] !== v);
  if (bad.length === 0) console.log(`ok   ${step}`);
  else {
    failures++;
    console.log(`FAIL ${step}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}

async function main(): Promise<void> {
  let executablePath: string | undefined;
  for (const b of BROWSERS) {
    if (await fs.access(b).then(() => true, () => false)) {
      executablePath = b;
      break;
    }
  }
  if (!executablePath) throw new Error("no Edge or Chrome found; set RIBBON_BROWSER");
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  try {
    await page.goto(URL);
    await page.waitForFunction(() => (window as unknown as { __ribbon?: { getState(): { phase: string } } }).__ribbon?.getState().phase === "ready", null, { timeout: 60_000 });
    await page.waitForTimeout(1000);
    await page.evaluate(async () => {
      const c = (window as unknown as { __ribbon: { getState(): { seriesSetup: unknown; books: { book: { id: string } }[] }; closeSeriesSetup(): void; openBook(b: unknown, o: unknown): Promise<void> } }).__ribbon;
      if (c.getState().seriesSetup) c.closeSeriesSetup();
      await c.openBook(c.getState().books[0], { expand: false });
    });
    await page.waitForTimeout(500);

    // The player and its chapters open together from the bar: the chapters must be on top.
    await page.locator('[role=region][aria-label="Now playing"] button[aria-label="Chapters"]').click();
    await expect(page, "Chapters from the player bar opens the chapters on top", { drawer: "chapters", expanded: true, top: "Chapters" });
    // A nested dialog's Escape and close are its own.
    await page.keyboard.press("Escape");
    await expect(page, "Escape closes the chapters and leaves the player open", { drawer: null, expanded: true, top: "Player" });
    const row = page.locator("dialog[open] button", { hasText: /^Chapters/ });
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(page, "The Chapters row in the player opens the chapters", { drawer: "chapters", top: "Chapters" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page, "The panel's close button leaves the player open", { drawer: null, expanded: true });
    await page.keyboard.press("Escape");
    await expect(page, "Escape on the player goes back to the shelf", { expanded: false, top: null });
    // The same from the speed button on the bar.
    await page.locator('[role=region][aria-label="Now playing"] button[aria-label^="Speed"]').click();
    await expect(page, "Speed from the player bar opens on top", { drawer: "speed", top: "Speed" });
  } finally {
    await browser.close();
  }
  if (failures > 0) {
    console.log(`${failures} step(s) failed`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
