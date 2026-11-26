import type { Host } from "@ribbon/core/host";
import { archiveProblem, isPdfFile, pageOrder } from "@ribbon/core/comic/pages";
import { pdfPageNames } from "@ribbon/core/comic/session";
import { cbrRefusal } from "@ribbon/core/comic/cbr";
import { namedComic } from "@ribbon/core/comic-name";
import { movedComicEdits } from "@ribbon/core/comic-edits";
import { applyEdits, type EditValues } from "@ribbon/core/edits";
import { withMatch, type ComicVineLayer } from "@ribbon/core/comicvine";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import type { ServerBookDetail } from "@ribbon/core/server-books";
import type { Book } from "@ribbon/core/types";

/**
 * A comic's pages, for the reader: its archive's list, read once, in
 * reading order (docs/COMICS.md, section 5). No page is opened here.
 */
export async function comicPages(host: Host, absPath: string): Promise<{ ok: true; pages: string[]; document?: string } | { ok: false; message: string }> {
  if (isPdfFile(absPath)) {
    // A PDF's pages are pages of the one file: how many is all there is to ask.
    if (!host.pdfPages) return { ok: false, message: "PDFs can't be opened here." };
    try {
      return { ok: true, pages: pdfPageNames(await host.pdfPages(absPath)), document: absPath.split(/[\\/]/).pop()! };
    } catch {
      return { ok: false, message: "The file couldn't be opened as a PDF: it isn't one, or it is locked with a password." };
    }
  }
  if (!host.comicEntries) return { ok: false, message: "Comics can't be opened here." };
  let entries;
  try {
    entries = await host.comicEntries(absPath);
  } catch (e) {
    // A CBR that is locked or split says so; anything else is no archive at all.
    const refused = cbrRefusal(e);
    return { ok: false, message: refused ? `This comic can't be opened. ${refused}` : "The file isn't a comic Ribbon can open: a CBZ is a zip of pictures, a CBR a RAR of them, and this is neither." };
  }
  const problem = archiveProblem(entries);
  if (problem) return { ok: false, message: `This file isn't what a comic is. ${problem}` };
  return { ok: true, pages: pageOrder(entries.map((e) => e.name)) };
}

/**
 * A comic in a folder with a person's edits laid over it, and the edits
 * in effect (docs/BOOK-DETAILS.md, sections 3 and 6). Edits from before a
 * comic had details of its own (its whole name as its title, its number
 * in the series) are read as the new ones, and the comic is named, given
 * its byline and put in its place from the result. Those moved edits are
 * the ones in effect: the book's next save writes them in the new shape
 * (core/edits.ts, `diffEdits`), and nothing is written on reading them.
 *
 * A comic matched on ComicVine has what ComicVine said laid over its files
 * first, and the edits over that (docs/BOOK-DETAILS.md, section 7): each
 * field is a person's edit, else ComicVine's, else its files'. `original`
 * stays what the files say, so the shelf can be laid again from it, and
 * the match goes with the book as `comicVineMatch`.
 *
 * A comic loaded from a library.csv written before comics kept their
 * details there has none to be named from: what it is called, by whom and
 * where it comes were made from details it no longer carries. Named again,
 * "Saga #14" would be "Saga #14: Saga #14". It is shown as it was, its
 * edits laid over it as they were, until the scan brings its details.
 */
export function folderComicEdited(files: Book, edits: EditValues, match: ComicVineLayer | null = null): Pick<ScannedBook, "book" | "original" | "edits" | "comicVineMatch"> {
  const kept = Object.keys(edits).length > 0;
  if (!namedFromDetails(files)) return { book: applyEdits(files, edits), original: files, ...(kept ? { edits } : {}) };
  const values = movedComicEdits(edits, files);
  // What ComicVine said lies between the files and the edits (core/comicvine.ts, `withMatch`): an edit always beats it.
  const layered = withMatch(files, match);
  return { book: namedComic(applyEdits(layered, values), values), original: files, ...(kept ? { edits: values } : {}), ...(match ? { comicVineMatch: match } : {}) };
}

/** The details of a book its edit form reads (core/edits.ts, `fieldText`) that a server sends only with the book in full: a comic's own among them. */
const IN_FULL = ["title", "rawTitle", "subtitle", "author", "narrator", "series", "seriesIndex", "year", "genres", "publisher", "language", "isbn", "asin", "description", "rightToLeft", "credits", "issue", "volume", "collects", "imprint", "coverDate", "onSale", "storyArcs", "comicvine"] as const;

/**
 * A server's comic as the server sends it in full (`GET /api/books/:id`),
 * on the book the shelf has: its own details, which its listing leaves
 * out, its edits and what ComicVine said already laid over them by the
 * server. A detail the server doesn't say is one the comic hasn't.
 */
export function serverComicInFull(listed: Book, full: ServerBookDetail["book"]): Book {
  const out: Record<string, unknown> = { ...listed };
  for (const k of IN_FULL) {
    const v = (full as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
    else if (k !== "title" && k !== "rawTitle" && k !== "author" && k !== "narrator" && k !== "series" && k !== "seriesIndex" && k !== "year") delete out[k];
  }
  return out as unknown as Book;
}

/**
 * Whether a comic's book carries the details its name is made from. One
 * the scan made always does: its byline is made from its credits and its
 * place from its number (core/comic-name.ts), so a byline with no credits,
 * or a place with no number, was made before comics kept their details.
 */
function namedFromDetails(book: Book): boolean {
  const details = !!(book.issue || book.volume || book.collects || book.credits);
  return details || (!book.author && book.seriesIndex === null);
}
