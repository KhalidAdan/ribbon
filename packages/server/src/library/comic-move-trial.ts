import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { comicLabel, comicNamingOf, comicShape } from "@ribbon/core/comic-name";
import { editColumn, type EditField, type EditValues } from "@ribbon/core/edits";
import { openDatabase } from "../db.ts";
import { readStored } from "./book-folder.ts";
import { bookDir, BookIndex, editedStored } from "./books.ts";
import { readComicsAgain } from "./comic-details.ts";
import { COMIC_FILE, PDF_FILE } from "./comic.ts";

/**
 * The one-time move of comics' details (comic-details.ts), tried on a copy
 * of a server's data before it runs on the server itself
 * (docs/BOOK-DETAILS.md, section 6: "Before the server's move runs on the
 * owner's data, it runs on a copy of it"). It says what the move does to
 * every comic: its name, its byline, its series, what it is, its title, and
 * its edits, before and after.
 *
 * The server's data folder is only ever read. The copy is made beside it,
 * in a folder given for it:
 *
 * - **The database**, by SQLite's `VACUUM INTO`: a whole, consistent copy,
 *   even of a database a running server is writing to.
 * - **Each comic's folder**: its `book.json` copied, since the move writes
 *   it, and its comic's file linked to where it is, since the move only
 *   reads it (copied where this system can't link). No other book's folder
 *   is copied: the move touches comics only, and an audiobook's files are
 *   the size of the library.
 *
 * Then the move runs on the copy exactly as a server runs it when it starts
 * (`readComicsAgain`), and the copy is left as the move left it, to be
 * looked at further or started as a server of its own.
 */

/** What the move did to one comic: as every device was shown it before, and after. */
export interface TriedComic {
  id: string;
  before: Shown;
  /** Null when its file couldn't be read again: it is left as it was, and tried again at the server's next start. */
  after: (Shown & { is: string; title: string; label: string | null; place: number | null }) | null;
}

/** A comic as the library answer lists it: its name, its byline, its series and its number there, and a person's edits. */
interface Shown {
  name: string;
  by: string;
  series: string;
  number: number | null;
  edits: EditValues;
}

export interface Trial {
  comics: TriedComic[];
  /** How many comics were read again, and how many of those had edits that the move changed. */
  read: number;
  moved: number;
  /** What it says, line by line, as the command prints it. */
  lines: string[];
}

/** Copy a server's data folder's database and comics into `to` (a folder that is empty, or not there yet), move them there, and say what changed. */
export async function tryComicMove(from: string, to: string): Promise<Trial> {
  const source = path.resolve(from);
  const copy = path.resolve(to);
  if (copy === source || copy.startsWith(`${source}${path.sep}`)) throw new Error("Make the copy outside the server's data folder: nothing is ever written there.");
  if ((await readdir(copy).catch(() => [])).length > 0) throw new Error(`${copy} isn't empty: give a new folder for the copy.`);
  if (!(await stat(path.join(source, "ribbon.db")).catch(() => null))) throw new Error(`${source} has no ribbon.db: give the server's data folder (RIBBON_DATA).`);

  await mkdir(copy, { recursive: true });
  const original = openToRead(source);
  try {
    original.prepare("VACUUM INTO ?").run(path.join(copy, "ribbon.db"));
  } finally {
    original.close();
  }

  const db = openDatabase(copy);
  try {
    const index = new BookIndex(db);
    const ids = index
      .list()
      .filter((b) => b.comic)
      .map((b) => b.id);
    for (const id of ids) await copyComicFolder(source, copy, id);

    const before = new Map(ids.map((id) => [id, shownNow(index, id)]));
    const done = await readComicsAgain(copy, index);
    const unreadable = new Set(done.unreadable);
    const comics: TriedComic[] = [];
    for (const id of ids) comics.push({ id, before: before.get(id)!, after: unreadable.has(id) ? null : await shownAfter(copy, index, id) });
    comics.sort(bySeriesThenPlace);
    return { comics, read: done.read, moved: done.moved, lines: report(source, copy, comics, done.read, done.moved) };
  } finally {
    db.close();
  }
}

/**
 * A server's database, opened only to be read. With a server running on it
 * (its write-ahead log is there), as one more reader, whose consistent view
 * `VACUUM INTO` copies; with none, as a file that can't change, so SQLite
 * leaves nothing of its own beside it either (its `-wal` and `-shm` files).
 */
function openToRead(dataDir: string): DatabaseSync {
  const file = path.join(dataDir, "ribbon.db");
  if (existsSync(`${file}-wal`)) return new DatabaseSync(file, { readOnly: true });
  const still = pathToFileURL(file);
  still.searchParams.set("immutable", "1");
  return new DatabaseSync(still, { readOnly: true });
}

