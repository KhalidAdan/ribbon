import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { detectSeries, MIN_SERIES_BOOKS, uniqueKey } from "../../../src/core/series.ts";
import { remoteBook } from "../../../src/core/server-books.ts";
import type { Book } from "../../../src/core/types.ts";
import type { ListedBook } from "./books.ts";

/** A series as devices read it (`GET /api/series`): its books in order. */
export interface ServerSeries {
  id: string;
  name: string;
  books: SeriesBook[];
}

/** A book of a series. */
export interface SeriesBook {
  id: string;
  /** Its number in the series where one is known: 8 for "Book 8, Part 2", 2.5 for a novella between 2 and 3. */
  number: number | null;
  /** Its title as a list of the series shows it, without the series' name ("The End and the Death: Volume I"); null to show its own. */
  title: string | null;
  /** False leaves it off the shelf: a novella nobody listens to. */
  shelved: boolean;
}

/** A book as a person puts it in a series. A number or title left out keeps the one it has. */
export interface SeriesBookChange {
  id: string;
  number?: number | null;
  title?: string | null;
  shelved?: boolean;
}

/**
 * The library's series: rows of the database, the same for every device
 * and every person, rather than something each device works out from tags
 * (docs/SERVER.md, section 7). The server finds them as books arrive, by the
 * rules the desktop has always used (src/core/series.ts): a series tag,
 * else a series named in the titles ("…, Book 7"). After that a series is
 * what people make of it: renamed, reordered, numbered, books moved in or
 * out or left off the shelf, or deleted; finding series again never undoes
 * any of that.
 */
export class LibrarySeries {
  constructor(private readonly db: DatabaseSync) {}

  /** Every series with a book in it, by name. */
  list(): ServerSeries[] {
    return this.read("");
  }

  /** One series, or null when there's no such series or it has no books. */
  get(id: string): ServerSeries | null {
    return this.read("WHERE s.id = ?", id)[0] ?? null;
  }

  /**
   * Look for series among the library's books and put each book found in
   * one there, unless a person took it out of that series or deleted the
   * series. A book already in a series stays where it is, and a series found
   * anew needs MIN_SERIES_BOOKS books that aren't in another. How many books
   * joined a series.
   */
  find(books: readonly ListedBook[], at: number): number {
    const placed = new Set(this.db.prepare("SELECT book_id FROM series_book").all().map((row) => String(row.book_id)));
    const dropped = new Set(this.db.prepare("SELECT id FROM series_dropped").all().map((row) => String(row.id)));
    const left = new Set(this.db.prepare("SELECT series_id, book_id FROM series_left").all().map((row) => `${String(row.series_id)}/${String(row.book_id)}`));
    let joined = 0;
    this.inTransaction(() => {
      // A series whose books were all deleted goes with them.
      this.db.exec("DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM series_book WHERE series_id = series.id)");
      for (const group of detectSeries(books.map(asFound), "")) {
        if (dropped.has(group.key)) continue;
        const fresh = group.bookIds.filter((id) => !placed.has(id) && !left.has(`${group.key}/${id}`));
        if (fresh.length === 0) continue;
        if (!this.db.prepare("SELECT 1 FROM series WHERE id = ?").get(group.key)) {
          if (fresh.length < MIN_SERIES_BOOKS) continue;
          this.db.prepare("INSERT INTO series (id, name, created_at, changed_at, changed_by) VALUES (?, ?, ?, ?, NULL)").run(group.key, group.name, at, at);
        }
        for (const id of fresh) {
          this.place(group.key, id, group.numbers?.[id] ?? null, group.titles?.[id] ?? null);
          placed.add(id);
        }
        joined += fresh.length;
      }
    });
    return joined;
  }

  /** A series a person makes: these books, in this order, taken out of any series they were in. */
  create(name: string, books: readonly SeriesBookChange[], by: string | null, at: number): ServerSeries | null {
    const taken = this.db.prepare("SELECT id FROM series").all().map((row) => String(row.id));
    const id = uniqueKey(name, taken);
    this.inTransaction(() => {
      this.db.prepare("INSERT INTO series (id, name, created_at, changed_at, changed_by) VALUES (?, ?, ?, ?, ?)").run(id, name, at, at, by);
      // Made again by hand, a series once deleted is back.
      this.db.prepare("DELETE FROM series_dropped WHERE id = ?").run(id);
      this.fill(id, books);
      // None of its books is here: no series.
      if (!this.db.prepare("SELECT 1 FROM series_book WHERE series_id = ?").get(id)) this.db.prepare("DELETE FROM series WHERE id = ?").run(id);
    });
    return this.get(id);
  }

