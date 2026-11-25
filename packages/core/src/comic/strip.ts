import type { WindowSize } from "./window";

/**
 * The strip of small pages along the foot of the comic reader (docs/COMICS.md,
 * section 15): every page of the comic in a row, each in a slot of the same
 * width, the page being read outlined and kept in the middle. A comic that
 * reads right to left has its row run that way, its first page on the right.
 *
 * Only the slots near what the strip shows are drawn, and only their small
 * pictures fetched, so a 600-page book costs what an issue does. Where each
 * slot sits, which are in view, and which pictures to hold are decided here,
 * with no screen; the reader carries them out.
 */

/** How tall a page's small picture is made, in pixels: the strip shows it about 100 points tall, so it stays sharp at three pixels to the point. The desktop's Rust makes them this tall too (comic_small.rs). */
export const SMALL_PAGE_HEIGHT = 300;

/** The row's slots, in the window's own pixels: how wide each is, the gap between two, and the room before the first and after the last. */
export interface StripSlots {
  width: number;
  gap: number;
  inset: number;
}

/** The pages a strip shows, first to last in page order (counted from 0), inclusive. */
export interface PagesInView {
  first: number;
  last: number;
}

/** How wide the whole row is, from the room before its first slot to the room after its last. */
export function stripWidth(count: number, slots: StripSlots): number {
  return count <= 0 ? 0 : slots.inset * 2 + count * slots.width + (count - 1) * slots.gap;
}

/** Where a page's slot starts along the row, from its left. A row that runs right to left has the first page at the far right. */
export function slotLeft(page: number, count: number, rightToLeft: boolean, slots: StripSlots): number {
  const place = rightToLeft ? count - 1 - page : page;
  return slots.inset + place * (slots.width + slots.gap);
}

/** The pages whose slots show, wholly or in part, in a strip `viewWidth` wide scrolled `scrollLeft` along. */
export function pagesInView(scrollLeft: number, viewWidth: number, count: number, rightToLeft: boolean, slots: StripSlots): PagesInView {
  if (count <= 0) return { first: 0, last: -1 };
  const step = slots.width + slots.gap;
  const clamp = (place: number) => Math.max(0, Math.min(count - 1, place));
  // What shows, measured from the first slot's edge; slots by their place along the row, left to right.
  const [from, to] = [scrollLeft - slots.inset, scrollLeft + Math.max(0, viewWidth) - slots.inset];
  const leftmost = clamp(Math.floor(Math.max(0, from) / step));
  const rightmost = clamp(Math.ceil(Math.max(0, to) / step) - 1);
  if (!rightToLeft) return { first: leftmost, last: Math.max(leftmost, rightmost) };
  // Right to left, a place counted from the left is a page counted from the right.
  return { first: count - 1 - Math.max(leftmost, rightmost), last: count - 1 - leftmost };
}

/**
 * How far along to scroll a strip `viewWidth` wide so the pages being read
 * (one, or two that face each other) sit in its middle. Near either end it
 * goes no further than the row does.
 */
export function scrollToCentre(pages: readonly number[], count: number, viewWidth: number, rightToLeft: boolean, slots: StripSlots): number {
  if (pages.length === 0 || count <= 0) return 0;
  const lefts = pages.map((p) => slotLeft(p, count, rightToLeft, slots));
  const middle = (Math.min(...lefts) + Math.max(...lefts) + slots.width) / 2;
  const most = Math.max(0, stripWidth(count, slots) - viewWidth);
  return Math.max(0, Math.min(most, Math.round(middle - viewWidth / 2)));
}

/** The slots drawn: those in view and `margin` more on either side, so a little scrolling finds them already there. */
export function slotsDrawn(inView: PagesInView, count: number, margin: number): PagesInView {
  if (inView.last < inView.first) return inView;
  return { first: Math.max(0, inView.first - margin), last: Math.min(count - 1, inView.last + margin) };
}

/**
 * The window of small pictures to hold (core/comic/window.ts) for the pages
 * in view: centred on them, as wide as they are and `margin` more either
 * side. Fetched nearest the middle first.
 */
export function stripWindow(inView: PagesInView, margin: number): { centre: number; size: WindowSize } {
  const centre = Math.floor((inView.first + inView.last) / 2);
  const half = Math.max(0, inView.last - centre) + margin;
  return { centre, size: { behind: half, ahead: half } };
}
