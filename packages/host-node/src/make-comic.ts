import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import { createZip } from "@culvert/zip";
import { from, toReadableStream } from "@culvert/stream";

/**
 * Comics for the tests and the demo library, made here and never found
 * (docs/COMICS.md, section 11): the repository is public, so no page of
 * anyone's comic goes into it. Each page is a flat colour with its number
 * drawn large, so a test or a person can see which page is on screen.
 */
export interface MadeComic {
  /** How many pages. */
  pages: number;
  /** Pages drawn across two (wider than tall), counted from 0. */
  wide?: number[];
  /** The archive's ComicInfo.xml, as text; none when absent. */
  comicInfo?: string;
  /** A folder inside the archive to put the pages in, as some tools do. */
  folder?: string;
  /** A page's size, in pixels. Small by default, so a test library is made in a moment. */
  width?: number;
  height?: number;
  /** Name the pages without padding ("page-2", "page-10"), to prove the order is natural, not alphabetical. */
  unpadded?: boolean;
  /** Other files to put in the archive, by name: litter a real archive carries. */
  extra?: Record<string, string>;
}

/** A ComicInfo.xml from a few fields. */
export function comicInfoXml(fields: Record<string, string | number>): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = Object.entries(fields).map(([k, v]) => `  <${k}>${escape(String(v))}</${k}>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n${lines.join("\n")}\n</ComicInfo>\n`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Which of a seven-segment digit's bars are lit: top, top-left, top-right, middle, bottom-left, bottom-right, bottom.
const SEGMENTS: Record<string, number[]> = {
  "0": [1, 1, 1, 0, 1, 1, 1],
  "1": [0, 0, 1, 0, 0, 1, 0],
  "2": [1, 0, 1, 1, 1, 0, 1],
  "3": [1, 0, 1, 1, 0, 1, 1],
  "4": [0, 1, 1, 1, 0, 1, 0],
  "5": [1, 1, 0, 1, 0, 1, 1],
  "6": [1, 1, 0, 1, 1, 1, 1],
  "7": [1, 0, 1, 0, 0, 1, 0],
  "8": [1, 1, 1, 1, 1, 1, 1],
  "9": [1, 1, 1, 1, 0, 1, 1],
};

/** A page as a PNG: a colour of its own, its number (counted from 1) in the middle. */
export function pagePng(number: number, width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  // A different, muted colour for each page, so two pages are never mistaken at a glance.
  const hue = (number * 47) % 360;
  const [r, g, b] = [0, 120, 240].map((shift) => Math.round(150 + 60 * Math.cos(((hue + shift) * Math.PI) / 180)));
  for (let i = 0; i < width * height; i++) rgb.set([r!, g!, b!], i * 3);
  const fill = (x0: number, y0: number, w: number, h: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) rgb.set([24, 24, 28], (y * width + x) * 3);
  };
  const digits = String(number);
  const dh = Math.round(height * 0.4);
  const dw = Math.round(dh * 0.5);
  const bar = Math.max(2, Math.round(dh * 0.1));
  const gap = Math.round(dw * 0.3);
  let x = Math.round((width - (digits.length * dw + (digits.length - 1) * gap)) / 2);
  const y = Math.round((height - dh) / 2);
  for (const d of digits) {
    const s = SEGMENTS[d]!;
    if (s[0]) fill(x, y, dw, bar);
    if (s[1]) fill(x, y, bar, dh / 2);
    if (s[2]) fill(x + dw - bar, y, bar, dh / 2);
    if (s[3]) fill(x, y + Math.round(dh / 2 - bar / 2), dw, bar);
    if (s[4]) fill(x, y + dh / 2, bar, dh / 2);
    if (s[5]) fill(x + dw - bar, y + dh / 2, bar, dh / 2);
    if (s[6]) fill(x, y + dh - bar, dw, bar);
    x += dw + gap;
  }
  // Each row starts with its filter byte: 0, none.
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) raw.set(rgb.subarray(row * width * 3, (row + 1) * width * 3), row * (width * 3 + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The name a made comic gives its page `index` (from 0). */
export function madePageName(comic: MadeComic, index: number): string {
  const n = index + 1;
  const name = comic.unpadded ? `page-${n}.png` : `page-${String(n).padStart(3, "0")}.png`;
  return comic.folder ? `${comic.folder}/${name}` : name;
}

/** Write a CBZ at `file`, its pages stored as a comic's are. */
export async function makeComic(file: string, comic: MadeComic): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const width = comic.width ?? 200;
  const height = comic.height ?? 300;
  const wide = new Set(comic.wide ?? []);
  const text = (s: string) => from([new TextEncoder().encode(s)]);
  const zip = createZip(async (archive) => {
    if (comic.comicInfo !== undefined) await archive.addFile({ name: "ComicInfo.xml", source: text(comic.comicInfo) });
    for (const [name, body] of Object.entries(comic.extra ?? {})) await archive.addFile({ name, source: text(body) });
    for (let i = 0; i < comic.pages; i++) {
      await archive.addFile({ name: madePageName(comic, i), source: from([pagePng(i + 1, wide.has(i) ? width * 2 : width, height)]), compression: "store" });
    }
  });
  await toReadableStream(zip).pipeTo(Writable.toWeb(createWriteStream(file)));
}

/** A PDF made for the tests: pages like a made comic's, each a flat colour with its number drawn large. */
export interface MadePdf {
  pages: number;
  /** Pages drawn across two, counted from 0. */
  wide?: number[];
  /** A page's size in points. */
  width?: number;
  height?: number;
}

/**
 * Write a PDF at `file`, by hand: a catalog, its pages, and for each page
 * a few filled rectangles (its ground, and its number in the bars a made
 * comic's pages have). No fonts and no pictures, so any reader draws it.
 */
export async function makePdf(file: string, pdf: MadePdf): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const width = pdf.width ?? 200;
  const height = pdf.height ?? 300;
  const wide = new Set(pdf.wide ?? []);
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageIds = Array.from({ length: pdf.pages }, (_, i) => 3 + i * 2);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pdf.pages} >>`);
  for (let i = 0; i < pdf.pages; i++) {
    const w = wide.has(i) ? width * 2 : width;
    const h = height;
    const hue = ((i + 1) * 47) % 360;
    const [r, g, b] = [0, 120, 240].map((shift) => ((150 + 60 * Math.cos(((hue + shift) * Math.PI) / 180)) / 255).toFixed(3));
    const bars: string[] = [`${r} ${g} ${b} rg 0 0 ${w} ${h} re f`, "0.094 0.094 0.11 rg"];
    const digits = String(i + 1);
    const dh = Math.round(h * 0.4);
    const dw = Math.round(dh * 0.5);
    const bar = Math.max(2, Math.round(dh * 0.1));
    const gap = Math.round(dw * 0.3);
    let x = Math.round((w - (digits.length * dw + (digits.length - 1) * gap)) / 2);
    // A PDF's y runs up the page: the digit's foot is at `y`.
    const y = Math.round((h - dh) / 2);
    const rect = (rx: number, ry: number, rw: number, rh: number) => bars.push(`${rx} ${ry} ${rw} ${rh} re f`);
    for (const d of digits) {
      const s = SEGMENTS[d]!;
      if (s[0]) rect(x, y + dh - bar, dw, bar);
      if (s[1]) rect(x, y + dh / 2, bar, dh / 2);
      if (s[2]) rect(x + dw - bar, y + dh / 2, bar, dh / 2);
      if (s[3]) rect(x, y + Math.round(dh / 2 - bar / 2), dw, bar);
      if (s[4]) rect(x, y, bar, dh / 2);
      if (s[5]) rect(x + dw - bar, y, bar, dh / 2);
      if (s[6]) rect(x, y, dw, bar);
      x += dw + gap;
    }
    const content = bars.join("\n");
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${pageIds[i]! + 1} 0 R /Resources << >> >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  // The file: each object, then the table saying where each begins.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const table = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  await writeFile(file, out, "latin1");
}
