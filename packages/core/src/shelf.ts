import type { ScannedBook } from "./scan/scan";
import { readerOnly } from "./ebook";
import { splitPeople } from "./scan/sidefiles";
import { addedAt } from "./view";

/**
 * The bookcase: the books outside a series stood on shelves spine-out, as
 * a room full of books looks, with the week's new ones face-out at the
 * front. Everything a spine is decided here: its binding, its size, how its
 * title and author fit on it, its colours, and how spines pack into
 * shelves. The app measures text (a canvas, in Bookcase.tsx) and draws.
 */

/** The ways a spine is bound. Each book has one, for good, from its id. */
export type Binding = "cloth" | "leather" | "paperback" | "modern" | "plain";
export const BINDINGS: readonly Binding[] = ["cloth", "leather", "paperback", "modern", "plain"];

/** The order the shelf stands in, chosen by the tabs above it. */
export type ShelfOrder = "added" | "title" | "author" | "length";
export const SHELF_ORDERS: readonly ShelfOrder[] = ["added", "title", "author", "length"];

/** Spines, or today's grid of covers, in the same order. */
export type ShelfLook = "spines" | "covers";

export interface ShelfChoice {
  order: ShelfOrder;
  look: ShelfLook;
}

export const DEFAULT_SHELF: ShelfChoice = { order: "added", look: "spines" };

/** The choice as the settings file kept it, or the default for anything it doesn't recognise. */
export function parseShelf(raw: unknown): ShelfChoice {
  if (!raw || typeof raw !== "object") return DEFAULT_SHELF;
  const r = raw as Partial<ShelfChoice>;
  return {
    order: SHELF_ORDERS.includes(r.order as ShelfOrder) ? (r.order as ShelfOrder) : DEFAULT_SHELF.order,
    look: r.look === "covers" ? "covers" : "spines",
  };
}

/** A typeface as a spine sets it. */
export interface Face {
  family: string;
  weight: number;
  upper: boolean;
  /** Letter spacing, in ems. */
  tracking: number;
  lineHeight: number;
}

const SERIF = "Newsreader Variable";
const SANS = "Inter Variable";

/** The title's face for each binding: gilt capitals on cloth, a label's serif, a paperback's sans, bold modern capitals, a plain serif. */
export const TITLE_FACE: Record<Binding, Face> = {
  cloth: { family: SERIF, weight: 500, upper: true, tracking: 0.08, lineHeight: 1.12 },
  leather: { family: SERIF, weight: 600, upper: false, tracking: 0.02, lineHeight: 1.08 },
  paperback: { family: SANS, weight: 600, upper: false, tracking: 0, lineHeight: 1.14 },
  modern: { family: SANS, weight: 700, upper: true, tracking: 0.02, lineHeight: 1.04 },
  plain: { family: SERIF, weight: 500, upper: false, tracking: 0, lineHeight: 1.12 },
};

/** The author's surname, in spaced capitals, on every binding. */
export const AUTHOR_FACE: Face = { family: SANS, weight: 600, upper: true, tracking: 0.12, lineHeight: 1 };

/**
 * How long a run of text is, per pixel of font size, in a face, tracking
 * included. The app measures it with the real fonts; tests use a fake.
 */
export type Measure = (text: string, face: Face) => number;

/** A shelf's height, at the computer's size; a phone's is smaller (`scale`). */
export const SHELF_HEIGHT = 190;

/** A stable number from a string (FNV-1a), so a book looks the same every time it's drawn. */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function bindingOf(bookId: string): Binding {
  return BINDINGS[hashOf(bookId) % BINDINGS.length]!;
}

/** What a spine needs to know about its book. */
export interface SpineBook {
  id: string;
  title: string;
  author: string;
  durationMs: number;
  /** Only its EPUB: no length to make it thick, so it's as thick as a modest novel. */
  textOnly: boolean;
  finished: boolean;
}

export function spineBookOf(b: ScannedBook, finished: boolean): SpineBook {
  return { id: b.book.id, title: b.book.title, author: b.book.author, durationMs: b.book.durationMs, textOnly: readerOnly(b.book), finished };
}

