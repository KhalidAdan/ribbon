import { inPixels, type Panel } from "@ribbon/core/comic/panels";
import { SEGMENTS } from "./make-comic.ts";

/**
 * A comic's page as a picture small enough to look at, with its panels
 * drawn over it when asked (docs/COMICS.md, section 14): each one outlined
 * and numbered in the order it is read. It is how a page's panels are
 * checked by whoever drew them, a person or an assistant, without a reader
 * to open.
 *
 * Drawn on the canvas pdf.js draws PDFs on in Node (`@napi-rs/canvas`,
 * pdf.ts). The numbers are bars, as a made comic's page numbers are
 * (make-comic.ts): a server's image has no fonts to write them with.
 */
export interface PagePicture {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** The colours panels are outlined in, one after another, so two that touch are told apart. */
const INKS = ["#ff3b30", "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff"];

/**
 * The page in `bytes` (a JPEG, PNG, WebP or GIF), no longer than `longest`
 * pixels on its longer side, with `panels` drawn over it in reading
 * order. Rejects when the page isn't a picture, or this machine has no
 * canvas.
 */
export async function pagePicture(bytes: Uint8Array, opts: { longest: number; panels?: readonly Panel[] }): Promise<PagePicture> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const page = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, opts.longest / Math.max(page.width, page.height));
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(page, 0, 0, width, height);

  const line = Math.max(3, Math.round(Math.max(width, height) / 300));
  for (const [at, panel] of (opts.panels ?? []).entries()) {
    const ink = INKS[at % INKS.length]!;
    const { x, y, width: w, height: h } = inPixels(panel, { width, height });
    ctx.strokeStyle = ink;
    ctx.lineWidth = line;
    ctx.strokeRect(x + line / 2, y + line / 2, Math.max(1, w - line), Math.max(1, h - line));
    // Its number in the order, on a tab at its top left corner.
    const digits = String(at + 1);
    const tall = Math.max(18, Math.round(Math.max(width, height) / 36));
    const wide = Math.round(tall * 0.55);
    const gap = Math.round(wide * 0.35);
    const pad = Math.round(tall * 0.3);
    ctx.fillStyle = ink;
    ctx.fillRect(x, y, digits.length * wide + (digits.length - 1) * gap + pad * 2, tall + pad * 2);
    ctx.fillStyle = "#ffffff";
    for (const [i, digit] of [...digits].entries()) drawDigit(ctx, digit, x + pad + i * (wide + gap), y + pad, wide, tall);
  }
  return { jpeg: canvas.toBuffer("image/jpeg", 80), width, height };
}

/** One digit as the bars of a seven-segment display, in the colour already chosen. */
function drawDigit(ctx: { fillRect(x: number, y: number, w: number, h: number): void }, digit: string, x: number, y: number, wide: number, tall: number): void {
  const lit = SEGMENTS[digit];
  if (!lit) return;
  const bar = Math.max(2, Math.round(tall * 0.14));
  const half = tall / 2;
  if (lit[0]) ctx.fillRect(x, y, wide, bar);
  if (lit[1]) ctx.fillRect(x, y, bar, half);
  if (lit[2]) ctx.fillRect(x + wide - bar, y, bar, half);
  if (lit[3]) ctx.fillRect(x, y + half - bar / 2, wide, bar);
  if (lit[4]) ctx.fillRect(x, y + half, bar, half);
  if (lit[5]) ctx.fillRect(x + wide - bar, y + half, bar, half);
  if (lit[6]) ctx.fillRect(x, y + tall - bar, wide, bar);
}
