import type { PixelSize } from "./size";

/**
 * One long scroll (docs/COMICS.md, section 15): a comic's pages one under
 * another, as wide as the window and never wider than they were drawn,
 * read by scrolling rather than turning. Where each page sits, which page
 * is being read, and which are near enough to draw are worked out here,
 * with no screen; the reader carries them out.
 *
 * A page's size is known once its file has been fetched (comic/size.ts);
 * until then it is taken to be the comic's usual page, the size most of
 * the pages known so far are, which for nearly every comic is right, so
 * the scroll bar is right from the start and a 600-page book is laid out
 * at once. A page that turns out otherwise (a spread drawn across two)
 * moves what is below it, never what is being read (`keptReading`).
 */

/**
 * How wide the column is, as a part of the widest it can be: the window's
 * width, or the usual page's own if that is narrower, since a page is never
 * drawn wider than it was. `+` and `-` step through these, so each step
 * shows; all of it to start with.
 */
export const COLUMNS: readonly number[] = [0.4, 0.55, 0.7, 0.85, 1];

/** One step wider, no wider than the window. */
export function columnWider(column: number): number {
  return COLUMNS.find((c) => c > column + 1e-9) ?? COLUMNS[COLUMNS.length - 1]!;
}

/** One step narrower, no narrower than the first. */
export function columnNarrower(column: number): number {
  return [...COLUMNS].reverse().find((c) => c < column - 1e-9) ?? COLUMNS[0]!;
}

/** Where every page sits in the scroll, in the window's own pixels, from the top. */
export interface ScrollLayout {
  tops: number[];
  widths: number[];
  heights: number[];
  /** How tall the whole scroll is. */
  total: number;
}

/**
 * The pages laid out one under another in a column `column` of
 * `viewWidth` wide. `sizes` holds the pages whose size is known; the rest
 * are taken to be the usual page (`usualPage`). With none known yet,
 * nothing is laid out.
 */
export function scrollLayout(sizes: ReadonlyMap<number, PixelSize>, count: number, viewWidth: number, column: number): ScrollLayout | null {
  const usual = usualPage(sizes);
  if (count <= 0 || viewWidth <= 0 || !usual) return null;
  const widest = Math.max(1, Math.floor(Math.min(viewWidth, usual.width) * column));
  const tops: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (let page = 0; page < count; page++) {
    const size = sizes.get(page) ?? usual;
    // As wide as the column, and never wider than the page was drawn.
    const width = Math.max(1, Math.min(widest, size.width));
    const height = Math.max(1, Math.round((width * size.height) / size.width));
    tops.push(y);
    widths.push(width);
    heights.push(height);
    y += height;
  }
  return { tops, widths, heights, total: y };
}

/** The size most of the known pages are, the first of them on a tie; null with none known. */
export function usualPage(sizes: ReadonlyMap<number, PixelSize>): PixelSize | null {
  const counted = new Map<string, { size: PixelSize; n: number }>();
  let usual: { size: PixelSize; n: number } | null = null;
  for (const page of [...sizes.keys()].sort((a, b) => a - b)) {
    const size = sizes.get(page)!;
    const key = `${size.width}x${size.height}`;
    const seen = counted.get(key) ?? { size, n: 0 };
    seen.n++;
    counted.set(key, seen);
    if (!usual || seen.n > usual.n) usual = seen;
  }
  return usual?.size ?? null;
}

/** The page at `y` down the scroll: the last whose top is at or above it. */
export function pageAtY(layout: ScrollLayout, y: number): number {
  let [lo, hi] = [0, layout.tops.length - 1];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (layout.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The page being read: the one that fills the window's top third; at the very end of the scroll, the last, which can't come any higher. */
export function pageReading(layout: ScrollLayout, scrollTop: number, viewHeight: number): number {
  if (scrollTop > 0 && scrollTop + viewHeight >= layout.total - 1) return layout.tops.length - 1;
  return pageAtY(layout, scrollTop + viewHeight / 3);
}

/** The pages that show, wholly or in part, in a window `viewHeight` tall scrolled `scrollTop` down. */
export function pagesShowing(layout: ScrollLayout, scrollTop: number, viewHeight: number): { first: number; last: number } {
  const first = pageAtY(layout, scrollTop);
  // The last whose top is above the window's foot.
  const last = pageAtY(layout, Math.max(scrollTop, scrollTop + viewHeight - 1));
  return { first, last };
}

/**
 * Where to scroll to after the pages are laid out again (a page's size
 * learned, the window or the column made wider), so the page at the top of
 * the window stays where it was, as far down itself as it was.
 */
export function keptReading(before: ScrollLayout, after: ScrollLayout, scrollTop: number): number {
  const page = Math.min(pageAtY(before, scrollTop), after.tops.length - 1);
  const into = (scrollTop - before.tops[page]!) / Math.max(1, before.heights[page]!);
  return Math.max(0, Math.round(after.tops[page]! + into * after.heights[page]!));
}
