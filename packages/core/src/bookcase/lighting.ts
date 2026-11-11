/**
 * The order the bookcase's lamps come on in as it opens.
 *
 * Lighting a shelf is a block of work the page can do nothing else during, so it is never done while something on
 * the page is moving, unless the shelf is in front of you: a book taken down in the middle of it would stutter. The
 * rules, in order:
 *
 * 1. Shelves in view are lit first, from the top one down, whatever else is going on.
 * 2. A book is taken down only once every shelf in view is lit (`lampsOnInView`).
 * 3. Shelves out of view are lit when nothing is moving, the nearest to the view first.
 */

/** The shelves on screen: the first and the last, counted from the top of the case. */
export interface ShelvesInView {
  first: number;
  last: number;
}

/** Whether every shelf in view has its lamps on. `lit` says so for each shelf, from the top of the case. */
export function lampsOnInView(lit: readonly boolean[], view: ShelvesInView): boolean {
  return lit.every((on, shelf) => on || shelf < view.first || shelf > view.last);
}

/** The shelf to light next, or null when there is none to light now. `moving` is whether anything on the page is. */
export function nextToLight(lit: readonly boolean[], view: ShelvesInView, moving: boolean): number | null {
  const dark = lit.flatMap((on, shelf) => (on ? [] : [shelf]));
  const inView = dark.find((shelf) => shelf >= view.first && shelf <= view.last);
  if (inView !== undefined) return inView;
  if (moving || dark.length === 0) return null;
  // How far a shelf is from the view; of two as near, the one below, where a page is scrolled to next.
  const away = (shelf: number) => (shelf < view.first ? view.first - shelf + 0.5 : shelf - view.last);
  return dark.reduce((nearest, shelf) => (away(shelf) < away(nearest) ? shelf : nearest));
}
