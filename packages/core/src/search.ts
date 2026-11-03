import { count, create, insertMultiple, search, type Orama } from "@orama/orama";
import type { Book, Part } from "./types";

/**
 * Full-text search over the shelf with Orama: title and subtitle, author,
 * narrator, series, genres and publisher, and an anthology's stories and
 * their authors, prefix matching
 * with one typo of tolerance. A book is found when every word searched
 * for is in it somewhere. Text is folded to plain lower-case letters
 * on the way in and on the way out, so "Béla" finds "bela" and vice
 * versa. Everything is in memory; the index is rebuilt whenever the
 * shelf changes, which takes a few milliseconds for a few hundred books.
 */
const schema = { title: "string", author: "string", narrator: "string", series: "string", stories: "string", more: "string" } as const;

export type BookIndex = Orama<typeof schema>;

/** What the search reads of a book: its details, and an anthology's stories. A server's listed book will do. */
export interface Searchable {
  book: Pick<Book, "id" | "title" | "author" | "narrator" | "series" | "subtitle" | "genres" | "publisher">;
  parts: readonly Pick<Part, "title" | "author">[];
}

/** Lower-case, no diacritics, collapsed whitespace. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function indexBooks(books: readonly Searchable[]): Promise<BookIndex> {
  const db = create({ schema });
  await insertMultiple(
    db,
    books.map(({ book: b, parts }) => ({
      id: b.id,
      title: fold(b.title),
      author: fold(b.author),
      narrator: fold(b.narrator),
      series: fold(b.series),
      stories: fold(parts.map((p) => `${p.title} ${p.author}`).join(" ")),
      more: fold([b.subtitle ?? "", ...(b.genres ?? []), b.publisher ?? ""].join(" ")),
    })),
  );
  return db;
}

/**
 * Book ids in rank order: the books every word of the query is found in,
 * in any of their fields. An empty or blank query matches nothing.
 */
export async function searchBooks(index: BookIndex, query: string, limit = 500): Promise<string[]> {
  const term = fold(query);
  if (!term) return [];
  // Every book that matches is asked for, so none is cut off before the words are checked.
  const ids = async (term: string) => (await search(index, { term, properties: "*", tolerance: 1, limit: count(index), boost: { title: 2, more: 0.5 } })).hits.map((h) => String(h.id));
  const ranked = await ids(term);
  // Orama finds a book that has any of the words, so a line from inside a book would bring back every book with
  // "the" or "old" in its title. Each word is looked for on its own, and only the books that have them all stay.
  let kept = new Set(ranked);
  for (const word of new Set(index.tokenizer.tokenize(term))) {
    if (kept.size === 0) break;
    const has = new Set(await ids(word));
    kept = new Set([...kept].filter((id) => has.has(id)));
  }
  return ranked.filter((id) => kept.has(id)).slice(0, limit);
}
