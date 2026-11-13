import type { Alignment } from "./align";
import type { BookText, TextPlace, TextRange } from "./booktext";
import type { Highlight } from "../types";

/**
 * The book open in the reader, as a state machine (docs/STATE-MACHINES.md).
 *
 * ```
 *   (closed) ── open ──▶ opening ── shown ──▶ ready ── closed ──▶ (closed)
 *                          │
 *                          └── failed ──▶ failed ── closed ──▶ (closed)
 *   any      ── open (another book, or this one again) ──▶ opening
 * ```
 *
 * Only a ready book has a text and a place, so nothing can ask where an
 * opening book is. Everything about reading it lives in the ready status:
 * its pairing with the audio, whether it follows the narrator, its
 * highlights, and the read-along export, which is one status of its own
 * rather than a progress and a result that could both be there.
 *
 * Work for a book (the pairing arriving, its transcription, an export)
 * goes on after the book is closed, so every event names its book and
 * lands only on that book, and only when it's ready: what comes for a
 * book no longer open, or still opening, is dropped.
 */
export type ReadingSession = OpeningSession | FailedSession | ReadySession;

/** Its text is being read and paired with the audio. */
export interface OpeningSession {
  status: "opening";
  bookId: string;
}

/** Its text couldn't be opened, and why, in plain words. */
export interface FailedSession {
  status: "failed";
  bookId: string;
  message: string;
}

/** Open to read. */
export interface ReadySession {
  status: "ready";
  bookId: string;
  /** The book's text, and through it its EPUB model (`text.ebook`). */
  text: BookText;
  place: TextPlace;
  /** The text's chapters paired with the audio's, for switching between them; null for a book with no audio, or until it's paired. */
  alignment: Alignment | null;
  /**
   * It reads along: its narration is transcribed whole, or its own Media
   * Overlay places it. Until then it opens to read only: no narrator's
   * sentence marked, no pages following it (#152). Never, while read-along
   * is turned off for the book (edits.ts, `readAlong`).
   */
  readsAlong: boolean;
  /** Transcribing the narration, while it runs: minutes transcribed, of all (#152). */
  listening: Listening | null;
  /** The pages follow the narrator: turned as it reads on, the sentence being read marked. A turn by hand stops it. */
  following: boolean;
  /** Hearing one place before "Listen from here" or "Go to the narrator" acts. */
  finding: boolean;
  /** Bookmarks made from highlights in this book, drawn in its text. */
  highlights: Highlight[];
  /** A line a search found, marked as the sentence it opened on until the reader moves on. */
  found: TextRange | null;
  /** The read-along export of this book. */
  export: ExportStatus;
}

export interface Listening {
  done: number;
  total: number;
  what: "openings" | "checkpoints" | "aligning";
}

/** The read-along export: never asked for, running (chapters encoded so far), made, or failed and why. */
export type ExportStatus = { status: "none" } | { status: "exporting"; done: number; total: number } | { status: "made"; path: string } | { status: "failed"; error: string };

export type ReadingEvent =
  /** A book is asked for: whatever was open is replaced. */
  | { type: "open"; bookId: string }
  /** Its text couldn't be opened. */
  | { type: "failed"; bookId: string; message: string }
  /** Its text is open at a place, paired with the audio when that was done first, following the narrator when its audio plays. */
  | { type: "shown"; bookId: string; text: BookText; place: TextPlace; alignment: Alignment | null; following: boolean; highlights: Highlight[] }
  /** The pairing, made or made again (a checkpoint heard, a fix by hand). */
  | { type: "paired"; bookId: string; alignment: Alignment }
  /** Its narration is all transcribed, or placed by its own Media Overlay. */
  | { type: "reads along"; bookId: string }
  /** Read-along was turned off for it while it's open: it reads only from here, as a book not yet transcribed does. */
  | { type: "reads only"; bookId: string }
  /** How far transcribing its narration has got, or null when it stopped. */
  | { type: "listening"; bookId: string; listening: Listening | null }
  /** The reader is somewhere else in the text: by hand stops following the narrator; a found line's mark goes either way. */
  | { type: "moved"; bookId: string; place: TextPlace; by: "hand" | "follow" | "scroll" }
  | { type: "following"; bookId: string; on: boolean }
  | { type: "finding"; bookId: string; on: boolean }
  | { type: "highlights"; bookId: string; highlights: Highlight[] }
  /** A line a search found, marked. */
  | { type: "found"; bookId: string; range: TextRange }
  | { type: "export"; bookId: string; export: ExportStatus }
  | { type: "closed" };

/** No export asked for yet. */
export const NO_EXPORT: ExportStatus = { status: "none" };

/** The reader after an event: the one place its session changes. Returns the same object when the event changes nothing. */
export function readingAfter(session: ReadingSession | null, event: ReadingEvent): ReadingSession | null {
  switch (event.type) {
    case "open":
      return { status: "opening", bookId: event.bookId };
    case "closed":
      return null;
    case "failed":
      return session?.status === "opening" && session.bookId === event.bookId ? { status: "failed", bookId: event.bookId, message: event.message } : session;
    case "shown":
      if (session?.status !== "opening" || session.bookId !== event.bookId) return session;
      return {
        status: "ready",
        bookId: event.bookId,
        text: event.text,
        place: event.place,
        alignment: event.alignment,
        readsAlong: false,
        listening: null,
        following: event.following,
        finding: false,
        highlights: event.highlights,
        found: null,
        export: NO_EXPORT,
      };
  }
  // Everything else is about reading a book that's open.
  if (session?.status !== "ready" || session.bookId !== event.bookId) return session;
  switch (event.type) {
    case "paired":
      return { ...session, alignment: event.alignment };
    case "reads along":
      return session.readsAlong ? session : { ...session, readsAlong: true };
    case "reads only":
      return session.readsAlong ? { ...session, readsAlong: false } : session;
    case "listening":
      return { ...session, listening: event.listening };
    case "moved":
      return { ...session, place: event.place, found: null, following: session.following && event.by !== "hand" };
    case "following":
      return session.following === event.on ? session : { ...session, following: event.on };
    case "finding":
      return session.finding === event.on ? session : { ...session, finding: event.on };
    case "highlights":
      return { ...session, highlights: event.highlights };
    case "found":
      return { ...session, found: event.range };
    case "export":
      return { ...session, export: event.export };
  }
}

/** The open book when it's ready to read, else null. */
export function readyReading(session: ReadingSession | null): ReadySession | null {
  return session?.status === "ready" ? session : null;
}
