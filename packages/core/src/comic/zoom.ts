import type { PixelSize } from "./size";

/**
 * Zooming into a page on the desktop (docs/COMICS.md, section 15): `+` and
 * `-` step through the whole page and one and a half, two and three times
 * it; `0` goes back to the whole page; a click in the middle goes between
 * the whole page and twice it. Two pages up, the zoom is the spread's.
 * "The whole page" is the page as it is fitted (to the page, the width or
 * the height), so zooming is always from what the reader already sees.
 */

/** The sizes the zoom steps through, as times the whole page. */
export const ZOOMS: readonly number[] = [1, 1.5, 2, 3];

/** How much larger than the whole page a step of the zoom draws it. */
export function zoomFactor(step: number): number {
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, step))]!;
}

/** One step larger, no larger than the last. */
export function zoomIn(step: number): number {
  return Math.min(ZOOMS.length - 1, step + 1);
}

/** One step smaller, no smaller than the whole page. */
export function zoomOut(step: number): number {
  return Math.max(0, step - 1);
}

/** A click in the middle: the whole page goes to twice its size, and any zoom goes back to the whole page. */
export function zoomToggled(step: number): number {
  return step === 0 ? ZOOMS.indexOf(2) : 0;
}

/** A box `step` times larger, in whole pixels. */
export function zoomed(box: PixelSize, step: number): PixelSize {
  const by = zoomFactor(step);
  return { width: Math.max(1, Math.floor(box.width * by)), height: Math.max(1, Math.floor(box.height * by)) };
}

/**
 * Where a page comes in when it is larger than the window: at its top, at
 * the corner the comic starts from, the left, or the right for a comic
 * read right to left. As how far the view is scrolled along and down.
 */
export function startingCorner(rightToLeft: boolean, content: PixelSize, view: PixelSize): { left: number; top: number } {
  return { left: rightToLeft ? Math.max(0, content.width - view.width) : 0, top: 0 };
}

/**
 * Where to scroll so the point at `at` in the view (from its top left)
 * stays over the same part of the page when the page grows or shrinks
 * from `before` to `after`, scrolled `scrolled` beforehand. Kept inside
 * what can be scrolled to.
 */
export function keptInPlace(at: { x: number; y: number }, scrolled: { left: number; top: number }, before: PixelSize, after: PixelSize, view: PixelSize): { left: number; top: number } {
  const along = (point: number, from: number, was: number, now: number, room: number) => {
    // Where the content sat in the view before: centred when it was narrower than the view.
    const offsetWas = Math.max(0, (room - was) / 2);
    const offsetNow = Math.max(0, (room - now) / 2);
    const fraction = was > 0 ? (from + point - offsetWas) / was : 0.5;
    const to = fraction * now + offsetNow - point;
    return Math.round(Math.max(0, Math.min(Math.max(0, now - room), to)));
  };
  return { left: along(at.x, scrolled.left, before.width, after.width, view.width), top: along(at.y, scrolled.top, before.height, after.height, view.height) };
}

/** The page a number typed in "Go to page" names, counted from 0: one past either end goes to that end. Null for what isn't a number. */
export function pageTyped(text: string, count: number): number | null {
  const typed = text.trim();
  if (!/^[+-]?\d+$/.test(typed) || count <= 0) return null;
  return Math.max(0, Math.min(count - 1, Number(typed) - 1));
}
