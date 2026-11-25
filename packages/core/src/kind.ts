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
export function pagesLabel(pages: number | undefined, file = ""): string {
  if (pages === undefined) return pagesKind(file);
  return `${pages.toLocaleString("en")} ${pages === 1 ? "page" : "pages"}`;
}

/** What a book of pages is, in a word, by its file: a comic (a CBZ), or a PDF, which may be anything. */
export function pagesKind(file: string): "Comic" | "PDF" {
  return /\.pdf$/i.test(file) ? "PDF" : "Comic";
}

/**
 * The three kinds of book Ribbon keeps, as the edit form tells them
 * apart (edit-form.ts): one that is heard (with or without its text), a
 * text that is only read, and a comic, a book of pages already drawn
 * (a PDF is one too).
 */
export type BookKind = "audiobook" | "text" | "comic";

export function bookKind(book: Pick<Book, "fileCount" | "ebook" | "comic">): BookKind {
  if (book.comic) return "comic";
  return book.fileCount === 0 && book.ebook ? "text" : "audiobook";
}
