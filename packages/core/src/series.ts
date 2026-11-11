import type { Book } from "./types";
import { compareBooks } from "./order";
import { parseNumbered } from "./scan/metadata";
import { bytesToRows, rowsToBytes, bool, int } from "./csv";

/**
 * A series is a run of books the listener wants to treat as one thing:
 * which belong, in what order, and which to leave out (the novellas,
 * usually). Ribbon finds a series only where the books say there is one:
 * a series tag, or folders the listener numbered. It never guesses one
 * from titles. The record beside the books is the listener's decision
 * and wins, and that goes for deleting a series too.
 */

export interface SeriesGroup {
  /** Stable id, safe as a file name. */
  key: string;
  name: string;
  /** Members in detected order, then the ones the listener added. */
  bookIds: string[];
  /** Members the listener added by hand rather than detection found. */
  added?: string[];
  /** Each member's number in the series, by book id, where its tags, folder or title give one. */
  numbers?: Record<string, number>;
  /** Titles as a list of the series shows them, by book id: without the series' name or a number the list already shows. */
  titles?: Record<string, string>;
}

export interface SeriesChoice {
  bookId: string;
  /** False leaves the book off the shelf (a novella you will not listen to). */
  included: boolean;
  /** 1-based position among the included and excluded alike. */
  order: number;
  /** The book's number in the series when the listener set one: 2.5 sits between 2 and 3. */
  number?: number;
  /** True takes the book out of this series altogether, without hiding it. */
  removed?: boolean;
}

export interface SeriesRecord {
  key: string;
  name: string;
  choices: SeriesChoice[];
  /** ISO 8601; set when the listener saved or skipped the setup. */
  decidedAt: string;
  /** True when the listener deleted the series: it has no books, and the books' tags and folders don't bring it back. */
  deleted?: boolean;
}

/** Fewer than this and it is a shelf, not a series. */
export const MIN_SERIES_BOOKS = 3;

export function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "series"
  );
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Series worth setting up. A series tag groups books wherever they
 * live; otherwise numbered folders under one parent form a series named
 * by that parent, or by the library folder when they sit at the root.
 * Titles are never read for a series: "…, Book 7" is a store's wording,
 * and guessing from it made series nobody asked for. Members come back
 * by their number in the series, then in folder order.
 */
export function detectSeries(books: readonly Book[], libraryName: string): SeriesGroup[] {
  const groups = new Map<string, { name: string; members: { book: Book; title: string | null }[] }>();
  for (const b of books) {
    let name: string;
    let scope: string;
    if (b.series.trim()) {
      name = b.series.trim();
      scope = "tag";
    } else if (b.seriesIndex !== null) {
      const parent = parentOf(b.path);
      name = parent ? baseName(parent) : libraryName;
      scope = `folder:${parent}`;
    } else {
      continue;
    }
    // "04. Flight of the Eisenstein" is Flight of the Eisenstein under its number 4.
    const prefixed = b.seriesIndex !== null ? parseNumbered(b.title) : null;
    const title = prefixed && prefixed.index === b.seriesIndex ? prefixed.name : null;
    const groupKey = `${scope}|${name.toLowerCase()}`;
    const g = groups.get(groupKey) ?? { name, members: [] };
    g.members.push({ book: b, title });
    groups.set(groupKey, g);
  }
  const out: SeriesGroup[] = [];
  const used = new Set<string>();
  for (const [scopeKey, g] of groups) {
    if (g.members.length < MIN_SERIES_BOOKS) continue;
    let key = slug(g.name);
    if (used.has(key)) key = `${key}-${slug(scopeKey)}`;
    used.add(key);
    // Numbered books by their number, then the rest in folder order.
    const members = [...g.members].sort((x, y) => (x.book.seriesIndex ?? Infinity) - (y.book.seriesIndex ?? Infinity) || compareBooks(x.book, y.book));
    const group: SeriesGroup = { key, name: g.name, bookIds: members.map((m) => m.book.id) };
    const numbered = members.filter((m) => m.book.seriesIndex !== null);
    if (numbered.length > 0) group.numbers = Object.fromEntries(numbered.map((m) => [m.book.id, m.book.seriesIndex!]));
    const retitled = members.filter((m) => m.title);
    if (retitled.length > 0) group.titles = Object.fromEntries(retitled.map((m) => [m.book.id, m.title!]));
    out.push(group);
  }
  return out;
}

