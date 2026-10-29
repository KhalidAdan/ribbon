import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { applyEdits, originalOf, type EditValues, type SharedEdits } from "../../../src/core/edits.ts";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
import { remoteBook } from "../../../src/core/server-books.ts";
import type { LoudnessMeasurement, SilenceRange } from "../../../src/core/types.ts";
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

/**
 * Take a deleted book's folder away. It's moved aside first, in one step,
 * so a book is never half there, and a folder that won't empty never stands
 * in the way of the same book being added again.
 */
export async function removeBookDir(dataDir: string, id: string): Promise<void> {
  const dir = bookDir(dataDir, id);
  const aside = `${dir}.deleting-${randomBytes(4).toString("hex")}`;
  try {
    await rename(dir, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  await rm(aside, { recursive: true, force: true });
}

/** A book as the server keeps it in `book.json`: the scanner's record, with paths inside the book's own folder. */
export interface StoredBook extends ScannedBook {
  cover: Cover | null;
  /** The EPUB's size, when there is one: with the audio's, what a download needs room for. */
  ebookBytes?: number;
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
        `INSERT INTO book (id, fingerprint, title, author, narrator, series, series_index, duration_ms, size_bytes, has_audio, has_ebook, ebook_bytes, cover_hash, cover_aspect, cover_colour, added_at, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fingerprint, b.title, b.author, b.narrator, b.series, b.seriesIndex, b.durationMs, b.sizeBytes, stored.files.length > 0 ? 1 : 0, b.ebook ? 1 : 0, stored.ebookBytes ?? null, stored.cover?.hash ?? null, stored.cover?.aspect ?? null, stored.cover?.colour ?? null, at, addedBy);
    for (const claim of claims) this.db.prepare("INSERT OR IGNORE INTO book_claim (claim, book_id) VALUES (?, ?)").run(claim, id);
    // Deleted once and added again: devices keep it now.
    this.db.prepare("DELETE FROM deleted_book WHERE id = ?").run(id);
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
const LISTED_FIELDS = ["title", "author", "narrator", "series", "seriesIndex"] as const;

/** The book table with each book's edits and the cover chosen for it, if it has them. */
const WITH_EDITS = `SELECT book.*, book_edit.edits, book_edit.updated_at AS edited_at, book_cover.hash AS chosen_hash, book_cover.aspect AS chosen_aspect, book_cover.colour AS chosen_colour, book_cover.chosen_at
  FROM book LEFT JOIN book_edit ON book_edit.book_id = book.id LEFT JOIN book_cover ON book_cover.book_id = book.id`;

/** A row of the book table as the library answer gives it, with its edits laid over it and the cover chosen for it. */
function listed(row: Record<string, SQLOutputValue>): ListedBook {
  const book = filed(row);
  const chosen = row.chosen_hash === null || row.chosen_hash === undefined ? null : { hash: String(row.chosen_hash), aspect: Number(row.chosen_aspect), colour: String(row.chosen_colour) };
  if ((row.edits === null || row.edits === undefined) && !chosen) return book;
  const values = row.edits === null || row.edits === undefined ? {} : (JSON.parse(String(row.edits)) as EditValues);
  const files = remoteBook(book).book;
  const edited = applyEdits(files, values);
  const shown = Object.fromEntries(LISTED_FIELDS.filter((f) => values[f] !== undefined).map((f) => [f, values[f]!]));
  return {
    ...book,
    title: edited.title,
    author: edited.author,
    narrator: edited.narrator,
    series: edited.series,
    seriesIndex: edited.seriesIndex,
    ...(chosen ? { cover: chosen } : {}),
    edited: { values, original: originalOf(files, shown), updatedAt: String(row.edited_at ?? row.chosen_at), ...(chosen ? { chosenCover: true as const } : {}) },
  };
}

/**
 * A stored book as a device is given it (`GET /api/books/:id`): its details
 * as edited, with what its files say for each field edited, so the desktop
 * can take an edit back, and the cover chosen for it.
 */
export function editedStored(stored: StoredBook, edits: KeptEdits | null, chosen: Cover | null): StoredBook & { edited?: SharedEdits } {
  if (!edits && !chosen) return stored;
  const values = edits?.values ?? {};
  return {
    ...stored,
    book: applyEdits(stored.book, values),
    ...(chosen ? { cover: chosen } : {}),
    edited: { values, original: originalOf(stored.book, values), updatedAt: edits?.updatedAt ?? "", ...(chosen ? { chosenCover: true as const } : {}) },
  };
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
  cover: Cover | null;
  addedAt: string;
  /** The edits a person made to it, already laid over the fields above; absent when nobody edited it. */
  edited?: SharedEdits;
}
