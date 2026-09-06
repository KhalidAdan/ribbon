/**
 * The moment you press play after a pause is where audiobook apps win
 * or lose. Rewind scales with how long you were gone, never crosses the
 * chapter start, and after a day offers to restart the chapter.
 */

export interface ResumePolicy {
  rewindMs: number;
  offerChapterRestart: boolean;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function rewindFor(gapMs: number): ResumePolicy {
  if (!(gapMs >= 10 * SECOND)) return { rewindMs: 0, offerChapterRestart: false };
  if (gapMs < 2 * MINUTE) return { rewindMs: 2 * SECOND, offerChapterRestart: false };
  if (gapMs < HOUR) return { rewindMs: 10 * SECOND, offerChapterRestart: false };
  if (gapMs < DAY) return { rewindMs: 30 * SECOND, offerChapterRestart: false };
  if (gapMs < WEEK) return { rewindMs: 30 * SECOND, offerChapterRestart: true };
  return { rewindMs: 60 * SECOND, offerChapterRestart: true };
}

/**
 * Where to start playing. `chapterStartMs` is the start of the chapter
 * that contains `positionMs`; pass 0 when chapters are unknown.
 */
export function resumePosition(positionMs: number, gapMs: number, chapterStartMs = 0): number {
  const { rewindMs } = rewindFor(gapMs);
  // A chapter start after the position is a caller mistake; ignore it.
  const floor = chapterStartMs > positionMs ? 0 : Math.max(0, chapterStartMs);
  return Math.max(floor, positionMs - rewindMs);
}
