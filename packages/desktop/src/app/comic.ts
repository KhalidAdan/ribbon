import type { Host } from "@ribbon/core/host";
import { archiveProblem, pageOrder } from "@ribbon/core/comic/pages";

/**
 * A comic's pages, for the reader: its archive's list, read once, in
 * reading order (docs/COMICS.md, section 5). No page is opened here.
 */
export async function comicPages(host: Host, absPath: string): Promise<{ ok: true; pages: string[] } | { ok: false; message: string }> {
  if (!host.comicEntries) return { ok: false, message: "Comics can't be opened here." };
  let entries;
  try {
    entries = await host.comicEntries(absPath);
  } catch {
    return { ok: false, message: "The file isn't a comic Ribbon can open: a CBZ is a zip of pictures, and this isn't one." };
  }
  const problem = archiveProblem(entries);
  if (problem) return { ok: false, message: `This file isn't what a comic is. ${problem}` };
  return { ok: true, pages: pageOrder(entries.map((e) => e.name)) };
}
