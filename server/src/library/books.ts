import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
import type { LoudnessMeasurement, SilenceRange } from "../../../src/core/types.ts";
import type { Cover } from "./covers.ts";

/**
 * Where a book's files live on the server: `books/<id>/` in its data
 * folder, with its audio under `audio/`, its EPUB as `book.epub`, its
 * covers under `covers/`, and its record as `book.json` (docs/SERVER.md,
 * section 5).
 */
export function bookDir(dataDir: string, id: string): string {
  return path.join(dataDir, "books", id);
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
    return this.db.prepare("SELECT * FROM book ORDER BY added_at, id").all().map((row) => ({
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
    }));
  }

  /** Whether a book is on the server. */
  has(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM book WHERE id = ?").get(id);
  }

  /** The book whose covers are named by this hash, or null. */
  byCover(hash: string): string | null {
    const row = this.db.prepare("SELECT id FROM book WHERE cover_hash = ?").get(hash);
    return row ? String(row.id) : null;
  }
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
}
