// The lamp-lit bookcase's rules, the same on every device: every book spine-out, newest first under a label on the
// shelf's edge where each month begins, spines as thick as the books are long, titles fitted and never cut. Sizes are
// in points at k = 1; k scales them for a screen. The Apple app's copy of these rules is in
// packages/apple/Ribbon/Bookcase/ (ShelfLayout.swift, Spine.swift), and a change to one is a change to both.

import { clothForBook, hashOf, type Cloth } from "./cloth";

/** A shelf's height, from the board to the shelf above. */
export const CASE_SHELF_HEIGHT = 190;

/** A typeface as the spines use it: the serif or the sans at a weight, in capitals or not, tracked, and its leading. */
export interface SpineFace {
  serif: boolean;
  weight: number;
  upper: boolean;
  tracking: number;
  lineHeight: number;
}

/** The spines' type: the title in serif capitals, the surname in small sans capitals, the number in the serif. */
export const SPINE_FACES = {
  title: { serif: true, weight: 500, upper: true, tracking: 0.09, lineHeight: 1.12 },
  author: { serif: false, weight: 600, upper: true, tracking: 0.18, lineHeight: 1 },
  number: { serif: true, weight: 500, upper: false, tracking: 0, lineHeight: 1 },
  label: { serif: false, weight: 600, upper: true, tracking: 0.1, lineHeight: 1 },
} as const satisfies Record<string, SpineFace>;

/** How long a run of text is per point of type, tracking included. The page measures with a canvas; tests with a ruler of their own. */
export type MeasureRun = (text: string, face: SpineFace) => number;

/** A book as the bookcase knows it: what its spine says, how thick it is, when it came, and how far you are in it. */
export interface CaseBook {
  id: string;
  title: string;
  author: string;
  /** How long it is in words, which is how thick it stands. */
  words: number;
  /** How far through it you are, 0 to 1, and whether you finished it. */
  fraction: number;
  finished: boolean;
  /** When it came to the library, in milliseconds, if that's known. */
  addedAt: number | null;
  /** Its cover's cloth, when its cover has been read; otherwise it wears a quiet cloth of its own. */
  cloth?: Cloth;
}

/** About a third of the books are paperbacks, the same ones on every device. */
export function isPaperback(id: string): boolean {
  return hashOf(id + "paperback") % 10 < 3;
}

/**
 * A book's thickness, made the way a binder makes one, then drawn a little bolder than life. Pages hold 500 words.
 * A hardback's paper is 0.065 mm a page and its two boards 2.75 mm each; a paperback's paper is thinner, 0.055 mm,
 * under a card cover. A shelf is a 234 mm hardback's height, nine tenths full. Drawn true to life a novel's spine
 * looks impossibly thin on a screen, so hardbacks are drawn 2.4 times as thick and paperbacks 1.8.
 */
export function thickness(b: CaseBook, k: number): number {
  const paperback = isPaperback(b.id), pages = b.words / 500;
  const mm = paperback ? pages * 0.055 + 0.6 : pages * 0.065 + 5.5;
  const pointsPerMm = (CASE_SHELF_HEIGHT * 0.88) / 234;
  return Math.min(84, Math.max(16, mm * pointsPerMm * (paperback ? 1.8 : 2.4))) * k;
}

/** A spine's starting width and its height: books stand between three quarters of the shelf's height and nearly all of it. */
export function spineSize(b: CaseBook, k: number): { width: number; height: number } {
  const height = 0.76 + (hashOf(b.id + "h") % 22) / 100;
  return { width: Math.round(thickness(b, k)), height: Math.round(CASE_SHELF_HEIGHT * k * height) };
}

/** The surname, as a spine carries it: the last word of the first author. */
export function caseSurname(author: string): string {
  const first = author.split(/[,&]/)[0] ?? author;
  const words = first.trim().split(" ").filter((w) => w.length > 0);
  return words[words.length - 1] ?? "";
}

/**
 * What a spine says: the volume number, if the title carries one ("29. Vengeful Spirit", "…, Book 7"), and the title
 * before its subtitle. A spine, like a printed one, carries the short form.
 */
