import type { DatabaseSync } from "node:sqlite";
import type { ReadAlong } from "../../../src/core/reading/readalong.ts";
import type { BookIndex } from "./books.ts";
import { readStored } from "./prepare.ts";
import type { ReadAlongs } from "./readalong.ts";

/** A sentence found: the book, where the sentence is, and its words with the ones searched for marked. */
export interface Found {
  /** The book's id on this server. */
  book: string;
  /** The sentence, counted across the book's read-along: how a device names a place (src/core/reading/readalong.ts). */
  sentence: number;
  /** When the narrator reads it. */
  ms: number;
  /** The contents entry it's under, when the book has contents. */
  chapter: string | null;
  text: string;
  /** The words that matched, as [start, length] in `text` (UTF-16). */
  matches: [number, number][];
}

/** The marks `highlight()` puts around a matched word: characters no book's text has. */
const OPEN = "\u0002";
const CLOSE = "\u0003";

/** At most this many sentences come back. */
const LIMIT = 20;

/**
 * The little words of English, left out of a search that has others: they're
 * in almost every sentence, so they'd only light up everywhere and rank
 * nothing. A search of nothing but these still searches them.
 */
const LITTLE_WORDS = new Set("a an and are as at be but by for from had has have he her him his i in is it its me my of on or our she so than that the their them then there they this to was we were what when where which who whom why will with would you your".split(" "));

/**
 * Every book's sentences, searchable: how a device without a keyboard worth
 * the name (the Apple TV, by voice) finds a half-remembered line and goes to
 * it. One row per sentence of a book's read-along, in SQLite's full-text
 * search (FTS5, built into Node), with words stemmed, so "gets" finds "get"
 * and "brains" finds "brain", and ranked by how rare the words found are.
 *
 * A book's sentences are indexed when its read-along is made from something
 * new (ReadAlongs, by its stamp), as books are added, and at start-up for any
 * not indexed yet. A book that's deleted leaves the index.
 */
export class SearchIndex {
  constructor(private readonly db: DatabaseSync) {}

  /** Whether a book's sentences are indexed from the read-along with this stamp. */
  isCurrent(book: string, stamp: string): boolean {
    return this.db.prepare("SELECT 1 FROM sentence_index WHERE book_id = ? AND stamp = ?").get(book, stamp) !== undefined;
  }

  /** Index a book's read-along, in place of what was indexed of it before. */
  index(book: string, stamp: string, readAlong: ReadAlong): void {
    const insert = this.db.prepare("INSERT INTO sentence_text (text, book_id, n, ms, chapter) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM sentence_text WHERE book_id = ?").run(book);
      let n = 0;
      let entry = -1;
      for (const [b, block] of readAlong.blocks.entries()) {
        while (entry + 1 < readAlong.contents.length && readAlong.contents[entry + 1]!.block <= b) entry++;
        const chapter = entry >= 0 ? readAlong.contents[entry]!.title : null;
        const words = (block.runs ?? []).map((r) => r.t).join("");
        for (const s of block.sentences ?? []) insert.run(words.slice(s.start, s.end), book, n++, s.ms, chapter);
      }
      this.db.prepare("INSERT INTO sentence_index (book_id, stamp, sentences) VALUES (?, ?, ?) ON CONFLICT (book_id) DO UPDATE SET stamp = excluded.stamp, sentences = excluded.sentences").run(book, stamp, n);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** A deleted book leaves the index. */
  remove(book: string): void {
    this.db.prepare("DELETE FROM sentence_text WHERE book_id = ?").run(book);
    this.db.prepare("DELETE FROM sentence_index WHERE book_id = ?").run(book);
  }

  /**
   * Index every book with a read-along that isn't indexed as its read-along
   * stands: at start-up, and after books are added. One book at a time, in the
   * background; a book whose text can't be read is left out. How many were indexed.
   */
  async indexAll(books: BookIndex, readAlongs: ReadAlongs, dataDir: string): Promise<number> {
    if (!readAlongs.available) return 0;
    let indexed = 0;
    for (const listed of books.list()) {
      if (!listed.ebook || !listed.audio) continue;
      const stored = await readStored(dataDir, listed.id);
      if (!stored || this.isCurrent(listed.id, await readAlongs.stamp(listed.id, stored))) continue;
      // Making the read-along indexes it.
      if (await readAlongs.of(listed.id, stored).catch(() => null)) indexed++;
    }
    return indexed;
  }

  /**
   * The sentences that best match words as someone remembers them, or says
   * them: any of the words, the rarest counting most, in one book or every
   * one. Punctuation, the order of the words and the little words between
   * them don't matter.
   */
  search(words: string, options: { book?: string; limit?: number } = {}): Found[] {
    const said = words.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const telling = said.filter((w) => !LITTLE_WORDS.has(w));
    const terms = telling.length > 0 ? telling : said;
    if (terms.length === 0) return [];
    // Each word quoted, so nothing said is read as FTS5's own syntax (AND, NEAR, a stray quote).
    const query = [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
    const sql = `SELECT book_id AS book, n AS sentence, ms, chapter, highlight(sentence_text, 0, char(2), char(3)) AS marked
      FROM sentence_text WHERE sentence_text MATCH ?${options.book ? " AND book_id = ?" : ""} ORDER BY bm25(sentence_text) LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(options.book ? [query, options.book] : [query]), options.limit ?? LIMIT) as { book: string; sentence: number; ms: number; chapter: string | null; marked: string }[];
    return rows.map(({ marked, ...row }) => ({ ...row, ...unmark(marked) }));
  }
}

/** The text a highlighted sentence is, and where its marked words are in it. */
function unmark(marked: string): { text: string; matches: [number, number][] } {
  let text = "";
  const matches: [number, number][] = [];
  let open = -1;
  for (const c of marked) {
    if (c === OPEN) open = text.length;
    else if (c === CLOSE && open >= 0) {
      matches.push([open, text.length - open]);
      open = -1;
    } else text += c;
  }
  return { text, matches };
}