/** The author's surname: the last word of the first author named. */
export function surnameOf(author: string): string {
  const first = splitPeople(author)[0] ?? author;
  return first.trim().split(/\s+/).pop() ?? "";
}

/** A spine laid out: its size, its zones top to bottom, and the words in them. Sizes in pixels. */
export interface Spine {
  binding: Binding;
  width: number;
  height: number;
  /** The zones, top to bottom: decoration at the head, the finished sticker, the title, the author, decoration at the foot. */
  head: number;
  foot: number;
  /** The finished sticker's diameter, 0 for a book not finished. */
  sticker: number;
  stickerZone: number;
  title: { lines: string[]; size: number };
  /** Null when the spine is too thin to say who wrote it as well. */
  author: { text: string; size: number; zone: number } | null;
  /** Room kept clear around the words. */
  padX: number;
  padY: number;
  /** A leather spine's label: inset from the edges, and the room inside it. */
  labelInset: number;
  labelPad: number;
}

/** The head and foot decoration of each binding, as parts of the spine's height. */
const ZONES: Record<Binding, [number, number]> = { cloth: [0.09, 0.08], leather: [0.15, 0.09], paperback: [0.13, 0.1], modern: [0.08, 0.07], plain: [0.08, 0.07] };

/** A spine's width and height before its words are fitted: thickness follows the book's length, height varies as real books do. */
export function spineSize(b: SpineBook, scale: number): { width: number; height: number } {
  const hours = b.durationMs / 3_600_000;
  const width = b.textOnly ? 22 + (hashOf(b.id + "w") % 12) : Math.max(22, Math.min(62, 14 + hours * 1.25));
  const height = 0.76 + (hashOf(b.id + "h") % 22) / 100;
  return { width: Math.round(width * scale), height: Math.round(SHELF_HEIGHT * scale * height) };
}

/** A title on one line, then its best break into two, then three: each the split whose longest line is shortest. */
export function titleLines(title: string, face: Face, measure: Measure): string[][] {
  const words = title.split(/\s+/).filter(Boolean);
  const out = [[words.join(" ")]];
  const longest = (parts: string[]) => Math.max(...parts.map((p) => measure(p, face)));
  let two: { parts: string[]; m: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const parts = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const m = longest(parts);
    if (!two || m < two.m) two = { parts, m };
  }
  if (two) out.push(two.parts);
  let three: { parts: string[]; m: number } | null = null;
  for (let i = 1; i < words.length - 1; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const parts = [words.slice(0, i), words.slice(i, j), words.slice(j)].map((p) => p.join(" "));
      const m = longest(parts);
      if (!three || m < three.m) three = { parts, m };
    }
  }
  if (three) out.push(three.parts);
  return out;
}

/**
 * Fit the title and author to a spine of this width: the title as large as
 * fits, on one line or more, never cut; the author at about six tenths of
 * the title's size, down to a smallest size before it's left off. Null when
 * the title can't fit at its smallest size, so the spine must be wider.
 */