/** A key no other series has: the name's slug, numbered when taken. */
export function uniqueKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const key = `${base}-${n}`;
    if (!used.has(key)) return key;
  }
}

/** A series made by hand: these books, in this order, all on the shelf. */
export function newSeriesRecord(key: string, name: string, bookIds: readonly string[], decidedAt = new Date().toISOString()): SeriesRecord {
  return { key, name: name.trim(), decidedAt, choices: bookIds.map((bookId, i) => ({ bookId, included: true, order: i + 1 })) };
}

/** The record of a series the listener deleted: no books, only that it's gone, so it isn't found again. */
export function deletedSeriesRecord(key: string, name: string, decidedAt = new Date().toISOString()): SeriesRecord {
  return { key, name, decidedAt, choices: [], deleted: true };
}

/** True for a series detection did not find: every member was added by hand. */
export function isHandMade(g: SeriesGroup): boolean {
  return g.added !== undefined && g.added.length === g.bookIds.length;
}

/**
 * The series on the shelf: what detection found, plus what the records
 * say. A record can add books detection missed to a series it found,
 * and a record with no detected members is a series made by hand. A
 * series the listener deleted is not there, whatever detection found.
 * Members no longer on the shelf are left out.
 */
export function mergeSeries(detected: readonly SeriesGroup[], records: Iterable<SeriesRecord>, onShelf: ReadonlySet<string>): SeriesGroup[] {
  const byKey = new Map<string, SeriesGroup>();
  for (const g of detected) byKey.set(g.key, { ...g, bookIds: [...g.bookIds] });
  for (const r of records) {
    if (r.deleted) {
      byKey.delete(r.key);
      continue;
    }
    const ids = normalizeChoices(r.choices.filter((c) => !c.removed))
      .map((c) => c.bookId)
      .filter((id) => onShelf.has(id));
    const removed = new Set(r.choices.filter((c) => c.removed).map((c) => c.bookId));
    const have = byKey.get(r.key);
    if (have) {
      // The listener's name for a series it found, and its members minus the ones taken out.
      if (r.name.trim()) have.name = r.name.trim();
      if (removed.size > 0) {
        have.bookIds = have.bookIds.filter((id) => !removed.has(id));
        if (have.added) have.added = have.added.filter((id) => !removed.has(id));
      }
      const added = ids.filter((id) => !have.bookIds.includes(id));
      if (added.length > 0) {
        have.bookIds.push(...added);
        have.added = [...(have.added ?? []), ...added];
      }
    } else if (ids.length > 0) {
      byKey.set(r.key, { key: r.key, name: r.name, bookIds: ids, added: [...ids] });
    }
  }
  return [...byKey.values()];
}

/** The decisions to start from: everything in, in detected order. */
export function defaultChoices(group: SeriesGroup): SeriesChoice[] {
  return group.bookIds.map((bookId, i) => ({ bookId, included: true, order: i + 1 }));
}

/** Books to leave out because they are short: novellas, interludes, extras. */
export function excludeShorterThan(choices: readonly SeriesChoice[], durations: ReadonlyMap<string, number>, minMs: number): SeriesChoice[] {
  return choices.map((c) => ({ ...c, included: c.included && (durations.get(c.bookId) ?? 0) >= minMs }));
}

/** Orders made contiguous from 1, keeping the relative order given. */
export function normalizeChoices(choices: readonly SeriesChoice[]): SeriesChoice[] {
  return [...choices].sort((a, b) => a.order - b.order).map((c, i) => ({ ...c, order: i + 1 }));
}

/** Ids of every book a record leaves out. */
export function hiddenBookIds(records: Iterable<SeriesRecord>): Set<string> {
  const out = new Set<string>();
  for (const r of records) for (const c of r.choices) if (!c.included && !c.removed) out.add(c.bookId);
  return out;
}

/**
 * Books off the shelf, across every series: a book is off when each series
 * it's in leaves it out. A novella left out of The Horus Heresy but put in a
 * White Scars reading list is on the shelf. A series with no record leaves
 * nothing out.
 */
