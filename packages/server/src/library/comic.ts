import { writeFile } from "node:fs/promises";
import path from "node:path";
import { openComic } from "@ribbon/host-node/comic";
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
