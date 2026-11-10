// Saves a comparison page as a picture: node tools/shelf-proof/snap.mjs <address> <file.png> [width]
import { chromium } from "playwright-core";

const [address = "http://localhost:1420/tools/shelf-proof/index.html", file = "shelf-proof.png", width = "1180"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(width), height: 520 }, deviceScaleFactor: 2 });
await page.goto(address);
await page.waitForFunction(() => document.title === "ready" || document.title === "failed", null, { timeout: 60_000 });
await page.waitForFunction(() => [...document.images].every((i) => i.complete));
console.log(await page.evaluate(() => document.title + " " + (window.proofError ?? "")));
await page.screenshot({ path: file, fullPage: true });
await browser.close();
