// The fixed shelf both comparison pages draw: thirty public-domain books, at the desktop's size.

import type { CaseBook } from "@ribbon/core/bookcase/case";
import { LAMP, type Develop } from "../../src/bookcase3d/lamplight";
import books from "./ref/books.json";

export const WIDTH = 1180, K = 1, SCALE = 2;

/** The developing, with any number given in the address bar in place of the chosen one. */
export function developFromAddress(): Develop {
  const asked = new URLSearchParams(location.search), d: Record<string, unknown> = { ...LAMP };
  for (const [name, value] of asked) if (name in d) d[name] = typeof d[name] === "number" ? Number(value) : value;
  return d as unknown as Develop;
}

export const caseBooks: CaseBook[] = books.map((e) => ({
  id: e.book.id, title: e.book.title, author: e.book.author, words: e.book.words,
  fraction: e.fraction, finished: e.finished, addedAt: Date.parse(e.book.addedAt),
}));