export function spineTitle(title: string): { number: string | null; main: string } {
  let rest = title, number: string | null = null;
  const led = /^(\d+)\.\s+/.exec(rest);
  if (led) {
    number = String(parseInt(led[1]!, 10));
    rest = rest.slice(led[0].length);
  }
  const parts = rest.split(": ");
  if (number === null) {
    for (const part of parts.slice(1)) {
      const volume = /\b(?:Book|Volume|Part)\s+([0-9IVX]+)/.exec(part);
      if (volume) {
        number = volume[1]!;
        break;
      }
    }
  }
  return { number, main: parts[0]! };
}

/** A title on one line, the best break into two, and the best into three: the ones whose longest line is shortest. */
function titleLines(title: string, measure: MeasureRun): string[][] {
  const face = SPINE_FACES.title;
  const words = title.split(/\s+/).filter((w) => w.length > 0);
  const longest = (parts: string[]) => Math.max(0, ...parts.map((p) => measure(p, face)));
  const shortest = (candidates: string[][]) => candidates.reduce((best, c) => (longest(c) < longest(best) ? c : best));
  const options = [[words.join(" ")]];
  if (words.length > 1) {
    options.push(shortest(words.slice(1).map((_, i) => [words.slice(0, i + 1).join(" "), words.slice(i + 1).join(" ")])));
  }
  if (words.length > 2) {
    const three: string[][] = [];
    for (let i = 1; i < words.length - 1; i++) {
      for (let j = i + 1; j < words.length; j++) three.push([words.slice(0, i), words.slice(i, j), words.slice(j)].map((w) => w.join(" ")));
    }
    options.push(shortest(three));
  }
  return options;
}

/** The title's size on every spine with room for it, and the smallest it may go; the author's size. At k = 1. */
const TITLE_SIZE = 12, SMALLEST_TITLE = 7.5, AUTHOR_TARGET = 6.4;

/** A spine laid out: its size and where everything on it goes, from the top, in points. */
export interface SpineLayout {
  width: number;
  height: number;
  number: string | null;
  numberSize: number;
  numberMid: number;
  /** The finished tick's diameter, or 0. */
  tick: number;
  tickMid: number;
  lines: string[];
  size: number;
  titleTop: number;
  titleBottom: number;
  author: string | null;
  authorSize: number;
  authorMid: number;
  /** From the head (and the foot) to the first rule. */
  edge: number;
}

/**
 * Fit a spine: the title at the shelf's one size if it fits on one line, then two, then three; smaller only when it
 * must, and wider before it gets too small. Never cut.
 */
export function layOutCaseSpine(b: CaseBook, k: number, measure: MeasureRun): SpineLayout {
  const { number, main } = spineTitle(b.title);
  const options = titleLines(main.toUpperCase(), measure);
  const start = spineSize(b, k), H = start.height;
  const surname = caseSurname(b.author).toUpperCase();
  const step = Math.max(1, Math.round(2 * k));
  let W = start.width, withAuthor = surname.length > 0;
  for (;;) {
    const pad = Math.max(3 * k, W * 0.17), across = W - 2 * pad;
    const edge = 7 * k, rules = 6 * k;
    let y = edge + rules;
    const numberSize = number === null ? 0 : Math.min(9 * k, across / Math.max(0.5, measure(number, SPINE_FACES.number)));
    const numberMid = y + numberSize * 0.5 + 3 * k;
    if (number !== null) y += numberSize + 7 * k;
    const tick = b.finished ? Math.min(across + 2, 10 * k) : 0;
    const tickMid = y + tick / 2 + 1 * k;
    if (tick > 0) y += tick + 5 * k;
    const titleTop = y + 3 * k;
    const authorSize = Math.min(AUTHOR_TARGET * k, across * 0.9);
    const authorLength = withAuthor ? measure(surname, SPINE_FACES.author) * authorSize : 0;
    const footStart = H - edge - rules;
    const authorMid = footStart - 5 * k - authorLength / 2;
    const titleBottom = withAuthor ? authorMid - authorLength / 2 - 9 * k : footStart - 4 * k;
    const along = titleBottom - titleTop;
    let chosen: { lines: string[]; size: number } | null = null;
    let best = { lines: options[0]!, size: 0 };
    for (const lines of options) {
      const longest = Math.max(...lines.map((l) => measure(l, SPINE_FACES.title)));
      const fit = Math.min(across / (lines.length * SPINE_FACES.title.lineHeight), along / longest);
      if (fit >= TITLE_SIZE * k) {
        chosen = { lines, size: TITLE_SIZE * k };
        break;
      }
      if (fit > best.size) best = { lines, size: fit };
    }
    const pick = chosen ?? best;
    // Wide enough, or as wide as a spine goes with the author already given up.
    if (pick.size >= SMALLEST_TITLE * k || (W >= 64 * k && !withAuthor)) {
      return {
        width: W, height: H, number, numberSize, numberMid, tick, tickMid,
        lines: pick.lines, size: Math.max(pick.size, SMALLEST_TITLE * k * 0.9), titleTop, titleBottom,
        author: withAuthor ? surname : null, authorSize, authorMid, edge,
      };
    }
    if (W < 64 * k) W += step;
    else withAuthor = false;
  }
}

