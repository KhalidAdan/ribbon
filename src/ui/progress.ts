import type { AppState } from "../app/controller";
import type { ScannedBook } from "../core/scan/scan";
import type { ReadRecord } from "../core/poslog";
import { readsOf } from "../core/stats";

/** A book is finished when its saved position is within this of the end. */
export const FINISHED_WITHIN_MS = 60_000;

export interface Progress {
  /** Position in the book, live for the open book, saved for the rest. */
  posMs: number;
  started: boolean;
  finished: boolean;
  /** 0 to 1. */
  fraction: number;
}

/**
 * Where the listener is in a book, from the live player or the saved
 * position. Once a book has listen-throughs in the history, the latest
 * one says whether it is finished: marking a book finished or not, and
 * starting it again, are the listener's word on it.
 */
export function progressOf(book: ScannedBook, state: Pick<AppState, "current" | "player" | "positions"> & { history?: { reads: ReadRecord[] } }): Progress {
  const active = state.current?.book.book.id === book.book.id;
  const posMs = active ? state.player.positionMs : (state.positions[book.book.id]?.offsetMs ?? 0);
  const duration = book.book.durationMs;
  const within = Math.min(FINISHED_WITHIN_MS, duration * 0.1);
  const reads = state.history ? readsOf(state.history.reads, book.book.id) : [];
  const last = reads[reads.length - 1];
  const byPosition = posMs > 0 && duration > 0 && posMs >= duration - within;
  const finished = last ? !!last.finished : byPosition;
  const started = posMs > 0 || reads.length > 0;
  return { posMs, started, finished, fraction: duration > 0 ? Math.min(1, posMs / duration) : 0 };
}
