import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openComic } from "@ribbon/host-node/comic";
import { cbrToCbz, isRar, openCbr } from "@ribbon/host-node/cbr";
import { cbrRefusal } from "@ribbon/core/comic/cbr";
import { openPdf } from "@ribbon/host-node/pdf";
import { pdfPageName } from "@ribbon/core/comic/session";
import { archiveProblem, pageOrder } from "@ribbon/core/comic/pages";
import { imageSize } from "@ribbon/core/comic/size";

/**
 * A comic on the server (docs/COMICS.md, section 7): its CBZ copied in as
 * `book.cbz`, never changed, and read where it sits with Culvert. Its
 * pages are listed once, when it is added, and kept in its `book.json`;
 * after that a page is one entry read straight out of the archive.
 */
export interface ComicPage {
  /** The page's entry in the archive. */
  name: string;
  /** Its picture's size in pixels, read from its first bytes; 0 by 0 when they don't say. */
  width: number;
  height: number;
}

/** How much of a page is read to learn its size: a JPEG's says after its thumbnail and colour profile. */
const HEADER_BYTES = 256 * 1024;

/** The first bytes of one entry, read no further than needed. */
async function startOf(source: AsyncIterable<Uint8Array>, most: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let have = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    have += chunk.length;
    if (have >= most) break;
  }
  const out = new Uint8Array(have);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * A comic's pages in reading order, each with its size. Throws, in a
 * sentence, for a file that isn't an archive or isn't what a comic is.
 */
export async function listPages(file: string): Promise<ComicPage[]> {
  const comic = await openComic(file).catch(() => {
    throw new Error("it isn't a comic Ribbon can open: a CBZ is a zip of pictures, and this isn't one.");
  });
  try {
    const problem = archiveProblem(comic.entries);
    if (problem) throw new Error(`it isn't what a comic is. ${problem}`);
    const pages: ComicPage[] = [];
    for (const name of pageOrder(comic.entries.map((e) => e.name))) {
      const size = imageSize(await startOf(comic.source(name), HEADER_BYTES));
      pages.push({ name, width: size?.width ?? 0, height: size?.height ?? 0 });
    }
    return pages;
  } finally {
    await comic.close();
  }
}

/** Write one page of a comic to a file of its own, whole: what its cover is made from. */
export async function pageToFile(file: string, page: string, target: string): Promise<void> {
  const comic = await openComic(file);
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of comic.source(page)) chunks.push(chunk);
    await writeFile(target, Buffer.concat(chunks));
  } finally {
    await comic.close();
  }
}

/** Where a book's comic is kept in its folder. */
export const COMIC_FILE = "book.cbz";

export function comicPath(bookDir: string): string {
  return path.join(bookDir, COMIC_FILE);
}

// CBRs ---------------------------------------------------------------------

/**
 * A CBR on the server (docs/COMICS.md, section 13): written out as a CBZ
 * when it is added, and kept as that `book.cbz`. The server reads every
 * byte of a book to copy it in anyway, so the cost is nothing more; and
 * from there on a comic that came as a CBR is a comic like any other, to
 * the page requests, to the desktop that downloads it and to the Apple
 * apps, none of which needs a RAR reader.
 */

/** True when a comic's file is a RAR archive, whatever it is called. */
export const isCbr = isRar;

/**
 * Look a CBR over before anything is written: it opens, it is what a
 * comic is, and it has pages. Throws, in a sentence, when it isn't.
 * Returns how many bytes it unpacks to, which is the room its CBZ needs.
 */
export async function checkCbr(file: string): Promise<number> {
  const cbr = await openCbr(file).catch((e) => {
    const refused = cbrRefusal(e);
    throw new Error(refused ? `it can't be added. ${refused}` : `it isn't a comic Ribbon can open: ${e instanceof Error ? e.message : String(e)}`);
  });
  const problem = archiveProblem(cbr.entries);
  if (problem) throw new Error(`it isn't what a comic is. ${problem}`);
  if (pageOrder(cbr.entries.map((e) => e.name)).length === 0) throw new Error("it has no pages in it.");
  return cbr.entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
}

/** Write a CBR out as the book's CBZ, and list its pages from that. */
export async function cbrIntoBook(file: string, bookDir: string): Promise<ComicPage[]> {
  await mkdir(bookDir, { recursive: true });
  await cbrToCbz(file, comicPath(bookDir));
  return listPages(comicPath(bookDir));
}

// PDFs ---------------------------------------------------------------------

/**
 * A PDF on the server (docs/COMICS.md, section 12): kept as `book.pdf`,
 * never changed. Its pages aren't files to hand out, as a comic's are:
 * each has to be drawn. The thin apps draw and play what the server
 * prepares (docs/NORTHSTAR.md), so the server draws a PDF's pages, each
 * once, the first time one is asked for, and keeps the picture beside the
 * book. A device that keeps books downloads the PDF itself and draws it.
 */
export const PDF_FILE = "book.pdf";

/** The widths a PDF's page is drawn at: enough for a tablet, and for a large screen at twice its size. */
export const PDF_PAGE_WIDTHS = [1200, 2400] as const;

