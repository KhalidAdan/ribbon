import { EBOOK_FORMAT } from "../core/ebook";
import type { TextPlace } from "../core/reading/booktext";
import type { ReadingSettings } from "../core/reading/typography";
import type { SectionLayout } from "./layout";

declare const __APP_VERSION__: string;

/**
 * The page you were reading, kept per book so the book opens to it at
 * once: drawn from here while its text is read and paired with the
 * narration, and given to the layout engine so the real page needs no
 * layout either. A convenience only, kept in this window's storage; when
 * it is missing, stale or made for another window size, the book opens as
 * it always did.
 *
 * Two records per book: the chapter's layout, written when you move into
 * a chapter (it can be large), and your place in it, written on every
 * turn (it is small).
 */
export interface PageSnapshot {
  /** The window, the settings, the app and the book format it was drawn for (fitsKey): it is drawn again only for the same. */
  fits: string;
  /** The layout spec it was laid out for (layout.ts, specKey): the layout engine takes it only for the same. */
  key: string;
  section: number;
  /** The chapter's length when it was laid out: a book changed since is laid out afresh. */
  chars: number;
  layout: SectionLayout;
}

export interface PlaceSnapshot {
  place: TextPlace;
  /** How far through the book, 0 to 1, for the progress line. */
  progress: number;
}

const LAYOUT = "ribbon:page:";
const PLACE = "ribbon:place:";
const RECENT = "ribbon:pages";
/** Books whose page is kept; the least recently read lose theirs. */
const KEEP = 4;

/** What a drawn page depends on besides the book: the reading area, the settings, the app (its layout code) and the book format. */
export function fitsKey(viewport: { width: number; height: number }, settings: ReadingSettings): string {
  return `${viewport.width}x${viewport.height}|${JSON.stringify(settings)}|${__APP_VERSION__}|${EBOOK_FORMAT}`;
}

/** The page last read in a book, if there is one and the place is still in its chapter. */
export function loadSnapshot(bookId: string): (PageSnapshot & PlaceSnapshot) | null {
  try {
    const page = JSON.parse(localStorage.getItem(LAYOUT + bookId) ?? "null") as PageSnapshot | null;
    const at = JSON.parse(localStorage.getItem(PLACE + bookId) ?? "null") as PlaceSnapshot | null;
    if (!page || !at || page.section !== at.place.section) return null;
    return { ...page, ...at };
  } catch {
    return null;
  }
}

export function savePage(bookId: string, page: PageSnapshot): void {
  try {
    const recent = (JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[]).filter((id) => id !== bookId);
    recent.unshift(bookId);
    for (const old of recent.splice(KEEP)) {
      localStorage.removeItem(LAYOUT + old);
      localStorage.removeItem(PLACE + old);
    }
    localStorage.setItem(RECENT, JSON.stringify(recent));
    localStorage.setItem(LAYOUT + bookId, JSON.stringify(page));
  } catch {
    // Full or unavailable: the book opens the slower way.
  }
}

export function savePlace(bookId: string, at: PlaceSnapshot): void {
  try {
    localStorage.setItem(PLACE + bookId, JSON.stringify(at));
  } catch {
    // As above.
  }
}
