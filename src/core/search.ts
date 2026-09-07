import { create, insertMultiple, search, type Orama } from "@orama/orama";
import type { Book } from "./types";

/**
 * Full-text search over the shelf with Orama: title, author, narrator
 * and series, prefix matching with one typo of tolerance. Text is
 * folded to plain lower-case letters on the way in and on the way out,
 * so "Béla" finds "bela" and vice versa. Everything is in memory; the
 * index is rebuilt whenever the shelf changes, which takes a few
 * milliseconds for a few hundred books.
 */
const schema = { title: "string", author: "string", narrator: "string", series: "string" } as const;

export type BookIndex = Orama<typeof schema>;

/** Lower-case, no diacritics, collapsed whitespace. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function indexBooks(books: readonly Book[]): Promise<BookIndex> {
  const db = create({ schema });
  await insertMultiple(
    db,
    books.map((b) => ({ id: b.id, title: fold(b.title), author: fold(b.author), narrator: fold(b.narrator), series: fold(b.series) })),
  );
  return db;
}

/** Book ids in rank order. An empty or blank query matches nothing. */
export async function searchBooks(index: BookIndex, query: string, limit = 500): Promise<string[]> {
  const term = fold(query);
  if (!term) return [];
  const result = await search(index, { term, properties: "*", tolerance: 1, limit, boost: { title: 2 } });
  return result.hits.map((h) => String(h.id));
}