/** A PDF's pages, by the name PDFs give one ("page=14"), each with its size in points. Throws, in a sentence, for a file that can't be opened. */
export async function listPdfPages(file: string): Promise<ComicPage[]> {
  const pdf = await openPdf(file).catch(() => {
    throw new Error("it couldn't be opened as a PDF: it isn't one, or it is locked with a password.");
  });
  try {
    const pages: ComicPage[] = [];
    for (let page = 0; page < pdf.pages; page++) pages.push({ name: pdfPageName(page), ...(await pdf.size(page)) });
    return pages;
  } finally {
    await pdf.close();
  }
}

/** Draw one page of a PDF (counted from 0) to a JPEG file, `width` pixels wide. */
export async function pdfPageToFile(file: string, page: number, width: number, target: string): Promise<void> {
  const pdf = await openPdf(file);
  try {
    await writeFile(target, await pdf.jpeg(page, width));
  } finally {
    await pdf.close();
  }
}

/** Pictures being made now, by where they will be kept: two devices asking for one page make it once. */
const making = new Map<string, Promise<void>>();

/**
 * A picture kept in a book's folder: read from there if it has been made,
 * else made by `make`, kept, and read. A book's pages never change, so a
 * picture made from one never needs making again.
 */
async function keptPicture(kept: string, make: (target: string) => Promise<void>): Promise<Uint8Array> {
  const have = await readFile(kept).catch(() => null);
  if (have) return have;
  let going = making.get(kept);
  if (!going) {
    going = (async () => {
      await mkdir(path.dirname(kept), { recursive: true });
      // Made beside its place and moved in whole, so a picture is never read half made.
      const target = `${kept}.${process.pid}.tmp`;
      try {
        await make(target);
        await rename(target, kept);
      } finally {
        await rm(target, { force: true });
      }
    })().finally(() => making.delete(kept));
    making.set(kept, going);
  }
  await going;
  return readFile(kept);
}

/**
 * One page of a book's PDF as a JPEG `width` pixels wide: drawn the first
 * time it is asked for and kept in the book's folder (`pages/`), read from
 * there every time after.
 */
export async function pdfPage(bookDir: string, page: number, width: number): Promise<Uint8Array> {
  return keptPicture(path.join(bookDir, "pages", `${page + 1}-${width}.jpg`), (target) => pdfPageToFile(path.join(bookDir, PDF_FILE), page, width, target));
}

/** How wide a PDF's page is drawn to be looked at, or to have its panels drawn over it: the smaller of the two it is kept at. */
const PDF_LOOK_WIDTH = PDF_PAGE_WIDTHS[0];

/**
 * One page of a book of pages, whole, as a picture's bytes: a comic's out
 * of its archive, a PDF's drawn (and kept, as any page of it asked for
 * is). `index` counts from 0.
 */
export async function pageBytes(bookDir: string, file: string, pages: readonly ComicPage[], index: number): Promise<Uint8Array> {
  if (file === PDF_FILE) return pdfPage(bookDir, index, PDF_LOOK_WIDTH);
  const comic = await openComic(path.join(bookDir, COMIC_FILE));
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of comic.source(pages[index]!.name)) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    await comic.close();
  }
}

// Small pictures of every page ---------------------------------------------

/**
 * Every page of a book of pages has a small picture (docs/COMICS.md,
 * section 15): the strip of pages along a reader's foot is made of them.
 * 300 pixels tall, whatever the page's shape, as a JPEG: a strip shows one
 * about 100 points tall, so it stays sharp on a Retina screen.
 */
export const SMALL_PAGE_HEIGHT = 300;

/**
 * A page's small picture, `index` counted from 0: made the first time it is
 * asked for and kept beside the book (`pages/`), as a PDF's drawn pages
 * are. A comic's page is shrunk from the picture in its archive; a PDF's is
 * drawn small by pdf.js, not shrunk from a large drawing. Rejects when this
 * machine has no canvas to make one on (`@napi-rs/canvas`), or the page
 * isn't a picture.
 */
export async function smallPage(bookDir: string, file: string, pages: readonly ComicPage[], index: number): Promise<Uint8Array> {
  return keptPicture(path.join(bookDir, "pages", `${index + 1}-small.jpg`), async (target) => {
    if (file === PDF_FILE) {
      const { width, height } = pages[index]!;
      // As wide as a page of its shape is when it is drawn that tall; a page that doesn't say is taken to be a printed page's shape.
      const wide = height > 0 ? Math.max(1, Math.round((SMALL_PAGE_HEIGHT * width) / height)) : Math.round(SMALL_PAGE_HEIGHT / 1.5);
      return pdfPageToFile(path.join(bookDir, PDF_FILE), index, wide, target);
    }
    await writeFile(target, await shrink(await pageBytes(bookDir, file, pages, index), SMALL_PAGE_HEIGHT));
  });
}

/** Whether this machine has the canvas pictures are made on: a server without it still sends pages, but makes no small ones. */
export async function canDraw(): Promise<boolean> {
  return import("@napi-rs/canvas").then(
    () => true,
    () => false,
  );
}

/** A picture (a JPEG, PNG, WebP or GIF) as a JPEG no taller than `tall`, and never larger than it was. */
async function shrink(bytes: Uint8Array, tall: number): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const page = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, tall / page.height);
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // A page with see-through parts sits on paper, not on the black a JPEG would make of them.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  // Shrinking a scan ten times over: the careful filter keeps its lines from breaking into steps.
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(page, 0, 0, width, height);
  return canvas.toBuffer("image/jpeg", 80);
}
