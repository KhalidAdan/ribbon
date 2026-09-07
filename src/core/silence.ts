import { pipe, from, collect, type Transform } from "@culvert/stream";
import type { SilenceRange } from "./types";
import { lines } from "./lines";

/** Gaps shorter than this are narration rhythm, not dead air. */
export const MIN_GAP_MS = 1_000;
/**
 * Every kept gap plays for about this long. A pause should still read
 * as a pause: shorter than this and sentences run into each other and
 * the position display leaps.
 */
export const TARGET_GAP_MS = 600;
/** The rate never exceeds this while crossing a gap. */
export const MAX_GAP_RATE = 3;
/** Silence threshold handed to ffmpeg's silencedetect. */
export const NOISE_DB = -45;

/**
 * ffmpeg's silencedetect lines in, silence ranges out, as they close:
 *   [silencedetect @ ...] silence_start: 12.345
 *   [silencedetect @ ...] silence_end: 15.2 | silence_duration: 2.855
 * An unterminated start closes at `fileEndMs`. Ranges under the
 * threshold are dropped. Works on a live stderr stream or a saved one.
 */
export function silenceRanges(fileEndMs: number, minGapMs = MIN_GAP_MS): Transform<string, SilenceRange> {
  return async function* (source) {
    let open: number | null = null;
    for await (const line of source) {
      const re = /silence_(start|end):\s*(-?[\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const ms = Math.round(Number(m[2]) * 1000);
        if (m[1] === "start") {
          open = Math.max(0, ms);
        } else if (open !== null) {
          if (ms - open >= minGapMs) yield { startMs: open, endMs: ms };
          open = null;
        }
      }
    }
    if (open !== null && fileEndMs - open >= minGapMs) yield { startMs: open, endMs: fileEndMs };
  };
}

/** The ranges in a finished stderr transcript. */
export function parseSilenceDetect(stderr: string, fileEndMs: number, minGapMs = MIN_GAP_MS): Promise<SilenceRange[]> {
  return pipe(from(lines(stderr)), silenceRanges(fileEndMs, minGapMs), collect());
}

/** Inclusive start, exclusive end. Ranges must be sorted and disjoint. */
export function findRange(ranges: readonly SilenceRange[], positionMs: number): SilenceRange | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (positionMs < r.startMs) hi = mid - 1;
    else if (positionMs >= r.endMs) lo = mid + 1;
    else return r;
  }
  return null;
}

/** Multiplier on the book speed while inside `range`. */
export function gapRate(range: SilenceRange, targetGapMs = TARGET_GAP_MS, cap = MAX_GAP_RATE): number {
  const length = range.endMs - range.startMs;
  if (length <= targetGapMs) return 1;
  return Math.min(cap, length / targetGapMs);
}

export function silenceArgs(inputPath: string, noiseDb = NOISE_DB, minGapMs = MIN_GAP_MS): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${(minGapMs / 1000).toFixed(2)}`,
    "-f",
    "null",
    "-",
  ];
}
