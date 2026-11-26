import path from "node:path";
import type { ComicPage } from "./comic.ts";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { comicLabel, comicNamingOf, namedComic, type ComicShape } from "@ribbon/core/comic-name";
import { withMatch, type ComicVineLayer, type CvIssue, type CvVolume, type LookedUp, type SharedMatch } from "@ribbon/core/comicvine";
import { applyEdits, EDIT_FIELDS, originalOf, type EditValues, type SharedEdits } from "@ribbon/core/edits";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { remoteBook } from "@ribbon/core/server-books";
import type { Book, LoudnessMeasurement, SilenceRange } from "@ribbon/core/types";
import type { Cover } from "./covers.ts";

/**
 * Where a book's files live on the server: `books/<id>/` in its data
 * folder, with its audio under `audio/`, its EPUB as `book.epub`, its
 * covers under `covers/`, and its record as `book.json` (docs/SERVER.md,
 * section 5).
 */
export function bookDir(dataDir: string, id: string): string {
  return path.join(booksDir(dataDir), id);
}

/** The folder of every book, which can be a disk of its own: a big drive mounted there, beside a small one for the rest. */
export function booksDir(dataDir: string): string {
  return path.join(dataDir, "books");
}

/** A book as the server keeps it in `book.json`: the scanner's record, with paths inside the book's own folder. Read and changed in book-folder.ts, and nowhere else. */
export interface StoredBook extends ScannedBook {
  cover: Cover | null;
  /** The EPUB's size, when there is one: with the audio's, what a download needs room for. */
  ebookBytes?: number;
  /** A comic's pages in reading order, each with its size, listed once when it was added (comic.ts). */
  pages?: ComicPage[];
  /** Its loudness and silences, measured once here, so no device has to (prepare.ts). */
  analysis?: StoredAnalysis;
  /** The records carried in from its folder, by kind, in `records/<kind>.csv` (records.ts). */
  records?: string[];
  /** What the server filled in that the book came without (hydrate.ts). */
  filled?: FilledIn;
  /** What Audible's catalog was asked about it (describe.ts): by its title, author and length, and the recording its description is from; null when the catalog had none. */
  described?: { asked: string; asin: string | null };
  /** The way its transcript was last placed in its text (place.ts, `PLACING`); placed again when that changes. */
  placed?: number;
}

/**
 * What the server filled in for a book from its own files, so it's never
 * taken for something set by hand, and is worked out again when what it
 * came from changes.
 */
export interface FilledIn {
  /** The description, in the book's record, is its EPUB's. */
  description?: "epub";
  /** Names for chapters its files only numbered, from its text: renames by place, after the hand corrections (chapters.ts). */
  chapters?: { index: number; title: string }[];
  /** What it was worked out from (hydrate.ts, `hydrateStamp`). */
  from: string;
}

/** A book's loudness, all its files together, and the silences in each file, by the file's place in the book. */
export interface StoredAnalysis {
  loudness: LoudnessMeasurement | null;
  silence: { file: number; ranges: SilenceRange[] }[];
}

/**
 * A book's own details beyond the columns the listing has: a comic's
 * (docs/BOOK-DETAILS.md, section 2), its story's own name, its people, its
 * issue or its volume and the issues it collects, and the rest. The book
 * table keeps them as its files say them, as JSON (`book.details`), so the
 * listing can name a comic and a series label it without opening its
 * book.json; its edits are laid over them where it is listed.
 */
const OWN_DETAILS = ["rawTitle", "credits", "issue", "volume", "collects", "imprint", "coverDate", "onSale", "storyArcs", "comicvine"] as const satisfies readonly (keyof Book)[];

export type OwnDetails = Partial<Pick<Book, (typeof OWN_DETAILS)[number]>>;

/** A book's own details as the book table keeps them: a comic's, and null for any other book, which has none of its own yet. */
export function ownDetails(book: Book): OwnDetails | null {
  if (!book.comic) return null;
  return Object.fromEntries(OWN_DETAILS.filter((k) => book[k] !== undefined).map((k) => [k, book[k]]));
}

/**
 * The fields a book's edits may have on this server, as the library answer
 * says (`editFields`): all of core's but the cover, which comes as a
 * picture. A desktop asks a comic for its own details only on a server that
 * lists them; a server from before comics had details of their own says
 * nothing, and refuses a field it doesn't know (docs/BOOK-DETAILS.md,
 * section 4).
 */
