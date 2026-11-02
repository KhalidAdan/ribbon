import type { Book } from "./types";
import { compareBooks } from "./order";
import { parseNumbered } from "./scan/metadata";
import { bytesToRows, rowsToBytes, bool, int } from "./csv";

/**
 * A series is a run of books the listener wants to treat as one thing:
 * which belong, in what order, and which to leave out (the novellas,
 * usually). Detection is a guess from tags and folder numbers; the
 * record beside the books is the listener's decision and wins.
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
 * by that parent, or by the library folder when they sit at the root;
 * otherwise a series named in the titles, the way stores write it
 * (seriesInTitles). Members come back by their number in the series,
 * then in folder order.
 */
export function detectSeries(books: readonly Book[], libraryName: string): SeriesGroup[] {
  const titled = seriesInTitles(books.filter((b) => !b.series.trim() && b.seriesIndex === null));
  const groups = new Map<string, { name: string; key: string | null; members: { book: Book; number: number | null; part: number; title: string | null }[] }>();
  for (const b of books) {
    let name: string;
    let scope: string;
    let key: string | null = null;
    let number = b.seriesIndex;
    let part = 0;
    let title: string | null = null;
    const t = titled.get(b.id);
    if (b.series.trim()) {
      name = b.series.trim();
      scope = "tag";
    } else if (b.seriesIndex !== null) {
      const parent = parentOf(b.path);
      name = parent ? baseName(parent) : libraryName;
      scope = `folder:${parent}`;
    } else if (t) {
      ({ name, number, part } = t);
      scope = `title:${t.names}`;
      // From the names in any order: the order most titles use can change as books arrive, and the key is a file name.
      key = slug(t.names);
      title = t.title || null;
    } else {
      continue;
    }
    // "04. Flight of the Eisenstein" is Flight of the Eisenstein under its number 4.
    const prefixed = title === null && number !== null ? parseNumbered(b.title) : null;
    if (prefixed && prefixed.index === number) title = prefixed.name;
    const groupKey = `${scope}|${name.toLowerCase()}`;
    const g = groups.get(groupKey) ?? { name, key, members: [] };
    g.members.push({ book: b, number, part, title });
    groups.set(groupKey, g);
  }
  const out: SeriesGroup[] = [];
  const used = new Set<string>();
  for (const [scopeKey, g] of groups) {
    if (g.members.length < MIN_SERIES_BOOKS) continue;
    let key = g.key ?? slug(g.name);
    if (used.has(key)) key = `${key}-${slug(scopeKey)}`;
    used.add(key);
    // Numbered books by their number (a book in parts by its part), then the rest in folder order.
    const members = [...g.members].sort((x, y) => (x.number ?? Infinity) - (y.number ?? Infinity) || x.part - y.part || compareBooks(x.book, y.book));
    const group: SeriesGroup = { key, name: g.name, bookIds: members.map((m) => m.book.id) };
    const numbered = members.filter((m) => m.number !== null);
    if (numbered.length > 0) group.numbers = Object.fromEntries(numbered.map((m) => [m.book.id, m.number!]));
    const retitled = members.filter((m) => m.title);
    if (retitled.length > 0) group.titles = Object.fromEntries(retitled.map((m) => [m.book.id, m.title!]));
    out.push(group);
  }
  return out;
}

/** A book's title, read for the series it names: see parseSeriesTitle. */
export interface SeriesTitle {
  /** The title before the book's number, split at its colons. */
  parts: string[];
  /** How many parts at the start are the book's own title, not a series' name: 1, or 0 when the title is only the series. */
  own: number;
  /** The book's number in the series: 8 in "Book 8". */
  number: number;
  /** "Book 8, Part 2" is a book in parts; 0 when it is not. */
  part: number;
}

