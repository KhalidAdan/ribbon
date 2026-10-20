import { useMemo } from "react";
import type { AppState } from "../app/controller";
import { useAppState } from "./store";
import type { ScannedBook } from "../core/scan/scan";
import type { ReadRecord } from "../core/poslog";
import { readsOf } from "../core/stats";
import { readerOnly } from "../core/ebook";
import { formatLeft } from "../core/speed";

/** A book is finished when its saved position is within this of the end. */
export const FINISHED_WITHIN_MS = 60_000;
/** A book that is only its EPUB is finished once its reading place is this far through. */
export const READ_TO_END = 0.99;

export interface Progress {
  /** Position in the book, live for the open book, saved for the rest. */
  posMs: number;
  started: boolean;
  finished: boolean;
  /** 0 to 1. */
  fraction: number;
}

/** What `progressOf` reads: the whole `AppState` will do. */
export type ProgressState = Pick<AppState, "current" | "positions"> & { player: { positionMs: number }; history?: { reads: ReadRecord[] } };

/**
 * A shelf shows the open book's place in whole minutes left and whole
 * percents, so it follows the player by the minute, not five times a
 * second. A started book stays started.
 */
export const SHELF_STEP_MS = 60_000;

export function shelfMs(ms: number): number {
  return ms <= 0 ? 0 : Math.max(1, Math.floor(ms / SHELF_STEP_MS) * SHELF_STEP_MS);
}

/**
 * What `progressOf` needs, for pages that show how far along books are
 * (the shelf, a book's page): the saved places, the history, and the open
 * book's place to the minute. Redraws by the minute while a book plays.
 */
export function useShelfProgress(): ProgressState {
  const s = useAppState((st) => ({ current: st.current, positions: st.positions, reads: st.history.reads, ms: shelfMs(st.player.positionMs) }));
  return useMemo(() => ({ current: s.current, positions: s.positions, history: { reads: s.reads }, player: { positionMs: s.ms } }), [s]);
}

/**
 * Where the listener is in a book, from the live player or the saved
 * position. Once a book has listen-throughs in the history, the latest
 * one says whether it is finished: marking a book finished or not, and
 * starting it again, are the listener's word on it. A book that is only
 * its EPUB is as far along as its reading place: `reading` says how far
 * through its text, 0 to 1, or null before it is read.
 */
export function progressOf(book: ScannedBook, state: ProgressState, reading?: (bookId: string) => number | null): Progress {
  const reads = state.history ? readsOf(state.history.reads, book.book.id) : [];
  const last = reads[reads.length - 1];
  if (readerOnly(book.book)) {
    const fraction = Math.min(1, Math.max(0, reading?.(book.book.id) ?? 0));
    return { posMs: 0, started: fraction > 0 || reads.length > 0, finished: last ? !!last.finished : fraction >= READ_TO_END, fraction };
  }
  const active = state.current?.book.book.id === book.book.id;
  const posMs = active ? state.player.positionMs : (state.positions[book.book.id]?.offsetMs ?? 0);
  const duration = book.book.durationMs;
  const within = Math.min(FINISHED_WITHIN_MS, duration * 0.1);
  const byPosition = posMs > 0 && duration > 0 && posMs >= duration - within;
  const finished = last ? !!last.finished : byPosition;
  const started = posMs > 0 || reads.length > 0;
  return { posMs, started, finished, fraction: duration > 0 ? Math.min(1, posMs / duration) : 0 };
}

/** What a book comes to before it is started: how long it is, or that it is an EPUB to read. */
export function lengthOf(book: ScannedBook): string {
  return readerOnly(book.book) ? "EPUB" : formatLeft(book.book.durationMs);
}

/** How far along a started book is: "42% · 3h 10m left", or "42% read" for one that is only its EPUB. */
export function howFar(book: ScannedBook, p: Progress, percent = Math.max(1, Math.round(p.fraction * 100))): string {
  return readerOnly(book.book) ? `${percent}% read` : `${percent}% · ${formatLeft(book.book.durationMs - p.posMs)} left`;
}
