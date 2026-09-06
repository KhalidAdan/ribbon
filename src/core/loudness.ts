import type { LoudnessMeasurement } from "./types";

/** EBU R128 integrated loudness the whole library is brought to. */
export const TARGET_LUFS = -18;
/** True-peak ceiling after gain, in dBTP. */
export const PEAK_CEILING_DBTP = -1;
/** Never boost or cut by more than this. */
export const MAX_GAIN_DB = 12;

/**
 * Parse the summary block ffmpeg's ebur128 filter prints to stderr:
 *
 *   Integrated loudness:
 *     I:         -23.4 LUFS
 *   True peak:
 *     Peak:       -1.2 dBFS
 */
export function parseEbur128(stderr: string): LoudnessMeasurement | null {
  const integrated = lastMatch(stderr, /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/m);
  if (integrated === null) return null;
  const lufs = integrated === "-inf" ? -70 : Number(integrated);
  if (!Number.isFinite(lufs)) return null;
  const peak = lastMatch(stderr, /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/m);
  const truePeak = peak === null || peak === "-inf" ? null : Number(peak);
  return { integratedLufs: lufs, truePeakDbtp: Number.isFinite(truePeak) ? truePeak : null };
}

function lastMatch(text: string, re: RegExp): string | null {
  const all = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!all || all.length === 0) return null;
  const m = all[all.length - 1]!.match(re);
  return m?.[1] ?? null;
}

/**
 * Gain in dB that brings `measured` to the target without clipping.
 * Missing measurement means no change. Clamped to plus or minus 12.
 */
export function gainDb(measured: LoudnessMeasurement | null, target = TARGET_LUFS): number {
  if (!measured) return 0;
  let gain = target - measured.integratedLufs;
  if (measured.truePeakDbtp !== null) {
    const headroom = PEAK_CEILING_DBTP - measured.truePeakDbtp;
    if (gain > headroom) gain = headroom;
  }
  gain = Math.min(MAX_GAIN_DB, Math.max(-MAX_GAIN_DB, gain));
  return Number(gain.toFixed(2));
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** ffmpeg arguments for a loudness scan of one file. Audio is discarded. */
export function loudnessArgs(inputPath: string): string[] {
  return ["-hide_banner", "-nostats", "-i", inputPath, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"];
}