/** A book on a shelf, where the layout puts it: its spine laid out, its cloth, and its place. */
export interface CaseItem {
  book: CaseBook;
  paperback: boolean;
  spine: SpineLayout;
  /** The label on the shelf's edge under it, where a month (or the last two weeks) begins. */
  label: string | null;
  cloth: Cloth;
  x: number;
  /** Leaning on the book before it, at the end of a shelf with room to spare. */
  lean: boolean;
}

const DAY = 86_400_000;

/** Whole days since a book came, counted from now; a book with no date came longest ago. */
function daysSince(b: CaseBook, now: number): number {
  return b.addedAt === null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.trunc((now - b.addedAt) / DAY));
}

/** Newest first; books that came together by their authors' surnames. */
export function caseOrder(books: readonly CaseBook[], now: number): CaseBook[] {
  return books
    .map((book, at) => ({ book, at, days: daysSince(book, now), surname: caseSurname(book.author) }))
    .sort((a, b) => a.days - b.days || (a.surname < b.surname ? -1 : a.surname > b.surname ? 1 : a.at - b.at))
    .map((e) => e.book);
}

/** The label on the shelf's edge for when a book came: the last two weeks, then its month. */
export function caseLabel(b: CaseBook, now: number): string | null {
  if (b.addedAt === null) return null;
  if (daysSince(b, now) < 14) return "Last two weeks";
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(b.addedAt);
}

/** Every book spine-out, in the shelf's order, packed into shelves of a width. */
export function layOutCase(books: readonly CaseBook[], caseWidth: number, k: number, measure: MeasureRun, now: number): CaseItem[][] {
  const gap = Math.max(1, Math.round(1.5 * k)), side = Math.round(12 * k), room = caseWidth - 2 * side;
  const ordered = caseOrder(books, now);
  const shelves: CaseItem[][] = [[]];
  let x = 0, before: string | null = null;
  ordered.forEach((b, i) => {
    const label = caseLabel(b, now);
    const item: CaseItem = {
      book: b,
      paperback: isPaperback(b.id),
      spine: layOutCaseSpine(b, k, measure),
      label: i === 0 || label !== before ? label : null,
      cloth: b.cloth ?? clothForBook(b.id),
      x: 0,
      lean: false,
    };
    before = label;
    let shelf = shelves[shelves.length - 1]!;
    if (x + item.spine.width > room && shelf.length > 0) {
      shelf = [];
      shelves.push(shelf);
      x = 0;
    }
    item.x = side + x;
    shelf.push(item);
    x += item.spine.width + gap;
  });
  // A shelf with room at its end lets its last book lean on the one before.
  for (const shelf of shelves) {
    const last = shelf[shelf.length - 1];
    if (!last || shelf.length < 2) continue;
    if (side + room - (last.x + last.spine.width) > last.spine.height * 0.16 + 4) {
      last.lean = true;
      last.x += Math.round(last.spine.height * 0.139);
    }
  }
  spreadCloths(shelves);
  return shelves;
}

/**
 * Books of one series often have covers in one colour, and side by side their spines would run together:
 * a spine never wears the same cloth as either of the two before it, but its next-nearest instead.
 */
function spreadCloths(shelves: CaseItem[][]): void {
  let recent: Cloth["ground"][] = [];
  const worn = (c: Cloth) => recent.some((g) => g.r === c.ground.r && g.g === c.ground.g && g.b === c.ground.b);
  for (const shelf of shelves) {
    for (const item of shelf) {
      const nearest = item.cloth;
      const cloth = [nearest, ...nearest.alternatives].find((c) => !worn(c)) ?? nearest;
      item.cloth = cloth;
      recent = [...recent, cloth.ground].slice(-2);
    }
  }
}