export const KEPT_EDIT_FIELDS = EDIT_FIELDS.filter((f) => f !== "cover");

/**
 * A book with a person's edits laid over it, as every device is given it: a
 * comic named from its details as edited (comic-name.ts), where they are
 * known. They aren't for a comic stored before comics had details of their
 * own whose file couldn't be read again (comic-details.ts): it is shown as
 * it was then.
 *
 * A comic matched on ComicVine has what ComicVine said between its files
 * and the edits (docs/BOOK-DETAILS.md, section 7): each field is the
 * person's edit if there is one, else ComicVine's, else its files'.
 */
export function asEdited<B extends Partial<Book>>(book: B, values: EditValues, named: boolean, match: ComicVineLayer | null = null): B {
  const edited = applyEdits(withMatch(book, match), values);
  return named ? namedComic(edited, values) : edited;
}

/**
 * A comic's ComicVine match as the server keeps it (`book_match`): what
 * ComicVine said for each field and the issue's page (the layer), how its
 * number was read, its whole answer, and when and by whom it was kept
 * (null: by the server itself, by the address in its file).
 */
export interface KeptMatch extends ComicVineLayer {
  as: ComicShape;
  answer: { issue: CvIssue; run: CvVolume | null };
  matchedAt: string;
  matchedBy: string | null;
}

/** A match as a device is given it, beside the edits: its whole answer stays on the server. */
export function sharedMatch(match: KeptMatch): SharedMatch {
  return { address: match.address, as: match.as, values: match.values, matchedAt: match.matchedAt };
}

/** The ids that name a book besides its files: its ISBN and ASIN, as the position log writes them (docs/POSITION-FORMAT.md, section 4). */
export function claimsOf(book: ScannedBook["book"]): string[] {
  const claims: string[] = [];
  const isbn = book.isbn?.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (isbn && (isbn.length === 10 || isbn.length === 13)) claims.push(`urn:isbn:${isbn}`);
  const asin = book.asin?.trim().toUpperCase();
  if (asin) claims.push(`urn:asin:${asin}`);
  return claims;
}

/**
 * The server's list of its books, in its database: what the library
 * answer is made from, and what says a book is here already.
 */
export class BookIndex {
  constructor(private readonly db: DatabaseSync) {}

  /** The id of a book already on the server with these files or one of these claims, or null. */
  find(fingerprint: string, claims: readonly string[]): string | null {
    const byFiles = this.db.prepare("SELECT id FROM book WHERE fingerprint = ?").get(fingerprint);
    if (byFiles) return String(byFiles.id);
    for (const claim of claims) {
      const byClaim = this.db.prepare("SELECT book_id FROM book_claim WHERE claim = ?").get(claim);
      if (byClaim) return String(byClaim.book_id);
    }
    return null;
  }

