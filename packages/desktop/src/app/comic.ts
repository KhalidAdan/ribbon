import type { Host } from "@ribbon/core/host";
import { archiveProblem, isPdfFile, pageOrder } from "@ribbon/core/comic/pages";
import { pdfPageNames } from "@ribbon/core/comic/session";
import { cbrRefusal } from "@ribbon/core/comic/cbr";

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