function fitAt(b: SpineBook, binding: Binding, width: number, height: number, scale: number, measure: Measure): Spine | null {
  const face = TITLE_FACE[binding];
  const padX = Math.max(2.5, width * 0.16);
  const padY = 5 * scale;
  const [headPart, footPart] = ZONES[binding];
  const head = Math.round(height * headPart);
  const foot = Math.round(height * footPart);
  const sticker = b.finished ? Math.min(width - 2 * padX + 2, 12 * scale) : 0;
  const stickerZone = sticker ? sticker + 2 * padY : 0;
  const labelInset = Math.max(2, width * 0.12);
  const labelPad = 4 * scale;
  // Across the spine: the room the lines of the title stack into.
  const across = binding === "leather" ? width - 2 * labelInset - 2 * labelPad : width - 2 * padX;
  const surname = surnameOf(b.author).toUpperCase();
  const authorPerPx = surname ? measure(surname, AUTHOR_FACE) : 0;
  const title = face.upper ? b.title.toUpperCase() : b.title;
  const biggest = 16 * scale;
  const smallest = 8.5 * scale;
  const authorBiggest = 8.5 * scale;
  const authorSmallest = 5.5 * scale;
  // Along the spine: what's left for words once the decoration and sticker have theirs, with a little to spare.
  const along = (height - head - foot - stickerZone - 2 * padY - (binding === "leather" ? 3 * labelPad : 0)) * 0.95;
  for (const withAuthor of surname ? [true, false] : [false]) {
    for (const lines of titleLines(title, face, measure)) {
      const titlePerPx = Math.max(...lines.map((l) => measure(l, face)));
      const fitsAcross = across / (lines.length * face.lineHeight);
      let size: number;
      let authorSize = 0;
      if (withAuthor) {
        const room = along - 2 * padY;
        size = Math.min(biggest, fitsAcross, room / (titlePerPx + 0.6 * authorPerPx));
        authorSize = Math.min(authorBiggest, Math.max(authorSmallest, 0.6 * size));
        if (authorSize > across / 1.15) continue;
        size = Math.min(biggest, fitsAcross, (room - authorPerPx * authorSize) / titlePerPx);
      } else {
        size = Math.min(biggest, fitsAcross, along / titlePerPx);
      }
      if (size < smallest) continue;
      return {
        binding,
        width,
        height,
        head,
        foot,
        sticker,
        stickerZone,
        title: { lines, size },
        author: withAuthor ? { text: surname, size: authorSize, zone: authorPerPx * authorSize + 2 * padY } : null,
        padX,
        padY,
        labelInset,
        labelPad,
      };
    }
  }
  return null;
}

/**
 * A book's spine. Its thickness follows its length, but a thin book with a
 * long title gets just enough spine to say it whole: a title is never cut.
 */
export function layOutSpine(b: SpineBook, scale: number, measure: Measure): Spine {
  const binding = bindingOf(b.id);
  const { width, height } = spineSize(b, scale);
  const step = Math.max(1, Math.round(2 * scale));
  for (let w = width; w <= 64 * scale; w += step) {
    const spine = fitAt(b, binding, w, height, scale, measure);
    if (spine) return spine;
  }
  // A title too long for any spine: the widest spine, the smallest size, on three lines.
  const w = Math.round(64 * scale);
  const lines = titleLines(TITLE_FACE[binding].upper ? b.title.toUpperCase() : b.title, TITLE_FACE[binding], measure).at(-1)!;
  return { binding, width: w, height, head: 0, foot: 0, sticker: 0, stickerZone: 0, title: { lines, size: 8.5 * scale }, author: null, padX: w * 0.16, padY: 5 * scale, labelInset: 2, labelPad: 4 * scale };
}

/** A spine's colours: its cloth or paper, and the ink or foil on it. */
export interface SpineColours {
  /** The spine itself; on a paperback, its bands. */
  ground: string;
  /** Its lettering, rules and label. */
  ink: string;
  /** A paperback's paper between its bands. */
  paper: string;
}

const PAPER = "#f1ebde";
const DARK_INK = "#1d1b18";

/**
 * Colours for a spine from its cover's hue (0 to 1, or null for a grey
 * cover), so a book looks like itself spine-out and the shelf stays in
 * tune: cloth and leather dark, a paperback's bands bright, a plain
 * binding pale. Each book is a shade lighter or darker than its neighbours.
 */
export function spineColours(hue: number | null, binding: Binding, bookId: string): SpineColours {
  const h = hue ?? 0.08;
  const grey = hue === null ? 0.12 : 1;
  const shade = ((hashOf(bookId + "s") % 9) - 4) / 100;
  const foil = hslHex(0.11, 0.66, 0.45);
  const cream = hslHex(0.1, 0.9, 0.35);
  switch (binding) {
    case "cloth":
      return { ground: hslHex(h, 0.24 + shade, 0.34 * grey), ink: foil, paper: PAPER };
    case "leather":
      return { ground: hslHex(h, 0.2 + shade, 0.4 * grey), ink: cream, paper: PAPER };
    case "paperback":
      return { ground: hslHex(h, 0.46 + shade, 0.55 * grey), ink: DARK_INK, paper: PAPER };
    case "modern":
      return { ground: hslHex(h, 0.36 + shade, 0.55 * grey), ink: cream, paper: PAPER };
    case "plain":
      return { ground: hslHex(h, 0.86 + shade / 2, 0.24 * grey), ink: hslHex(h, 0.17, 0.3 * grey), paper: PAPER };
  }
}

