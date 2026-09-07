import type { Book } from "./types";
import { compareBooks } from "./order";
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
}

export interface SeriesChoice {
  bookId: string;
  included: boolean;
  /** 1-based position among the included and excluded alike. */
  order: number;
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
 * by that parent, or by the library folder when they sit at the root.
 * Members come back in folder order.
 */
export function detectSeries(books: readonly Book[], libraryName: string): SeriesGroup[] {
  const groups = new Map<string, { name: string; books: Book[] }>();
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
    const key = `${scope}|${name.toLowerCase()}`;
    const g = groups.get(key) ?? { name, books: [] };
    g.books.push(b);
    groups.set(key, g);
  }
  const out: SeriesGroup[] = [];
  const used = new Set<string>();
  for (const [scopeKey, g] of groups) {
    if (g.books.length < MIN_SERIES_BOOKS) continue;
    let key = slug(g.name);
    if (used.has(key)) key = `${key}-${slug(scopeKey)}`;
    used.add(key);
    out.push({ key, name: g.name, bookIds: [...g.books].sort(compareBooks).map((b) => b.id) });
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
    const ids = normalizeChoices(r.choices)
      .map((c) => c.bookId)
      .filter((id) => onShelf.has(id));
    const have = byKey.get(r.key);
    if (have) {
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
  for (const r of records) for (const c of r.choices) if (!c.included) out.add(c.bookId);
  return out;
}

/**
 * Apply saved series orders to a sorted shelf: the members of each
 * series keep the slots they already occupy, but fill them in the
 * record's order. Books outside any series do not move.
 */
export function orderBySeries<T>(sorted: readonly T[], idOf: (item: T) => string, records: Iterable<SeriesRecord>): T[] {
  const out = [...sorted];
  for (const r of records) {
    const rank = new Map(r.choices.map((c) => [c.bookId, c.order]));
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

export const SERIES_HEADERS = ["series", "book_id", "included", "order", "decided_at"];

export function seriesToBytes(r: SeriesRecord): Promise<Uint8Array> {
  return rowsToBytes(
    r.choices.map((c) => ({ series: r.name, book_id: c.bookId, included: c.included ? "1" : "0", order: String(c.order), decided_at: r.decidedAt })),
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
    choices.push({ bookId: r.book_id, included: bool(r.included), order: int(r.order) });
  }
  if (choices.length === 0) return null;
  return { key, name, choices: normalizeChoices(choices), decidedAt };
}
