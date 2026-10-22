import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ScannedBook } from "../../../src/core/scan/scan.ts";
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

/** A book as the server keeps it in `book.json`: the scanner's record, with paths inside the book's own folder. */
export interface StoredBook extends ScannedBook {
  cover: Cover | null;
  /** The EPUB's size, when there is one: with the audio's, what a download needs room for. */
  ebookBytes?: number;
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
