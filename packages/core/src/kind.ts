import type { Book } from "./types";

/**
 * A book that is read and never heard: an EPUB with no audio
 * (`readerOnly`, core/ebook.ts) or a comic (docs/COMICS.md). The shelf
 * says "reading" where it says "listening" for the rest, shows how far
 * through instead of time left, and opens it to read instead of playing.
 */
export function onlyRead(book: Pick<Book, "fileCount" | "ebook" | "comic">): boolean {
  return book.fileCount === 0 && (!!book.ebook || !!book.comic);
}

/** How long a comic is, as the shelf says it: its pages, once they have been counted. */
export function pagesLabel(pages: number | undefined): string {
  if (pages === undefined) return "Comic";
  return `${pages.toLocaleString("en")} ${pages === 1 ? "page" : "pages"}`;
}
