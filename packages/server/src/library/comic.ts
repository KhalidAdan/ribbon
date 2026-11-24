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

/** Pages being drawn now, by where their picture will be kept: two devices asking for one page draw it once. */
const drawing = new Map<string, Promise<void>>();

/**
 * One page of a book's PDF as a JPEG `width` pixels wide: drawn the first
 * time it is asked for and kept in the book's folder (`pages/`), read from
 * there every time after.
 */
export async function pdfPage(bookDir: string, page: number, width: number): Promise<Uint8Array> {
  const kept = path.join(bookDir, "pages", `${page + 1}-${width}.jpg`);
  const have = await readFile(kept).catch(() => null);
  if (have) return have;
  let going = drawing.get(kept);
  if (!going) {
    going = (async () => {
      await mkdir(path.dirname(kept), { recursive: true });
      // Drawn beside its place and moved in whole, so a picture is never read half made.
      const making = `${kept}.${process.pid}.tmp`;
      try {
        await pdfPageToFile(path.join(bookDir, PDF_FILE), page, width, making);
        await rename(making, kept);
      } finally {
        await rm(making, { force: true });
      }
    })().finally(() => drawing.delete(kept));
    drawing.set(kept, going);
  }
  await going;
  return readFile(kept);
}
