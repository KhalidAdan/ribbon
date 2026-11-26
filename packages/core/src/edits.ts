import { ROLES, type Book, type Credits, type Role } from "./types";
import { bytesToRows, rowsToBytes, type Row } from "./csv";
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
 *
 * And one is a comic's own: `rightToLeft`, which way its pages turn
 * (docs/COMICS.md, section 15). A comic's ComicInfo.xml may say it reads
 * right to left; the edit says it does, or that it doesn't, over whatever
 * the file says, and taken back the comic reads as its file says again.
 * It is a switch in the edit form, kept as "yes" or "no" (`SWITCH_ON`).
 *
 * The rest of a comic's own details are edits too (docs/BOOK-DETAILS.md,
 * section 4): its issue, or its volume and the issues it collects; its
 * people, one field to a role, names apart by semicolons; its imprint,
 * cover date ("2024-07", or "2024"), day on sale and story arcs. A comic's
 * title is the story's own name (types.ts, `rawTitle`), and its name on
 * the shelf is made from these after they are laid over it
 * (comic-name.ts). A text's translators are a role's edit, as a comic's
 * are. A comic's ComicVine address is never an edit: it comes from its
 * file or a match.
 *
 * A row this version doesn't know, written by a newer Ribbon sharing the
 * folder, is kept as it was found and written back with the rest
 * (`unknownRows`), so saving here never loses what a newer version said.
 */

export const EDIT_FIELDS = [
  "title",
  "subtitle",
  "author",
  "narrator",
  "series",
  "seriesIndex",
  "year",
  "genres",
  "publisher",
  "language",
  "isbn",
  "asin",
  "description",
  "cover",
  "readAlong",
  "rightToLeft",
  "issue",
  "volume",
  "collects",
  ...ROLES,
  "imprint",
  "coverDate",
  "onSale",
  "storyArcs",
] as const;

export type EditField = (typeof EDIT_FIELDS)[number];

export type EditValues = Partial<Record<EditField, string>>;

export interface BookEdits {
  bookId: string;
  values: EditValues;
  /** ISO time of the last change. */
  updatedAt: string;
  /**
   * Rows for fields this version doesn't know, as they were found: a newer
   * Ribbon's, sharing the folder. Written back with the rest, field, value
   * and time unchanged, so they outlive a save here (docs/BOOK-DETAILS.md,
   * section 4, "Fields a version doesn't know"). Absent when there are none.
   */
  unknownRows?: Row[];
}

/** Edits about to be saved, with the rows this version doesn't know from the edits they replace: a save keeps them, whatever else it changes. */
export function withUnknownRows(edits: BookEdits, before: Pick<BookEdits, "unknownRows"> | null | undefined): BookEdits {
  const { unknownRows: _own, ...rest } = edits;
  return before?.unknownRows?.length ? { ...rest, unknownRows: before.unknownRows } : rest;
}

