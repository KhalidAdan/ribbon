import type { ReadRecord } from "./poslog";

/** A book is finished when its saved position is within this of the end. */
export const FINISHED_WITHIN_MS = 60_000;

/** How far through a recording someone is. */
export interface Standing {
  started: boolean;
  finished: boolean;
  /** 0 to 1. */
  fraction: number;
}

/**
 * Where someone stands in a recording, from where they are in it and their
 * listen-throughs of it, oldest first. Once there are listen-throughs, the
 * latest says whether it's finished: marking a book finished or not, and
 * starting it again, are the listener's word on it. Before that, a place
 * within a minute of the end (a tenth, for a short book) is finished.
 */
export function standingOf(posMs: number, durationMs: number, reads: readonly ReadRecord[]): Standing {
  const last = reads[reads.length - 1];
  const within = Math.min(FINISHED_WITHIN_MS, durationMs * 0.1);
  const byPosition = posMs > 0 && durationMs > 0 && posMs >= durationMs - within;
  return {
    started: posMs > 0 || reads.length > 0,
    finished: last ? !!last.finished : byPosition,
    fraction: durationMs > 0 ? Math.min(1, posMs / durationMs) : 0,
  };
}
