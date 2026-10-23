import { pipe, from, tap, collect } from "@culvert/stream";
import type { Host } from "../host/host";
import type { LoudnessMeasurement, SilenceRange } from "./types";
import { combineLoudness, ebur128Fold, type FileLoudness } from "./loudness";
import { silenceRanges, MIN_GAP_MS, NOISE_DB } from "./silence";
import { lines } from "./lines";

/**
 * One ffmpeg pass that measures loudness and finds silences together. The
 * loudness of each tenth of a second isn't printed (`framelog=quiet`): only
 * the summary is read, and for a long book those lines run to hundreds of
 * thousands, enough to make playback stutter while they're read.
 */
export function analyzeArgs(inputPath: string, noiseDb = NOISE_DB, minGapMs = MIN_GAP_MS): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-filter_complex",
    `[0:a]silencedetect=noise=${noiseDb}dB:d=${(minGapMs / 1000).toFixed(2)},ebur128=peak=true:framelog=quiet`,
    "-f",
    "null",
    "-",
  ];
}

/** A book's loudness, all its files together, and the silences in each file, by the file's place in the book. */
export interface BookAnalysis {
  loudness: LoudnessMeasurement | null;
  silence: Map<number, SilenceRange[]>;
}

/**
 * Decode a book's audio once, recording loudness and silence. Each file is
 * one pipeline over ffmpeg's stderr, live where the host can stream it: the
 * loudness fold observes every line, the silence transform turns the
 * detector's lines into ranges. Null when stopped part way.
 */
export async function analyzeFiles(host: Pick<Host, "run" | "stream">, files: readonly { absPath: string; durationMs: number }[], signal?: AbortSignal): Promise<BookAnalysis | null> {
  const parts: FileLoudness[] = [];
  const silence = new Map<number, SilenceRange[]>();
  for (const [i, f] of files.entries()) {
    if (signal?.aborted) return null;
    const args = analyzeArgs(f.absPath);
    const output = host.stream ? host.stream("ffmpeg", args, signal) : from(lines((await host.run("ffmpeg", args, signal)).stderr));
    const loudness = ebur128Fold();
    const ranges = await pipe(
      output,
      tap((line) => loudness.feed(line)),
      silenceRanges(f.durationMs),
      collect(),
    );
    const m = loudness.result();
    if (m) parts.push({ ...m, durationMs: f.durationMs });
    if (ranges.length > 0) silence.set(i, ranges);
  }
  if (signal?.aborted) return null;
  return { loudness: combineLoudness(parts), silence };
}
