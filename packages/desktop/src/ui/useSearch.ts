import { useEffect, useMemo, useState } from "react";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { indexBooks, searchBooks, type BookIndex } from "@ribbon/core/search";
import type { FoundLine } from "../app/controller";
import { useController } from "./store";

/** Lines are asked for this long after the words stop changing, so typing asks once, not at every letter. */
const LINES_AFTER_MS = 300;

/**
 * The shelf's search: the books whose details have every word, in rank
 * order, and the lines in the books' text that best match the words, from
 * each server (`AppController.findLines`). `lines` says which words it
 * answers, so nothing is said to be missing while it's still being asked.
 */
export function useSearch(books: readonly ScannedBook[]): { query: string; setQuery: (q: string) => void; found: ScannedBook[] | null; lines: { for: string; found: FoundLine[] } | null } {
  const c = useController();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<BookIndex | null>(null);
  const [matches, setMatches] = useState<string[] | null>(null);
  const [lines, setLines] = useState<{ for: string; found: FoundLine[] } | null>(null);
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
  useEffect(() => {
    const asked = query.trim();
    if (!asked) {
      setLines(null);
      return;
    }
    let live = true;
    const soon = setTimeout(() => void c.findLines(asked).then((found) => live && setLines({ for: asked, found })), LINES_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(soon);
    };
  }, [c, query]);
  const found = useMemo(() => {
    if (!matches) return null;
    const byId = new Map(books.map((b) => [b.book.id, b]));
    return matches.map((id) => byId.get(id)).filter((b): b is ScannedBook => !!b);
  }, [books, matches]);
  return { query, setQuery, found, lines };
}
