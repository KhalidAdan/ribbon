import type { SilenceRange } from "./types";

/** Gaps shorter than this are narration rhythm, not dead air. */
export const MIN_GAP_MS = 1_000;
/** Every kept gap plays for about this long. */
export const TARGET_GAP_MS = 300;
/** The rate never exceeds this while crossing a gap. */
export const MAX_GAP_RATE = 8;
/** Silence threshold handed to ffmpeg's silencedetect. */
export const NOISE_DB = -45;

/**
 * Parse ffmpeg's silencedetect output:
 *   [silencedetect @ ...] silence_start: 12.345
 *   [silencedetect @ ...] silence_end: 15.2 | silence_duration: 2.855
 * An unterminated start closes at `fileEndMs`. Ranges under the
 * threshold are dropped.
 */
export function parseSilenceDetect(stderr: string, fileEndMs: number, minGapMs = MIN_GAP_MS): SilenceRange[] {
  const out: SilenceRange[] = [];
  let open: number | null = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const ms = Math.round(Number(m[2]) * 1000);
    if (m[1] === "start") {
      open = Math.max(0, ms);
    } else if (open !== null) {
      push(out, open, ms, minGapMs);
      open = null;
    }
  }
  if (open !== null) push(out, open, fileEndMs, minGapMs);
  return out;
}

function push(out: SilenceRange[], startMs: number, endMs: number, minGapMs: number): void {
  if (endMs - startMs >= minGapMs) out.push({ startMs, endMs });
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
