import type { Locator } from "../poslog";
import { pageType } from "./pages";
import { firstPage, pagesOf, spreadOf, spreads, type Spread } from "./spreads";

/**
 * The comic open in the reader, as a state machine (docs/STATE-MACHINES.md),
 * shaped as the text reader's is (reading/session.ts).
 *
 * ```
 *   (closed) ── open ──▶ opening ── shown ──▶ ready ── closed ──▶ (closed)
 *                          │
 *                          └── failed ──▶ failed ── closed ──▶ (closed)
 *   any      ── open (another comic, or this one again) ──▶ opening
 * ```
 *
 * Only a ready comic has pages and a place among them. What is learned of
 * a page after it opens (that it is drawn across two) names its comic,
 * and is dropped when that comic is no longer the one open.
 */
export type ComicSession = OpeningComic | FailedComic | ReadyComic;

/** Its archive's list is being read. */
export interface OpeningComic {
  status: "opening";
  bookId: string;
}

/** It couldn't be opened, and why, in plain words. */
export interface FailedComic {
  status: "failed";
  bookId: string;
  message: string;
}

/** Open to read. */
export interface ReadyComic {
  status: "ready";
  bookId: string;
  /** Its pages, as entries of its archive, in reading order. */
  pages: string[];
  /** Which pages are drawn across two. Learned as each page's picture arrives; false until then. */
  wide: boolean[];
  /** The page it is open at, counted from 0. With two pages up, the first of the two. */
  page: number;
  /** For a PDF, its file's name: its pages are not entries of an archive but pages of this one file (`pages` holds "page=1", "page=2", …). */
  document?: string;
}

export type ComicEvent =
  | { type: "open"; bookId: string }
  | { type: "failed"; bookId: string; message: string }
  | { type: "shown"; bookId: string; pages: string[]; page: number; document?: string }
  | { type: "turned"; bookId: string; page: number }
  | { type: "measured"; bookId: string; page: number; wide: boolean }
  | { type: "closed" };

function clamp(page: number, pages: number): number {
  return Math.max(0, Math.min(pages - 1, Math.round(page)));
}

/** The session after an event. An event for a comic that isn't the one open changes nothing. */
export function comicAfter(session: ComicSession | null, event: ComicEvent): ComicSession | null {
  if (event.type === "open") return { status: "opening", bookId: event.bookId };
  if (event.type === "closed") return null;
  if (!session || session.bookId !== event.bookId) return session;
  switch (event.type) {
    case "failed":
      return session.status === "opening" ? { status: "failed", bookId: session.bookId, message: event.message } : session;
    case "shown":
      if (session.status !== "opening") return session;
      if (event.pages.length === 0) return { status: "failed", bookId: session.bookId, message: "This comic has no pages in it." };
      return { status: "ready", bookId: session.bookId, pages: event.pages, wide: event.pages.map(() => false), page: clamp(event.page, event.pages.length), ...(event.document ? { document: event.document } : {}) };
    case "turned":
      if (session.status !== "ready") return session;
      return { ...session, page: clamp(event.page, session.pages.length) };
    case "measured": {
      if (session.status !== "ready" || event.page < 0 || event.page >= session.pages.length || session.wide[event.page] === event.wide) return session;
      const wide = [...session.wide];
      wide[event.page] = event.wide;
      return { ...session, wide };
    }
  }
}

/** How the pages are put on the screen: one at a time, or two as a printed comic opens. */
export type PagesUp = "one" | "two";

/** What is on screen for a ready comic: the pages up, in reading order, and where a turn either way lands. */
export interface OnScreen {
  /** The pages up, in reading order: one, or two that face each other. */
  pages: number[];
  /** The page a turn forward opens at, or null on the last. */
  next: number | null;
  /** The page a turn back opens at, or null on the first. */
  previous: number | null;
}

/** The pages on screen, and the turns from them. */
export function onScreen(session: ReadyComic, up: PagesUp): OnScreen {
  if (up === "one") {
    return { pages: [session.page], next: session.page + 1 < session.pages.length ? session.page + 1 : null, previous: session.page > 0 ? session.page - 1 : null };
  }
  const all: Spread[] = spreads(session.wide);
  const at = spreadOf(all, session.page);
  return { pages: pagesOf(all[at]!), next: at + 1 < all.length ? firstPage(all[at + 1]!) : null, previous: at > 0 ? firstPage(all[at - 1]!) : null };
}

/** How far through a comic a page is: 0 on the first, 1 on the last, which is how a comic is finished. */
export function pageProgress(page: number, pages: number): number {
  return pages <= 1 ? 1 : Math.max(0, Math.min(1, page / (pages - 1)));
}

/**
 * A page as a place in the position log (docs/POSITION-FORMAT.md, section
 * 3.8): the page's entry in the archive, by name, and its number counted
 * from 1.
 */
export function pageLocator(pages: readonly string[], page: number, document?: string): Locator {
  const locations = { position: page + 1, totalProgression: Math.round(pageProgress(page, pages.length) * 10_000) / 10_000 };
  // A PDF's page is named as PDFs name one, `page=14`, in the one file it is a page of.
  if (document) return { href: document, type: "application/pdf", locations: { ...locations, fragments: [pdfPageName(page)] } };
  const entry = pages[page] ?? "";
  return { href: entry, type: pageType(entry), locations };
}

/** A PDF's page as a fragment names it, counted from 1 (RFC 8118). */
export function pdfPageName(page: number): string {
  return `page=${page + 1}`;
}

/** A PDF's pages, by name: as many as it has. */
export function pdfPageNames(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, page) => pdfPageName(page));
}

/**
 * The page a place names, among a comic's pages: by its entry's name
 * first, so the place survives a reader that orders pages differently;
 * else by its number; else the first page.
 */
export function pageAt(pages: readonly string[], loc: Locator | undefined): number {
  if (!loc) return 0;
  const byName = pages.indexOf(loc.href);
  if (byName >= 0) return byName;
  // A PDF's page, named in the fragment.
  const named = (loc.locations?.fragments ?? []).map((f) => pages.indexOf(f)).find((at) => at >= 0);
  if (named !== undefined) return named;
  const position = loc.locations?.position;
  return typeof position === "number" && position >= 1 && position <= pages.length ? position - 1 : 0;
}
