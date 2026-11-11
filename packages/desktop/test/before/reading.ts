// The reader's session as it was before it was one status per state (docs/STATE-MACHINES.md): the old
// controller's view of it. Everything else in app/reading.ts is unchanged, and taken from there.
import type { Alignment } from "@ribbon/core/reading/align";
import type { Highlight } from "@ribbon/core/types";
import type { BookText, TextPlace, TextRange } from "@ribbon/core/reading/booktext";

export { openingPlace, parseKeptPlaces, ReadingKeeper, type KeptPlace } from "../../src/app/reading";

/** The book open in the reader, while it opens, once it has, or why it could not. */
export interface ReadingState {
  bookId: string;
  status: "opening" | "ready" | "failed";
  message?: string;
  /** The book's text, and through it its EPUB model (`text.ebook`). */
  text?: BookText;
  place?: TextPlace;
  /** The text's chapters paired with the audio's, for switching between them (level 1). */
  alignment?: Alignment;
  /** Transcribing the narration, while it runs: minutes transcribed, of all (#152). */
  listening?: { done: number; total: number; what: "openings" | "checkpoints" | "aligning" };
  /**
   * It reads along: its narration is transcribed whole, or its own Media
   * Overlay places it. Until then the book opens to read only: no
   * narrator's sentence marked, no pages following it (#152).
   */
  readsAlong?: boolean;
  /** The read-along export: chapters encoded so far while it runs, then what it made or why it could not. */
  exporting?: { done: number; total: number };
  exported?: { path: string } | { error: string };
  /** The pages follow the narrator: turned as it reads on, the sentence being read marked. A turn by hand stops it. */
  following?: boolean;
  /** Hearing one place before "Listen from here" or "Go to the narrator" acts. */
  finding?: boolean;
  /** Bookmarks made from highlights in this book, drawn in its text. */
  highlights?: Highlight[];
  /** A line a search found, marked as the sentence it opened on until the reader moves on. */
  found?: TextRange;
}
