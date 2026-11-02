import { pipe, from, type Sink } from "@culvert/stream";
import type { LoudnessMeasurement } from "./types";
import { lines } from "./lines";

/** EBU R128 integrated loudness the whole library is brought to. */
export const TARGET_LUFS = -18;
/** True-peak ceiling after gain, in dBTP. */
export const PEAK_CEILING_DBTP = -1;
/** Never boost or cut by more than this. */
export const MAX_GAIN_DB = 12;

/**
 * Folds ffmpeg's ebur128 output a line at a time. The summary block at
 * the end is what counts, and it looks like:
 *
 *   Integrated loudness:
 *     I:         -23.4 LUFS
 *   True peak:
 *     Peak:       -1.2 dBFS
 *
 * Progress lines carry `I:` too, but not at the start of the line, and
 * in any case the last value seen wins, which is the summary's.
 */
export interface Ebur128Fold {
  feed(line: string): void;
  result(): LoudnessMeasurement | null;
}

export function ebur128Fold(): Ebur128Fold {
  let integrated: string | null = null;
  let peak: string | null = null;
  return {
    feed(line) {
      const i = /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(line);
      if (i) integrated = i[1]!;
      const p = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(line);
      if (p) peak = p[1]!;
    },
    result() {
      if (integrated === null) return null;
      const lufs = integrated === "-inf" ? -70 : Number(integrated);
      if (!Number.isFinite(lufs)) return null;
      const truePeak = peak === null || peak === "-inf" ? null : Number(peak);
      return { integratedLufs: lufs, truePeakDbtp: truePeak !== null && Number.isFinite(truePeak) ? truePeak : null };
    },
  };
}

/** A sink over stderr lines that yields the measurement, or null without a summary. */
export function ebur128Summary(): Sink<string, LoudnessMeasurement | null> {
  return async (source) => {
    const fold = ebur128Fold();
    for await (const line of source) fold.feed(line);
    return fold.result();
  };
}

/** The measurement in a finished stderr transcript. */
export function parseEbur128(stderr: string): Promise<LoudnessMeasurement | null> {
  return pipe(from(lines(stderr)), ebur128Summary());
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

export interface FileLoudness extends LoudnessMeasurement {
  durationMs: number;
}

/**
 * One measurement for a multi-file book: a duration-weighted power mean
 * of the per-file integrated loudness, and the loudest true peak.
 */
export function combineLoudness(parts: readonly FileLoudness[]): LoudnessMeasurement | null {
  let energy = 0;
  let weight = 0;
  let peak: number | null = null;
  for (const p of parts) {
    const w = Math.max(0, p.durationMs);
    if (w === 0) continue;
    energy += w * Math.pow(10, p.integratedLufs / 10);
    weight += w;
    if (p.truePeakDbtp !== null && (peak === null || p.truePeakDbtp > peak)) peak = p.truePeakDbtp;
  }
  if (weight === 0) return null;
  return { integratedLufs: Number((10 * Math.log10(energy / weight)).toFixed(2)), truePeakDbtp: peak };
}

export const LOUDNESS_HEADERS = ["book_id", "integrated_lufs", "true_peak_dbtp", "gain_db"];