  /**
   * A person's change to a series: its name, and its books in order. Books
   * it no longer has stay out of it when series are found again; books
   * brought in leave the series they were in. Null when there's no such
   * series.
   */
  save(id: string, name: string, books: readonly SeriesBookChange[], by: string | null, at: number): ServerSeries | null {
    if (!this.db.prepare("SELECT 1 FROM series WHERE id = ?").get(id)) return null;
    this.inTransaction(() => {
      const kept = new Set(books.map((b) => b.id));
      for (const row of this.db.prepare("SELECT book_id FROM series_book WHERE series_id = ?").all(id)) {
        if (!kept.has(String(row.book_id))) this.db.prepare("INSERT OR IGNORE INTO series_left (series_id, book_id) VALUES (?, ?)").run(id, String(row.book_id));
      }
      this.db.prepare("UPDATE series SET name = ?, changed_at = ?, changed_by = ? WHERE id = ?").run(name, at, by, id);
      this.fill(id, books);
    });
    return this.get(id);
  }

  /** Delete a series: its books stay in the library, and it isn't found again. False when there was no such series. */
  drop(id: string, by: string | null, at: number): boolean {
    let gone = false;
    this.inTransaction(() => {
      gone = Number(this.db.prepare("DELETE FROM series WHERE id = ?").run(id).changes) > 0;
      if (gone) this.db.prepare("INSERT INTO series_dropped (id, dropped_at, dropped_by) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET dropped_at = excluded.dropped_at, dropped_by = excluded.dropped_by").run(id, at, by);
    });
    return gone;
  }

  // Inside -------------------------------------------------------------------

  private read(where: string, ...args: SQLInputValue[]): ServerSeries[] {
    const rows = this.db
      .prepare(`SELECT s.id, s.name, b.book_id, b.number, b.title, b.shelved FROM series s JOIN series_book b ON b.series_id = s.id ${where} ORDER BY s.name COLLATE NOCASE, s.id, b.position`)
      .all(...args);
    const out: ServerSeries[] = [];
    for (const row of rows) {
      const id = String(row.id);
      if (out.at(-1)?.id !== id) out.push({ id, name: String(row.name), books: [] });
      out.at(-1)!.books.push(member(row));
    }
    return out;
  }

  /**
   * A series' books as a person ordered them, each out of the series it was
   * in. A number or title not given keeps the one it had in this series; a
   * book brought in from another comes without, since its number there (6 in
   * Siege of Terra) says nothing of its place here.
   */
  private fill(id: string, books: readonly SeriesBookChange[]): void {
    const had = new Map(this.db.prepare("SELECT book_id, number, title FROM series_book WHERE series_id = ?").all(id).map((row) => [String(row.book_id), member(row)]));
    this.db.prepare("DELETE FROM series_book WHERE series_id = ?").run(id);
    let position = 0;
    for (const book of books) {
      if (!this.db.prepare("SELECT 1 FROM book WHERE id = ?").get(book.id)) continue;
      // Brought in from another series: it stays out of that one when series are found again.
      const from = this.db.prepare("SELECT series_id FROM series_book WHERE book_id = ?").get(book.id);
      if (from) {
        this.db.prepare("INSERT OR IGNORE INTO series_left (series_id, book_id) VALUES (?, ?)").run(String(from.series_id), book.id);
        this.db.prepare("DELETE FROM series_book WHERE book_id = ?").run(book.id);
      }
      this.db.prepare("DELETE FROM series_left WHERE series_id = ? AND book_id = ?").run(id, book.id);
      const number = book.number !== undefined ? book.number : (had.get(book.id)?.number ?? null);
      const title = book.title !== undefined ? book.title : (had.get(book.id)?.title ?? null);
      this.db
        .prepare("INSERT INTO series_book (series_id, book_id, position, number, title, shelved) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, book.id, ++position, number, title, book.shelved === false ? 0 : 1);
    }
  }

  /** A book found to be in a series goes among its books by its number, else at the end. */
  private place(id: string, book: string, number: number | null, title: string | null): void {
    const rows = this.db.prepare("SELECT position, number FROM series_book WHERE series_id = ? ORDER BY position").all(id);
    let at = rows.length;
    if (number !== null) {
      const later = rows.findIndex((row) => row.number !== null && Number(row.number) > number);
      if (later >= 0) at = later;
    }
    const before = at > 0 ? Number(rows[at - 1]!.position) : 0;
    const after = at < rows.length ? Number(rows[at]!.position) : before + 2;
    this.db.prepare("INSERT INTO series_book (series_id, book_id, position, number, title, shelved) VALUES (?, ?, ?, ?, ?, 1)").run(id, book, (before + after) / 2, number, title);
  }

  private inTransaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function member(row: Record<string, SQLOutputValue>): SeriesBook {
  return {
    id: String(row.book_id),
    number: row.number === null ? null : Number(row.number),
    title: row.title === null ? null : String(row.title),
    shelved: row.shelved === 1,
  };
}

/**
 * A book as series are found from it: its series tag and its title. The
 * server doesn't keep the folder a book came from, so a number with no
 * series named says nothing, and the title stands in for the folder when
 * books without a number are put in order.
 */
function asFound(b: ListedBook): Book {
  return { ...remoteBook(b).book, id: b.id, path: b.title, seriesIndex: b.series.trim() ? b.seriesIndex : null };
}
