import type { Book } from "./types";
import { bytesToRows, rowsToBytes } from "./csv";
import { splitList } from "./scan/sidefiles";

/**
 * Corrections a listener makes to a book's details, kept beside the books
 * in `.ribbon/edits/<id>.csv`, one row per field, and for a server's book
 * on the server too, so every device shows them (SharedEdits). They lay
 * over what the files and side files say, field by field, and each can be
 * taken back on its own. The audio files are never touched.
 *
 * One of them isn't a detail of the book but a choice about it:
 * `readAlong`, "off" for a book whose read-along will never work (a
 * different edition, a recording that strays from the text). It's kept
 * here because it's kept the same way, beside the book or on the server,
 * and a switch rather than a deletion: the book's transcript stays, so
 * turning it back on costs nothing.
 */

export const EDIT_FIELDS = ["title", "subtitle", "author", "narrator", "series", "seriesIndex", "year", "genres", "publisher", "language", "isbn", "asin", "description", "cover", "readAlong"] as const;

export type EditField = (typeof EDIT_FIELDS)[number];

export type EditValues = Partial<Record<EditField, string>>;

export interface BookEdits {
  bookId: string;
  values: EditValues;
  /** ISO time of the last change. */
  updatedAt: string;
}

/**
 * A book's edits as a Ribbon server keeps them, for every device
 * (packages/server/src/library/books.ts): the fields as edited, what the book's files
 * say for each (what taking an edit back returns to), and when the server
 * took them. The server lists and serves its books with the edits laid over
 * them, so every device shows them as edited.
 */
export interface SharedEdits {
  values: EditValues;
  original: EditValues;
  updatedAt: string;
  /** A person chose the book's cover: the cover it's listed with is that picture, kept on the server. */
  chosenCover?: true;
}

/** The one value of the `readAlong` edit that means anything: read-along is off for the book. */
export const READ_ALONG_OFF = "off";

/** Whether read-along is turned off, for a book or for its edits: both say it the same way. */
export function readAlongOff(of: { readAlong?: string } | null | undefined): boolean {
  return of?.readAlong === READ_ALONG_OFF;
}

/**
 * The fields of a book a server keeps as text: all but the cover, which
 * goes to it as a picture. Read-along turned back on is no edit at all, so
 * it isn't kept as an empty one.
 */
export function sharedEdits(values: EditValues): EditValues {
  const { cover: _here, readAlong: _switch, ...shared } = values;
  return readAlongOff(values) ? { ...shared, readAlong: READ_ALONG_OFF } : shared;
}


/** What a book's files say for each field the edits change, as the edit form shows it. */
export function originalOf(book: Book, values: EditValues): EditValues {
  return Object.fromEntries(EDIT_FIELDS.filter((f) => values[f] !== undefined).map((f) => [f, fieldText(book, f)]));
}

export const EDIT_HEADERS = ["field", "value", "updated_at"];

const COLUMN: Record<EditField, string> = {
  title: "title",
  subtitle: "subtitle",
  author: "author",
  narrator: "narrator",
  series: "series",
  seriesIndex: "series_index",
  year: "year",
  genres: "genres",
  publisher: "publisher",
  language: "language",
  isbn: "isbn",
  asin: "asin",
  description: "description",
  cover: "cover",
  readAlong: "read_along",
};
const FIELD_OF = new Map(Object.entries(COLUMN).map(([f, c]) => [c, f as EditField]));

export function editsToBytes(e: BookEdits): Promise<Uint8Array> {
  return rowsToBytes(
    EDIT_FIELDS.filter((f) => e.values[f] !== undefined).map((f) => ({ field: COLUMN[f], value: e.values[f]!, updated_at: e.updatedAt })),
    EDIT_HEADERS,
  );
}

export async function bytesToEdits(bookId: string, bytes: Uint8Array): Promise<BookEdits> {
  const { rows } = await bytesToRows(bytes);
  const values: EditValues = {};
  let updatedAt = "";
  for (const r of rows) {
    const f = FIELD_OF.get((r.field ?? "").trim());
    if (!f) continue;
    values[f] = r.value ?? "";
    if ((r.updated_at ?? "") > updatedAt) updatedAt = r.updated_at ?? "";
  }
  return { bookId, values, updatedAt };
}

/** A book field as the text a form shows. */
export function fieldText(book: Book, f: EditField): string {
  switch (f) {
    case "seriesIndex":
      return book.seriesIndex === null ? "" : String(book.seriesIndex);
    case "year":
      return book.year === null ? "" : String(book.year);
    case "genres":
      return (book.genres ?? []).join(", ");
    default:
      return (book[f] as string | undefined) ?? "";
  }
}

/**
 * The book with the edits laid over it. An edit to an empty string means
 * "this field is empty", which is different from no edit at all. Any part
 * of a book will do: a server's answer gives some of its fields.
 */
export function applyEdits<B extends Partial<Book>>(book: B, values: EditValues): B {
  const out: Partial<Book> = { ...book };
  for (const f of EDIT_FIELDS) {
    const v = values[f];
    if (v === undefined) continue;
    const t = v.trim();
    switch (f) {
      case "seriesIndex": {
        const n = Number(t);
        out.seriesIndex = t && Number.isFinite(n) ? n : null;
        break;
      }
      case "year": {
        const n = Number(t);
        out.year = /^\d{1,4}$/.test(t) && Number.isFinite(n) ? n : null;
        break;
      }
      case "genres":
        out.genres = splitList(t);
        break;
      case "title":
        // A book always has a title; an emptied one falls back to the files'.
        if (t) {
          out.title = t;
          out.rawTitle = t;
        }
        break;
      case "cover":
        if (t) out.cover = t;
        break;
      case "readAlong":
        // Off or nothing: anything else, an empty edit included, leaves the book reading along.
        if (t === READ_ALONG_OFF) out.readAlong = READ_ALONG_OFF;
        else delete out.readAlong;
        break;
      default:
        (out as unknown as Record<string, string>)[f] = t;
    }
  }
  return out as B;
}

/**
 * The fields a form changed from the book as it was shown, as the form has
 * them: what a server's book's edit sends, whatever the files say.
 */
export function changedFields(shown: Book, form: Partial<Record<EditField, string>>): EditValues {
  const out: EditValues = {};
  for (const f of EDIT_FIELDS) {
    const v = form[f];
    if (f !== "cover" && v !== undefined && normalize(f, v) !== normalize(f, fieldText(shown, f))) out[f] = v.trim();
  }
  return out;
}

/**
 * The edits a form produces for a book in a folder: only fields that differ
 * from what the files say, so a field changed back to the original stops
 * being an edit.
 */
export function diffEdits(original: Book, form: Partial<Record<EditField, string>>, previous: EditValues = {}): EditValues {
  const out: EditValues = {};
  for (const f of EDIT_FIELDS) {
    if (f === "cover") {
      if (previous.cover !== undefined && form.cover === undefined) out.cover = previous.cover;
      else if (form.cover) out.cover = form.cover;
      continue;
    }
    const v = form[f];
    // A field the form does not mention keeps whatever edit it had.
    if (v === undefined) {
      if (previous[f] !== undefined) out[f] = previous[f];
      continue;
    }
    if (normalize(f, v) !== normalize(f, fieldText(original, f))) out[f] = v.trim();
  }
  return out;
}

function normalize(f: EditField, v: string): string {
  const t = v.trim();
  if (f === "genres") return splitList(t).join("\n").toLowerCase();
  if (f === "seriesIndex" || f === "year") return t === "" ? "" : String(Number(t));
  return t.replace(/\r\n/g, "\n");
}
