import type { Host } from "@ribbon/core/host";
import { archiveProblem, isPdfFile, pageOrder } from "@ribbon/core/comic/pages";
import { pdfPageNames } from "@ribbon/core/comic/session";
import { cbrRefusal } from "@ribbon/core/comic/cbr";
import { namedComic } from "@ribbon/core/comic-name";
import { movedComicEdits } from "@ribbon/core/comic-edits";
import { applyEdits, type EditValues } from "@ribbon/core/edits";
import type { ScannedBook } from "@ribbon/core/scan/scan";
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
 * A comic loaded from a library.csv written before comics kept their
 * details there has none to be named from: what it is called, by whom and
 * where it comes were made from details it no longer carries. Named again,
 * "Saga #14" would be "Saga #14: Saga #14". It is shown as it was, its
 * edits laid over it as they were, until the scan brings its details.
 */
export function folderComicEdited(files: Book, edits: EditValues): Pick<ScannedBook, "book" | "original" | "edits"> {
  if (!namedFromDetails(files)) return { book: applyEdits(files, edits), original: files, edits };
  const values = movedComicEdits(edits, files);
  return { book: namedComic(applyEdits(files, values), values), original: files, edits: values };
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