/** A comic's folder in the copy: its record copied, and its file linked to the original, or copied where that can't be. */
async function copyComicFolder(source: string, copy: string, id: string): Promise<void> {
  const from = bookDir(source, id);
  const to = bookDir(copy, id);
  await mkdir(to, { recursive: true });
  await copyFile(path.join(from, "book.json"), path.join(to, "book.json")).catch(() => undefined);
  for (const file of [COMIC_FILE, PDF_FILE]) {
    if (!(await stat(path.join(from, file)).catch(() => null))) continue;
    await symlink(path.join(from, file), path.join(to, file)).catch(() => copyFile(path.join(from, file), path.join(to, file)));
  }
}

/** A comic as the library answer lists it now. */
function shownNow(index: BookIndex, id: string): Shown {
  const listed = index.get(id)!;
  return { name: listed.title, by: listed.author, series: listed.series, number: listed.seriesIndex, edits: index.edits(id)?.values ?? {} };
}

/** A comic after the move: as it is listed, and its details as a book's page gives them (`GET /api/books/:id`). */
async function shownAfter(copy: string, index: BookIndex, id: string): Promise<NonNullable<TriedComic["after"]>> {
  const now = shownNow(index, id);
  const stored = await readStored(copy, id);
  const book = stored ? editedStored(stored, index.edits(id), null, index.hasDetails(id)).book : null;
  const naming = comicNamingOf(book ?? {});
  return { ...now, is: book ? shapeText(book) : "unknown: its book.json is missing", title: naming.title, label: comicLabel(naming), place: now.number };
}

/** What a comic is, with its numbers: "an issue: issue 10", "a collection: volume 1, collects 1–6", "a comic on its own". */
function shapeText(book: { issue?: string; volume?: string; collects?: string }): string {
  switch (comicShape(book)) {
    case "issue":
      return `an issue: issue ${book.issue}`;
    case "collection":
      return `a collection: ${[book.volume ? `volume ${book.volume}` : "", book.collects ? `collects ${book.collects}` : ""].filter(Boolean).join(", ")}`;
    case "alone":
      return "a comic on its own";
  }
}

function bySeriesThenPlace(a: TriedComic, b: TriedComic): number {
  const x = a.after ?? a.before;
  const y = b.after ?? b.before;
  return x.series.localeCompare(y.series) || (x.number ?? Infinity) - (y.number ?? Infinity) || x.name.localeCompare(y.name);
}

/** What the trial says: each comic before and after, then how many. */
function report(source: string, copy: string, comics: readonly TriedComic[], read: number, moved: number): string[] {
  const lines = [`The move of comics' details, tried on a copy of ${source} in ${copy}. Nothing was written to ${source}.`, ""];
  for (const comic of comics) {
    const { before, after } = comic;
    lines.push(`${(after ?? before).name}  (${comic.id})`);
    lines.push(`  before  name    ${before.name}`);
    lines.push(`          by      ${before.by || "nobody"}`);
    lines.push(`          series  ${seriesText(before.series, before.number === null ? null : `number ${before.number}`)}`);
    lines.push(`          edits   ${editsText(before.edits)}`);
    if (!after) {
      lines.push("  after   its file couldn't be read again: left as it was, to be tried again at the next start", "");
      continue;
    }
    lines.push(`  after   name    ${after.name}`);
    lines.push(`          by      ${after.by || "nobody"}${after.edits.author !== undefined ? " (a byline kept from before)" : ""}`);
    lines.push(`          series  ${seriesText(after.series, after.label ? `${after.label}, in place ${after.place ?? "none"}` : after.place === null ? null : `in place ${after.place}`)}`);
    lines.push(`          is      ${after.is}`);
    lines.push(`          title   ${after.title || "none of its own"}`);
    lines.push(`          edits   ${editsText(after.edits)}`);
    lines.push("");
  }
  const unread = comics.filter((c) => !c.after).length;
  lines.push(`${comics.length} comics: ${read} read again, and the edits of ${moved} moved; ${unread} couldn't be read.`);
  return lines;
}

function seriesText(series: string, where: string | null): string {
  if (!series) return "none";
  return where ? `${series}, ${where}` : series;
}

/** A comic's edits by the names the edits' CSV gives them, each value in quotes, a long one cut short. */
function editsText(edits: EditValues): string {
  const fields = Object.keys(edits) as EditField[];
  if (fields.length === 0) return "none";
  return fields.map((f) => `${editColumn(f)} ${JSON.stringify(cut(edits[f]!))}`).join("; ");
}

function cut(text: string): string {
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}
