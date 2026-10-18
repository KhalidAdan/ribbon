import { useEffect, useMemo, useState } from "react";
import type { ScannedBook } from "../core/scan/scan";
import { indexBooks, searchBooks, type BookIndex } from "../core/search";

/** The shelf's search: the index follows the books, the matches follow the query, in rank order. */
export function useSearch(books: readonly ScannedBook[]): { query: string; setQuery: (q: string) => void; found: ScannedBook[] | null } {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<BookIndex | null>(null);
  const [matches, setMatches] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void indexBooks(books as ScannedBook[]).then((db) => live && setIndex(db));
    return () => {
      live = false;
    };
  }, [books]);
  useEffect(() => {
    if (!index || !query.trim()) {
      setMatches(null);
      return;
    }
    let live = true;
    void searchBooks(index, query).then((ids) => live && setMatches(ids));
    return () => {
      live = false;
    };
  }, [index, query]);
  const found = useMemo(() => {
    if (!matches) return null;
    const byId = new Map(books.map((b) => [b.book.id, b]));
    return matches.map((id) => byId.get(id)).filter((b): b is ScannedBook => !!b);
  }, [books, matches]);
  return { query, setQuery, found };
}