  add(id: string, fingerprint: string, stored: StoredBook, claims: readonly string[], addedBy: string | null, at: number): void {
    const b = stored.book;
    this.db
      .prepare(
        `INSERT INTO book (id, fingerprint, title, author, narrator, series, series_index, duration_ms, size_bytes, has_audio, has_ebook, ebook_bytes, cover_hash, cover_aspect, cover_colour, added_at, added_by, has_comic, pages, is_pdf, right_to_left, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fingerprint, b.title, b.author, b.narrator, b.series, b.seriesIndex, b.durationMs, b.sizeBytes, stored.files.length > 0 ? 1 : 0, b.ebook ? 1 : 0, stored.ebookBytes ?? null, stored.cover?.hash ?? null, stored.cover?.aspect ?? null, stored.cover?.colour ?? null, at, addedBy, b.comic ? 1 : 0, b.comic ? (stored.pages?.length ?? 0) : null, b.comic && /\.pdf$/i.test(b.comic) ? 1 : 0, b.comic ? (b.rightToLeft ? 1 : 0) : null, detailsText(b));
    for (const claim of claims) this.db.prepare("INSERT OR IGNORE INTO book_claim (claim, book_id) VALUES (?, ?)").run(claim, id);
    // Deleted once and added again: devices keep it now.
    this.db.prepare("DELETE FROM deleted_book WHERE id = ?").run(id);
  }

  /** The comics added before the library listed which way they read: their records say (book-folder.ts, `listDirections`). */
  directionsToList(): string[] {
    return this.db
      .prepare("SELECT id FROM book WHERE has_comic = 1 AND right_to_left IS NULL")
      .all()
      .map((row) => String(row.id));
  }

  /** List a comic as reading right to left, or not, as its file says. */
  listDirection(id: string, rightToLeft: boolean): void {
    this.db.prepare("UPDATE book SET right_to_left = ? WHERE id = ?").run(rightToLeft ? 1 : 0, id);
  }

  /** The comics added before comics had details of their own: their files are read again, once, at start (comic-details.ts). */
  comicsToReadAgain(): string[] {
    return this.db
      .prepare("SELECT id FROM book WHERE has_comic = 1 AND details IS NULL")
      .all()
      .map((row) => String(row.id));
  }

  /** Whether a comic's own details are listed: every comic's but one stored before they were whose file couldn't be read again. */
  hasDetails(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM book WHERE id = ? AND details IS NOT NULL").get(id);
  }

  /**
   * Comics read again (comic-details.ts), listed as their files say now,
   * with their edits moved into the details they have now: all of them in
   * one transaction, so a start that stops halfway leaves every comic as it
   * was, to be read again on the next. Each comic's edits as they were are
   * kept beside them (`edits_before_move`), so the move can be undone by
   * hand; nothing else about them changes, not even when they were made.
   */
  readAgain(comics: readonly { id: string; book: Book; moved: EditValues | null }[]): void {
    this.db.exec("BEGIN");
    try {
      for (const { id, book, moved } of comics) {
        this.db.prepare("UPDATE book SET title = ?, author = ?, series = ?, series_index = ?, details = ? WHERE id = ?").run(book.title, book.author, book.series, book.seriesIndex, detailsText(book), id);
        if (moved) this.db.prepare("UPDATE book_edit SET edits_before_move = edits, edits = ? WHERE book_id = ?").run(JSON.stringify(moved), id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** A comic's ComicVine match, or null when it has none. */
  match(id: string): KeptMatch | null {
    const row = this.db.prepare("SELECT * FROM book_match WHERE book_id = ?").get(id);
    if (!row) return null;
    return {
      address: String(row.address),
      as: String(row.matched_as) as ComicShape,
      values: JSON.parse(String(row.said)) as EditValues,
      answer: JSON.parse(String(row.answer)) as KeptMatch["answer"],
      matchedAt: String(row.matched_at),
      matchedBy: row.matched_by === null ? null : String(row.matched_by),
    };
  }

  /** Keep what a look-up found as a comic's match, in place of the one it had: its edits stay as they are. False when there's no such book. */
  keepMatch(id: string, found: LookedUp, by: string | null, at: string): boolean {
    if (!this.has(id)) return false;
    this.db
      .prepare(
        `INSERT INTO book_match (book_id, address, matched_as, said, answer, matched_at, matched_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (book_id) DO UPDATE SET address = excluded.address, matched_as = excluded.matched_as, said = excluded.said, answer = excluded.answer, matched_at = excluded.matched_at, matched_by = excluded.matched_by`,
      )
      .run(id, found.address, found.as, JSON.stringify(found.values), JSON.stringify({ issue: found.issue, run: found.run }), at, by);
    return true;
  }

  /**
   * Forget a comic's match: what ComicVine said goes, whole, and the comic
   * is what its files and its edits say again. The server won't match it by
   * itself afterwards, which would put back what a person took away. False
   * when it had none.
   */
  forgetMatch(id: string, at: number): boolean {
    const match = this.match(id);
    if (!match) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM book_match WHERE book_id = ?").run(id);
      this.noteAsked(id, match.address, at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  /**
   * The comics the server matches by itself (comic-match.ts): each whose
   * file names a ComicVine issue (its ComicInfo's `Web`), with that issue,
   * never matched and never looked up by itself before. Oldest added first.
   */
  comicsToMatch(): { id: string; issue: string }[] {
    return this.db
      .prepare(
        `SELECT book.id, book.details FROM book LEFT JOIN book_match ON book_match.book_id = book.id LEFT JOIN comicvine_asked ON comicvine_asked.book_id = book.id
         WHERE book.has_comic = 1 AND book.details IS NOT NULL AND book_match.book_id IS NULL AND comicvine_asked.book_id IS NULL ORDER BY book.added_at, book.id`,
      )
      .all()
      .flatMap((row) => {
        const issue = (JSON.parse(String(row.details)) as OwnDetails).comicvine;
        return issue ? [{ id: String(row.id), issue }] : [];
      });
  }

  /** Note that the server looked a comic up by itself, or that a person forgot its match: it isn't looked up by itself again. */
  noteAsked(id: string, address: string, at: number): void {
    this.db.prepare("INSERT INTO comicvine_asked (book_id, address, asked_at) VALUES (?, ?, ?) ON CONFLICT (book_id) DO UPDATE SET address = excluded.address, asked_at = excluded.asked_at").run(id, address, at);
  }

  /** List a book as having an EPUB of these bytes now: an audiobook given the EPUB beside it in its folder after it was added (importer.ts). */
  giveEbook(id: string, ebookBytes: number): void {
    this.db.prepare("UPDATE book SET has_ebook = 1, ebook_bytes = ? WHERE id = ?").run(ebookBytes, id);
  }

  /**
   * Take a book off the server's list, with the ids that also named it, and
   * note that it was deleted, so devices that downloaded it take it off too.
   * Nobody's places are touched. False when there was no such book.
   */
  remove(id: string, deletedBy: string | null, at: number): boolean {
    this.db.exec("BEGIN");
    try {
      // Its claims go with it (ON DELETE CASCADE).
      const gone = Number(this.db.prepare("DELETE FROM book WHERE id = ?").run(id).changes) > 0;
      if (gone) this.db.prepare("INSERT INTO deleted_book (id, deleted_at, deleted_by) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by").run(id, at, deletedBy);
      this.db.exec("COMMIT");
      return gone;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The ids of the books deleted from the server, oldest first: what a device that downloaded one goes by. */
  deleted(): string[] {
    return this.db
      .prepare("SELECT id FROM deleted_book ORDER BY deleted_at, id")
      .all()
      .map((row) => String(row.id));
  }

  count(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM book").get()?.n ?? 0);
  }

  /** Every book, oldest added first, as the library answer gives it. */
  list(): ListedBook[] {
    return this.db.prepare(`${WITH_EDITS} ORDER BY book.added_at, book.id`).all().map(listed);
  }

  /** One book as the library answer gives it, or null when it isn't here. */
  get(id: string): ListedBook | null {
    const row = this.db.prepare(`${WITH_EDITS} WHERE book.id = ?`).get(id);
    return row ? listed(row) : null;
  }

  /** A book's edits as a person last saved them, or null when nobody edited it. */
  edits(id: string): KeptEdits | null {
    const row = this.db.prepare("SELECT edits, updated_at FROM book_edit WHERE book_id = ?").get(id);
    return row ? { values: JSON.parse(String(row.edits)) as EditValues, updatedAt: String(row.updated_at) } : null;
  }

  /** Keep a person's edits to a book's details, for every device, in place of the ones it had; no edits takes them back. False when there's no such book. */
  saveEdits(id: string, edits: KeptEdits, by: string | null): boolean {
    if (!this.has(id)) return false;
    if (Object.keys(edits.values).length === 0) {
      this.db.prepare("DELETE FROM book_edit WHERE book_id = ?").run(id);
      return true;
    }
    this.db
      .prepare("INSERT INTO book_edit (book_id, edits, updated_at, edited_by) VALUES (?, ?, ?, ?) ON CONFLICT (book_id) DO UPDATE SET edits = excluded.edits, updated_at = excluded.updated_at, edited_by = excluded.edited_by")
      .run(id, JSON.stringify(edits.values), edits.updatedAt, by);
    return true;
  }

  /** Whether a book is on the server. */
  has(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM book WHERE id = ?").get(id);
  }

  /** The book whose covers are named by this hash, its own or one chosen for it, or null. */
  byCover(hash: string): string | null {
    const row = this.db.prepare("SELECT id FROM book WHERE cover_hash = ? UNION SELECT book_id FROM book_cover WHERE hash = ?").get(hash, hash);
    return row ? String(row.id) : null;
  }

  /** The cover a person chose for a book, or null when it has its files'. */
  chosenCover(id: string): Cover | null {
    const row = this.db.prepare("SELECT hash, aspect, colour FROM book_cover WHERE book_id = ?").get(id);
    return row ? { hash: String(row.hash), aspect: Number(row.aspect), colour: String(row.colour) } : null;
  }

  /** Keep a cover a person chose for a book, made from their picture (covers.ts), in place of the one it had; null goes back to its files'. */
  chooseCover(id: string, cover: Cover | null, by: string | null, at: string): void {
    if (!cover) {
      this.db.prepare("DELETE FROM book_cover WHERE book_id = ?").run(id);
      return;
    }
    this.db
      .prepare("INSERT INTO book_cover (book_id, hash, aspect, colour, chosen_at, chosen_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (book_id) DO UPDATE SET hash = excluded.hash, aspect = excluded.aspect, colour = excluded.colour, chosen_at = excluded.chosen_at, chosen_by = excluded.chosen_by")
      .run(id, cover.hash, cover.aspect, cover.colour, at, by);
  }
}

/** A book's edits as the server keeps them: the fields as edited, and when it took them. */
export interface KeptEdits {
  values: EditValues;
  updatedAt: string;
}

/** The fields of a book the library answer lists, and so the ones whose files' values it gives with the edits. */
const LISTED_FIELDS = ["title", "author", "narrator", "series", "seriesIndex", "rightToLeft"] as const;

/**
 * The book table with each book's edits and the cover chosen for it, if it has them, a comic's ComicVine match, and its
 * words, once its text is indexed (search.ts).
 */
const WITH_EDITS = `SELECT book.*, book_edit.edits, book_edit.updated_at AS edited_at, book_cover.hash AS chosen_hash, book_cover.aspect AS chosen_aspect, book_cover.colour AS chosen_colour, book_cover.chosen_at,
  book_match.address AS matched_address, book_match.said AS matched_said, sentence_index.words
  FROM book LEFT JOIN book_edit ON book_edit.book_id = book.id LEFT JOIN book_cover ON book_cover.book_id = book.id LEFT JOIN book_match ON book_match.book_id = book.id
  LEFT JOIN sentence_index ON sentence_index.book_id = book.id`;

/** A row of the book table as the library answer gives it, with what ComicVine said and its edits laid over it, and the cover chosen for it. */
function listed(row: Record<string, SQLOutputValue>): ListedBook {
  const book = filed(row);
  const chosen = row.chosen_hash === null || row.chosen_hash === undefined ? null : { hash: String(row.chosen_hash), aspect: Number(row.chosen_aspect), colour: String(row.chosen_colour) };
  const hasEdits = row.edits !== null && row.edits !== undefined;
  const match = layerOf(row);
  if (!hasEdits && !chosen && !match) return book;
  const values = editsOf(row);
  // What its files say, a comic's own details among them: so a comic is named as ComicVine and its edits make it, its
  // byline and its place in its series too (comic-name.ts).
  const own = detailsOf(row);
  const files = { ...remoteBook(book).book, ...own };
  const edited = asEdited(files, values, own !== null, match);
  const shown = Object.fromEntries(LISTED_FIELDS.filter((f) => values[f] !== undefined).map((f) => [f, values[f]!]));
  const { rightToLeft: _filed, ...rest } = book;
  return {
    ...rest,
    title: edited.title,
    author: edited.author,
    narrator: edited.narrator,
    series: edited.series,
    seriesIndex: edited.seriesIndex,
    // Only a comic reads one way or the other, whatever edit a request sent for another book.
    ...(book.comic && edited.rightToLeft ? { rightToLeft: true as const } : {}),
    ...(chosen ? { cover: chosen } : {}),
    // What taking an edit back returns to: ComicVine's, where it said something, else the files'.
    ...(hasEdits || chosen ? { edited: { values, original: originalOf(withMatch(files, match), shown), updatedAt: String(row.edited_at ?? row.chosen_at), ...(chosen ? { chosenCover: true as const } : {}) } } : {}),
  };
}

/**
 * A stored book as a device is given it (`GET /api/books/:id`): its details
 * as edited, with what each field edited returns to if the edit is taken
 * back (its files', or ComicVine's where it said something), so the desktop
 * can take an edit back, and the cover chosen for it. A comic matched on
 * ComicVine comes with what ComicVine said, beside its edits (`matched`):
 * its issue's page, to show "Details from ComicVine" and link back to.
 */
export function editedStored(stored: StoredBook, edits: KeptEdits | null, chosen: Cover | null, named: boolean, match: KeptMatch | null = null): StoredBook & { edited?: SharedEdits; matched?: SharedMatch } {
  if (!edits && !chosen && !match) return stored;
  const values = edits?.values ?? {};
  return {
    ...stored,
    book: asEdited(stored.book, values, named, match),
    ...(chosen ? { cover: chosen } : {}),
    ...(edits || chosen ? { edited: { values, original: originalOf(withMatch(stored.book, match), values), updatedAt: edits?.updatedAt ?? "", ...(chosen ? { chosenCover: true as const } : {}) } } : {}),
    ...(match ? { matched: sharedMatch(match) } : {}),
  };
}

/** A row's edits, or none. */
function editsOf(row: Record<string, SQLOutputValue>): EditValues {
  return row.edits === null || row.edits === undefined ? {} : (JSON.parse(String(row.edits)) as EditValues);
}

/** What ComicVine said of a row's comic, as the book table's queries join it (`matched_said`, `matched_address`), or null. */
function layerOf(row: Record<string, SQLOutputValue>): ComicVineLayer | null {
  return row.matched_said === null || row.matched_said === undefined ? null : { values: JSON.parse(String(row.matched_said)) as EditValues, address: String(row.matched_address) };
}

/** A row's own details (a comic's), or null: any other book's, and a comic's not read again yet. */
function detailsOf(row: Record<string, SQLOutputValue>): OwnDetails | null {
  return row.details === null || row.details === undefined ? null : (JSON.parse(String(row.details)) as OwnDetails);
}

/** A book's own details as the book table's column keeps them. */
function detailsText(book: Book): string | null {
  const own = ownDetails(book);
  return own ? JSON.stringify(own) : null;
}

/**
 * A comic's label in a series, "#7", "Vol. 1" or the issues a collection
 * holds (comic-name.ts), from its row in the book table (its series and
 * its own details), what ComicVine said of it and its edits; null for any
 * other book, which a list of a series labels by its number, as ever.
 */
export function seriesLabel(row: Record<string, SQLOutputValue>): string | null {
  const own = detailsOf(row);
  if (!own) return null;
  return comicLabel(comicNamingOf(applyEdits(withMatch({ series: String(row.series), ...own }, layerOf(row)), editsOf(row))));
}

/** A row of the book table as its files have it. */
function filed(row: Record<string, SQLOutputValue>): ListedBook {
  return {
    id: String(row.id),
    title: String(row.title),
    author: String(row.author),
    narrator: String(row.narrator),
    series: String(row.series),
    seriesIndex: row.series_index === null ? null : Number(row.series_index),
    durationMs: Number(row.duration_ms),
    sizeBytes: Number(row.size_bytes),
    audio: row.has_audio === 1,
    ebook: row.has_ebook === 1,
    ebookBytes: row.ebook_bytes === null ? null : Number(row.ebook_bytes),
    words: row.words === null || row.words === undefined ? null : Number(row.words),
    comic: row.has_comic === 1,
    pdf: row.is_pdf === 1,
    pages: row.pages === null || row.pages === undefined ? null : Number(row.pages),
    ...(row.right_to_left === 1 ? { rightToLeft: true as const } : {}),
    cover: row.cover_hash === null ? null : { hash: String(row.cover_hash), aspect: Number(row.cover_aspect), colour: String(row.cover_colour) },
    addedAt: new Date(Number(row.added_at)).toISOString(),
  };
}

/**
 * A book in the library answer: what the shelf needs to draw it at its
 * final size and colour before its cover arrives, and nothing that
 * changes while someone listens (docs/SERVER.md, section 7).
 */
export interface ListedBook {
  id: string;
  title: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: number | null;
  durationMs: number;
  sizeBytes: number;
  audio: boolean;
  ebook: boolean;
  /** The EPUB's bytes, when there is one. */
  ebookBytes: number | null;
  /** How many words its EPUB has, counted from its text once the server has read it; null until then, and for a book with no EPUB. */
  words: number | null;
  /** A comic (docs/COMICS.md): read and never heard, its size the size of its CBZ. */
  comic: boolean;
  /** Its pages are a PDF's (docs/COMICS.md, section 12): the file a device keeps is `book.pdf`, and the server draws its pages. */
  pdf: boolean;
  /** A comic's pages; null for any other book. */
  pages: number | null;
  /** A comic read right to left, as its file says or a person's edit does (docs/COMICS.md, section 15); absent for any other. */
  rightToLeft?: true;
  cover: Cover | null;
  addedAt: string;
  /** The edits a person made to it, already laid over the fields above; absent when nobody edited it. */
  edited?: SharedEdits;
}