/** The hue of a colour written as #rrggbb, or null for a grey. */
export function hueOfHex(colour: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.04) return null;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h / 6;
}

/** Is a colour light enough that dark marks show on it? */
export function isLight(colour: string): boolean {
  const n = parseInt(colour.replace("#", ""), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
}

function hslHex(h: number, l: number, s: number): string {
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = light - c / 2;
  const seg = Math.floor(h * 6) % 6;
  const channels: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  return "#" + channels[seg]!.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

/** A title as it files: without a first "The", "A" or "An". */
export function filingTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, "");
}

const byTitle = (a: ScannedBook, b: ScannedBook) => filingTitle(a.book.title).localeCompare(filingTitle(b.book.title));
const byAuthor = (a: ScannedBook, b: ScannedBook) => surnameOf(a.book.author).localeCompare(surnameOf(b.book.author)) || a.book.author.localeCompare(b.book.author) || byTitle(a, b);

/** The books in the shelf's order: newest first, A to Z by title or by author's surname, or shortest first with the books that are only text last. */
export function orderShelf(books: readonly ScannedBook[], order: ShelfOrder): ScannedBook[] {
  const out = [...books];
  switch (order) {
    case "added":
      return out.sort((a, b) => addedAt(b) - addedAt(a) || byAuthor(a, b));
    case "title":
      return out.sort(byTitle);
    case "author":
      return out.sort(byAuthor);
    case "length":
      return out.sort((a, b) => Number(readerOnly(a.book)) - Number(readerOnly(b.book)) || a.book.durationMs - b.book.durationMs || byAuthor(a, b));
  }
}

const DAY = 86_400_000;

/** Came in within the last week: stood face-out at the front of the shelf. */
export function isNewThisWeek(b: ScannedBook, now: number): boolean {
  return now - addedAt(b) < 7 * DAY;
}

/** What the shelf's edge says where a run of books begins: a letter, a month, or a length. */
export function shelfLabel(b: ScannedBook, order: ShelfOrder, now: number, locale?: string): string {
  switch (order) {
    case "title":
      return (/[a-z]/i.exec(filingTitle(b.book.title).charAt(0)) ? filingTitle(b.book.title).charAt(0) : "#").toUpperCase();
    case "author":
      return surnameOf(b.book.author).charAt(0).toUpperCase() || "#";
    case "length": {
      if (readerOnly(b.book)) return "Text only";
      const hours = b.book.durationMs / 3_600_000;
      return hours < 5 ? "Under 5 h" : hours < 10 ? "5 to 10 h" : hours < 20 ? "10 to 20 h" : "20 h and more";
    }
    case "added":
      return now - addedAt(b) < 14 * DAY ? "Last two weeks" : new Date(addedAt(b)).toLocaleDateString(locale, { month: "short", year: "numeric" });
  }
}

/** Something to stand on a shelf, and the room after it. */
export interface Shelved {
  width: number;
  gapAfter: number;
}

/** A thing on a shelf, and how far along the shelf it starts. */
export interface Placed<T> {
  item: T;
  x: number;
}

/** Stand things on shelves of a width, in order, starting a new shelf when the next won't fit. */
export function packShelves<T extends Shelved>(items: readonly T[], width: number): Placed<T>[][] {
  const shelves: Placed<T>[][] = [[]];
  let x = 0;
  for (const item of items) {
    const shelf = shelves[shelves.length - 1]!;
    if (x + item.width > width && shelf.length > 0) {
      shelves.push([]);
      x = 0;
    }
    shelves[shelves.length - 1]!.push({ item, x });
    x += item.width + item.gapAfter;
  }
  return shelves.filter((s) => s.length > 0);
}

/** How far a book leans on the one before it, when its shelf has room at the end: in degrees. */
export const LEAN_DEGREES = 8;

/** Room a book needs at the end of its shelf to lean: its top swings over by its height times the sine of the lean. */
export function leanRoom(height: number): number {
  return Math.round(height * Math.sin((LEAN_DEGREES * Math.PI) / 180));
}