/** "…, Book 8" at the end, or "…, Book 8, Part 2". */
const TRAILING_BOOK = /^(.+?),?\s+Book\s+(\d+(?:\.\d+)?)(?:,?\s+Part\s+(\d+))?$/i;
/** "Leviathan Wakes (The Expanse, Book 1)", or "(The Expanse #1)". */
const BOOK_IN_BRACKETS = /^(.+?)\s*\(([^()]+?),?\s+(?:Book\s+|#)(\d+(?:\.\d+)?)\)$/i;

/**
 * What a title says about its series, the way stores write it:
 * "The Solar War: Siege of Terra: The Horus Heresy, Book 1", or
 * "Leviathan Wakes (The Expanse, Book 1)". Which parts name the series
 * is clear only across several books, since "The End and the Death:
 * Volume I: The Horus Heresy: Siege of Terra, Book 8" carries a volume
 * as well; seriesInTitles decides. Null when the title has no number.
 */
export function parseSeriesTitle(title: string): SeriesTitle | null {
  const text = title.trim();
  const bracketed = BOOK_IN_BRACKETS.exec(text);
  if (bracketed) {
    const names = splitColons(bracketed[2]!);
    return names.length > 0 ? { parts: [bracketed[1]!.trim(), ...names], own: 1, number: Number(bracketed[3]), part: 0 } : null;
  }
  const trailing = TRAILING_BOOK.exec(text);
  if (!trailing) return null;
  const parts = splitColons(trailing[1]!);
  if (parts.length === 0) return null;
  return { parts, own: parts.length > 1 ? 1 : 0, number: Number(trailing[2]), part: trailing[3] ? Number(trailing[3]) : 0 };
}

function splitColons(text: string): string[] {
  return text
    .split(/\s*:\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A book's series as its title names it, decided across the shelf. */
export interface TitledSeries {
  name: string;
  /** The series' names, lower case, sorted and joined: the same series whichever order a title puts them in. */
  names: string;
  number: number;
  part: number;
  /** The title without the series' names: "The End and the Death: Volume I". Empty when the title is only the series. */
  title: string;
}

/**
 * Series named in titles, by book id. A part of a title names a series
 * when at least MIN_SERIES_BOOKS titles carry it; the rest is the book's
 * own. Titles that carry the same names, in any order, are one series:
 * "Siege of Terra: The Horus Heresy, Book 4" and "The Horus Heresy:
 * Siege of Terra, Book 5". The series takes its name in the order most
 * of its titles use.
 */
export function seriesInTitles(books: readonly Book[]): Map<string, TitledSeries> {
  const parsed = books.flatMap((b) => {
    const t = parseSeriesTitle(b.title);
    return t ? [{ id: b.id, ...t }] : [];
  });
  const carried = new Map<string, number>();
  for (const t of parsed) for (const p of new Set(t.parts.slice(t.own).map((x) => x.toLowerCase()))) carried.set(p, (carried.get(p) ?? 0) + 1);

  const found = parsed.flatMap((t) => {
    const isName = (p: string, i: number) => i >= t.own && (carried.get(p.toLowerCase()) ?? 0) >= MIN_SERIES_BOOKS;
    const names = t.parts.filter(isName);
    if (names.length === 0) return [];
    const own = t.parts.filter((p, i) => !isName(p, i)).join(": ");
    return [{ id: t.id, names: names.map((n) => n.toLowerCase()).sort().join(" "), spelled: names.join(": "), number: t.number, part: t.part, title: own }];
  });

  // The spelling of each series' name that most of its titles use; on a tie, the first in A to Z.
  const spellings = new Map<string, Map<string, number>>();
  for (const f of found) {
    const counts = spellings.get(f.names) ?? new Map<string, number>();
    counts.set(f.spelled, (counts.get(f.spelled) ?? 0) + 1);
    spellings.set(f.names, counts);
  }
  const nameOf = (names: string) => [...spellings.get(names)!].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];

  return new Map(found.map((f) => [f.id, { name: nameOf(f.names), names: f.names, number: f.number, part: f.part, title: f.title }]));
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

/** True for a series detection did not find: every member was added by hand. */
export function isHandMade(g: SeriesGroup): boolean {
  return g.added !== undefined && g.added.length === g.bookIds.length;
}

/**
 * The series on the shelf: what detection found, plus what the records
 * say. A record can add books detection missed to a series it found,
 * and a record with no detected members is a series made by hand.
 * Members no longer on the shelf are left out.
 */
export function mergeSeries(detected: readonly SeriesGroup[], records: Iterable<SeriesRecord>, onShelf: ReadonlySet<string>): SeriesGroup[] {
  const byKey = new Map<string, SeriesGroup>();
  for (const g of detected) byKey.set(g.key, { ...g, bookIds: [...g.bookIds] });
  for (const r of records) {
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

export const SERIES_HEADERS = ["series", "book_id", "included", "order", "decided_at", "number", "removed"];

export function seriesToBytes(r: SeriesRecord): Promise<Uint8Array> {
  return rowsToBytes(
    r.choices.map((c) => ({ series: r.name, book_id: c.bookId, included: c.included ? "1" : "0", order: String(c.order), decided_at: r.decidedAt, number: c.number === undefined ? "" : String(c.number), removed: c.removed ? "1" : "" })),
    SERIES_HEADERS,
  );
}

export async function bytesToSeries(key: string, bytes: Uint8Array): Promise<SeriesRecord | null> {
  const { rows } = await bytesToRows(bytes);
  const choices: SeriesChoice[] = [];
  let name = "";
  let decidedAt = "";
  for (const r of rows) {
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