export function offTheShelf(groups: readonly SeriesGroup[], records: Readonly<Record<string, SeriesRecord>>): Set<string> {
  const left = new Set<string>();
  const kept = new Set<string>();
  for (const g of groups) {
    const record = records[g.key];
    const hidden = hiddenBookIds(record ? [record] : []);
    for (const id of g.bookIds) (hidden.has(id) ? left : kept).add(id);
  }
  return new Set([...left].filter((id) => !kept.has(id)));
}

/**
 * What to call a book's place in a series: the number the listener gave
 * it, else the one detection found (`SeriesGroup.numbers`), else its
 * position. "Siege of Terra, Book 8, Part 2" is book 8, not the ninth.
 */
export function seriesNumber(record: SeriesRecord | undefined, bookId: string, position: number, detected?: Readonly<Record<string, number>>): string {
  const n = record?.choices.find((c) => c.bookId === bookId)?.number ?? detected?.[bookId];
  return n !== undefined ? String(n) : String(position);
}

/**
 * Put choices in order after a number changed: a numbered book by its
 * number, the rest by the number detection found or their position,
 * which is the number they show. On a tie the book that was first
 * stays first.
 */
export function sortByNumber(choices: readonly SeriesChoice[], detected?: Readonly<Record<string, number>>): SeriesChoice[] {
  return normalizeChoices(choices)
    .map((c) => ({ c, k: c.number ?? detected?.[c.bookId] ?? c.order }))
    .sort((a, b) => a.k - b.k || a.c.order - b.c.order)
    .map(({ c }, i) => ({ ...c, order: i + 1 }));
}

/**
 * Apply saved series orders to a sorted shelf: the members of each
 * series keep the slots they already occupy, but fill them in the
 * record's order. Books outside any series do not move.
 */
export function orderBySeries<T>(sorted: readonly T[], idOf: (item: T) => string, records: Iterable<SeriesRecord>): T[] {
  const out = [...sorted];
  for (const r of records) {
    const rank = new Map(r.choices.filter((c) => !c.removed).map((c) => [c.bookId, c.order]));
    const slots: number[] = [];
    out.forEach((item, i) => {
      if (rank.has(idOf(item))) slots.push(i);
    });
    if (slots.length < 2) continue;
    const members = slots.map((i) => out[i]!).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
    slots.forEach((slot, k) => (out[slot] = members[k]!));
  }
  return out;
}

export const SERIES_HEADERS = ["series", "book_id", "included", "order", "decided_at", "number", "removed", "deleted"];

/** A record as its file: a row for each book, or, for a series the listener deleted, one row with no book that says so. */
export function seriesToBytes(r: SeriesRecord): Promise<Uint8Array> {
  if (r.deleted) return rowsToBytes([{ series: r.name, book_id: "", included: "", order: "", decided_at: r.decidedAt, number: "", removed: "", deleted: "1" }], SERIES_HEADERS);
  return rowsToBytes(
    r.choices.map((c) => ({ series: r.name, book_id: c.bookId, included: c.included ? "1" : "0", order: String(c.order), decided_at: r.decidedAt, number: c.number === undefined ? "" : String(c.number), removed: c.removed ? "1" : "", deleted: "" })),
    SERIES_HEADERS,
  );
}

export async function bytesToSeries(key: string, bytes: Uint8Array): Promise<SeriesRecord | null> {
  const { rows } = await bytesToRows(bytes);
  const choices: SeriesChoice[] = [];
  let name = "";
  let decidedAt = "";
  for (const r of rows) {
    if (bool(r.deleted)) return deletedSeriesRecord(key, r.series || "", r.decided_at || "");
    if (!r.book_id) continue;
    name = name || r.series || "";
    decidedAt = decidedAt || r.decided_at || "";
    const choice: SeriesChoice = { bookId: r.book_id, included: bool(r.included), order: int(r.order) };
    const n = r.number ? Number(r.number) : NaN;
    if (Number.isFinite(n)) choice.number = n;
    if (bool(r.removed)) choice.removed = true;
    choices.push(choice);
  }
  if (choices.length === 0) return null;
  return { key, name, choices: normalizeChoices(choices), decidedAt };
}