/** Whether a book's edits hold anything to keep: an edit, or a row a newer version wrote. */
export function hasEdits(edits: BookEdits): boolean {
  return Object.keys(edits.values).length > 0 || (edits.unknownRows?.length ?? 0) > 0;
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
 * A switch's edit, as the edit form keeps it (edit-form.ts, `switch`): on
 * or off, whatever the files say. `rightToLeft` is one; read-along, which
 * came first, keeps its own words.
 */
export const SWITCH_ON = "yes";
export const SWITCH_OFF = "no";

/** A switch's edit for on, or for off. */
export function switchText(on: boolean): string {
  return on ? SWITCH_ON : SWITCH_OFF;
}

/**
 * The fields of a book a server keeps as text: all but the cover, which
 * goes to it as a picture. Read-along turned back on is no edit at all, so
 * it isn't kept as an empty one; nor is a direction that says neither way.
 */
export function sharedEdits(values: EditValues): EditValues {
  const { cover: _here, readAlong: _switch, rightToLeft: direction, ...shared } = values;
  return {
    ...shared,
    ...(readAlongOff(values) ? { readAlong: READ_ALONG_OFF } : {}),
    ...(direction === SWITCH_ON || direction === SWITCH_OFF ? { rightToLeft: direction } : {}),
  };
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
  rightToLeft: "right_to_left",
  issue: "issue",
  volume: "volume",
  collects: "collects",
  writers: "writers",
  pencils: "pencils",
  inks: "inks",
  colours: "colours",
  letters: "letters",
  coverArtists: "cover_artists",
  editors: "editors",
  translators: "translators",
  imprint: "imprint",
  coverDate: "cover_date",
  onSale: "on_sale",
  storyArcs: "story_arcs",
};
const FIELD_OF = new Map(Object.entries(COLUMN).map(([f, c]) => [c, f as EditField]));

/** A field's name in the edits' CSV, which every version reads: `coverArtists` is `cover_artists`. The MCP's names for a comic's details are these (docs/BOOK-DETAILS.md, section 5). */
export function editColumn(f: EditField): string {
  return COLUMN[f];
}

/** The field a column of the edits' CSV is, or null for one this version doesn't know. */
export function editFieldOf(column: string): EditField | null {
  return FIELD_OF.get(column.trim()) ?? null;
}

export function editsToBytes(e: BookEdits): Promise<Uint8Array> {
  return rowsToBytes(
    [...EDIT_FIELDS.filter((f) => e.values[f] !== undefined).map((f) => ({ field: COLUMN[f], value: e.values[f]!, updated_at: e.updatedAt })), ...(e.unknownRows ?? [])],
    EDIT_HEADERS,
  );
}

export async function bytesToEdits(bookId: string, bytes: Uint8Array): Promise<BookEdits> {
  const { rows } = await bytesToRows(bytes);
  const values: EditValues = {};
  const unknownRows: Row[] = [];
  let updatedAt = "";
  for (const r of rows) {
    const f = FIELD_OF.get((r.field ?? "").trim());
    if (!f) {
      // A field a newer version wrote: kept as it is, to be written back.
      if (r.field?.trim()) unknownRows.push({ field: r.field, value: r.value ?? "", updated_at: r.updated_at ?? "" });
      continue;
    }
    values[f] = r.value ?? "";
    if ((r.updated_at ?? "") > updatedAt) updatedAt = r.updated_at ?? "";
  }
  return { bookId, values, updatedAt, ...(unknownRows.length > 0 ? { unknownRows } : {}) };
}

/** Whether a field is one of a book's credits: a role, its names apart by semicolons. */
export function isRoleField(f: EditField): f is Role {
  return (ROLES as readonly string[]).includes(f);
}

/** Names, or story arcs, as a form gives them: apart by semicolons, each once. A comma may be part of a name ("Lee, Stan"). */
export function splitNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of text.split(";").map((n) => n.trim())) {
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A cover date as a comic keeps it, "2024-07" or "2024", from what a
 * person types: "2024-07", "2024-7", "2024/07", "July 2024", "7/2024",
 * "2024". A day, "2024-07-10", is more than a cover date holds and is left
 * off. Null for anything else.
 */
export function coverDateFrom(text: string): string | null {
  const t = text.trim();
  const withMonth = (month: number, year: string) => (month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : null);
  const year = t.match(/^(\d{4})$/);
  if (year) return year[1]!;
  const yearFirst = t.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  if (yearFirst) return withMonth(Number(yearFirst[2]), yearFirst[1]!);
  const monthFirst = t.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (monthFirst) return withMonth(Number(monthFirst[1]), monthFirst[2]!);
  const named = t.match(/^([a-z]+)\.?,?\s+(\d{4})$/i);
  if (named) return withMonth(MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1, named[2]!);
  return null;
}

/** A book field as the text a form shows. A comic's title is the story's own name, not the name the shelf makes from it (types.ts, `rawTitle`). */
export function fieldText(book: Book, f: EditField): string {
  if (isRoleField(f)) return (book.credits?.[f] ?? []).join("; ");
  switch (f) {
    case "title":
      return book.comic ? book.rawTitle : book.title;
    case "seriesIndex":
      return book.seriesIndex === null ? "" : String(book.seriesIndex);
    case "year":
      return book.year === null ? "" : String(book.year);
    case "genres":
      return (book.genres ?? []).join(", ");
    case "storyArcs":
      return (book.storyArcs ?? []).join("; ");
    case "rightToLeft":
      return switchText(book.rightToLeft === true);
    default:
      return (book[f] as string | undefined) ?? "";
  }
}

/**
 * The book with the edits laid over it. An edit to an empty string means
 * "this field is empty", which is different from no edit at all. Any part
 * of a book will do: a server's answer gives some of its fields.
 *
 * A comic's name isn't made here: a host names it after (comic-name.ts,
 * `namedComic`), where it has the comic's details to name it from.
 */
export function applyEdits<B extends Partial<Book>>(book: B, values: EditValues): B {
  const out: Partial<Book> = { ...book };
  for (const f of EDIT_FIELDS) {
    const v = values[f];
    if (v === undefined) continue;
    const t = v.trim();
    if (isRoleField(f)) {
      const credits = withRole(out.credits, f, splitNames(t));
      if (Object.keys(credits).length > 0) out.credits = credits;
      else delete out.credits;
      continue;
    }
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
        // A comic's title is the story's own name, and it may have none: the shelf names it by its series and number.
        if (out.comic) out.rawTitle = t;
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
      case "rightToLeft":
        // Either way stands over what the file says; an edit that says neither leaves the comic as its file has it.
        if (t === SWITCH_ON) out.rightToLeft = true;
        else if (t === SWITCH_OFF) delete out.rightToLeft;
        break;
      case "issue":
      case "volume":
      case "collects":
      case "imprint":
      case "onSale":
        // Emptied, a comic has none: a file's issue number doesn't come back once a person has said it is a collection.
        if (t) out[f] = t;
        else delete out[f];
        break;
      case "coverDate": {
        const date = coverDateFrom(t);
        if (date) out.coverDate = date;
        else delete out.coverDate;
        break;
      }
      case "storyArcs": {
        const arcs = splitNames(t);
        if (arcs.length > 0) out.storyArcs = arcs;
        else delete out.storyArcs;
        break;
      }
      default:
        (out as unknown as Record<string, string>)[f] = t;
    }
  }
  return out as B;
}

/** Credits with one role's names in place of the ones it had; no names takes the role away. */
function withRole(credits: Credits | undefined, role: Role, names: string[]): Credits {
  const { [role]: _was, ...rest } = credits ?? {};
  return names.length > 0 ? { ...rest, [role]: names } : rest;
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

/** A field's text as it is compared: two that say the same are no change, however they are written. */
function normalize(f: EditField, v: string): string {
  const t = v.trim();
  if (f === "genres") return splitList(t).join("\n").toLowerCase();
  if (isRoleField(f) || f === "storyArcs") return splitNames(t).join("\n");
  if (f === "coverDate") return coverDateFrom(t) ?? t;
  if (f === "seriesIndex" || f === "year") return t === "" ? "" : String(Number(t));
  return t.replace(/\r\n/g, "\n");
}
