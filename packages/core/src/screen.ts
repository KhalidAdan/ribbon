/**
 * What's on screen, as a state machine (docs/STATE-MACHINES.md): the page
 * that fills the window above the player bar, and the full player when
 * it's open over it. The reader (core/reading/session.ts) is drawn over
 * both, and opening it closes the full player.
 *
 * ```
 *   any page ── show ──▶ library, settings, stats or the bookcase
 *            ── open a series ──▶ that series' page
 *            ── open a book ──▶ that book's page, from the bookcase when it came from there
 *   a book's page, a series' page ── its book or series gone ──▶ the library
 *
 *   full player: closed ── open (on a drawer or none) ──▶ open ── close ──▶ closed
 *                open   ── another drawer ──▶ open, on it
 * ```
 *
 * Each page carries what it shows: a book's page its book, a series' page
 * its series, so neither is left behind when another page shows. Every
 * page but Settings closes the full player as it opens.
 */
export type Screen =
  | { pane: "library" }
  | { pane: "settings" }
  | { pane: "stats" }
  | { pane: "bookcase" }
  | { pane: "series"; key: string }
  /** A book's page; `fromBookcase` when it was opened from the bookcase, so the way back leads there. */
  | { pane: "reader"; bookId: string; fromBookcase: boolean };

export type Drawer = "chapters" | "bookmarks" | "speed";

/** The full player, open over everything on one of its drawers or none; null while it's closed. */
export type FullPlayer = { drawer: Drawer | null } | null;

export interface OnScreen {
  screen: Screen;
  fullPlayer: FullPlayer;
}

export type ScreenEvent =
  | { type: "show"; pane: "library" | "settings" | "stats" | "bookcase" }
  | { type: "series"; key: string }
  | { type: "book"; bookId: string }
  /** The full player opens, on a drawer or none; asked for with no book loaded, it doesn't. */
  | { type: "expand"; drawer: Drawer | null }
  | { type: "collapse" }
  | { type: "drawer"; drawer: Drawer | null }
  /** Books are no longer on the shelf, or a series no longer is: a page showing one goes back to the library. */
  | { type: "gone"; books?: ReadonlySet<string>; series?: string };

export const LIBRARY: OnScreen = { screen: { pane: "library" }, fullPlayer: null };

/** What's on screen after an event: the one place it changes. Returns the same object when nothing does. */
export function screenAfter(now: OnScreen, event: ScreenEvent): OnScreen {
  switch (event.type) {
    case "show":
      // Settings opens with the full player as it was; any other page closes it.
      return { screen: { pane: event.pane }, fullPlayer: event.pane === "settings" ? now.fullPlayer : null };
    case "series":
      return { screen: { pane: "series", key: event.key }, fullPlayer: null };
    case "book": {
      const s = now.screen;
      return { screen: { pane: "reader", bookId: event.bookId, fromBookcase: s.pane === "bookcase" || (s.pane === "reader" && s.fromBookcase) }, fullPlayer: null };
    }
    case "expand":
      return { ...now, fullPlayer: { drawer: event.drawer } };
    case "collapse":
      return now.fullPlayer === null ? now : { ...now, fullPlayer: null };
    case "drawer":
      return now.fullPlayer === null || now.fullPlayer.drawer === event.drawer ? now : { ...now, fullPlayer: { drawer: event.drawer } };
    case "gone": {
      const s = now.screen;
      const gone = (s.pane === "reader" && !!event.books?.has(s.bookId)) || (s.pane === "series" && s.key === event.series);
      return gone ? { ...now, screen: { pane: "library" } } : now;
    }
  }
}

/** The book whose page shows, or null. */
export function pageBook(screen: Screen): string | null {
  return screen.pane === "reader" ? screen.bookId : null;
}
