import { pipe, from, tap, collect } from "@culvert/stream";
import type { ScannedBook } from "../core/scan/scan";
import type { SilenceRange } from "../core/types";
import { combineLoudness, ebur128Fold, type FileLoudness } from "../core/loudness";
import { silenceRanges, MIN_GAP_MS, NOISE_DB } from "../core/silence";
import { lines } from "../core/lines";
import type { LibraryService } from "./library";

/** One ffmpeg pass that measures loudness and finds silences together. */
export function analyzeArgs(inputPath: string, noiseDb = NOISE_DB, minGapMs = MIN_GAP_MS): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-filter_complex",
    `[0:a]silencedetect=noise=${noiseDb}dB:d=${(minGapMs / 1000).toFixed(2)},ebur128=peak=true`,
    "-f",
    "null",
    "-",
  ];
}

export interface Analysis {
  gainDb: number | null;
  silence: Map<number, SilenceRange[]>;
}

/**
 * Decode a whole book once, recording loudness and silence. This is the
 * expensive job, so it runs only for books the listener opens. Each
 * file is one pipeline over ffmpeg's stderr, live where the host can
 * stream it: the loudness fold observes every line, the silence
 * transform turns the detector's lines into ranges.
 */
export async function analyzeBook(lib: LibraryService, book: ScannedBook, signal?: AbortSignal): Promise<Analysis | null> {
  const parts: FileLoudness[] = [];
  const silence = new Map<number, SilenceRange[]>();
  for (const [i, f] of book.files.entries()) {
    if (signal?.aborted) return null;
    const args = analyzeArgs(lib.absPath(f.path));
    const output = lib.host.stream ? lib.host.stream("ffmpeg", args, signal) : from(lines((await lib.host.run("ffmpeg", args, signal)).stderr));
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
  const combined = combineLoudness(parts);
  const gainDb = combined ? await lib.writeLoudness(book.book.id, combined) : null;
  await lib.writeSilence(book.book.id, silence);
  return { gainDb, silence };
}

export interface JobStatus {
  bookId: string;
  state: "queued" | "running" | "done" | "failed";
}

/**
 * A single-lane queue for the slow analysis. Never runs more than one
 * ffmpeg. The book being listened to goes to the front.
 */
export class JobQueue {
  private queue: ScannedBook[] = [];
  private running: { bookId: string; abort: AbortController } | null = null;
  private listeners = new Set<(s: JobStatus, result: Analysis | null) => void>();

  constructor(private readonly lib: LibraryService) {}

  onStatus(fn: (s: JobStatus, result: Analysis | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue(book: ScannedBook, front = false): void {
    const id = book.book.id;
    if (this.running?.bookId === id) return;
    this.queue = this.queue.filter((b) => b.book.id !== id);
    if (front) this.queue.unshift(book);
    else this.queue.push(book);
    this.emit({ bookId: id, state: "queued" }, null);
    void this.pump();
  }

  cancelAll(): void {
    this.queue = [];
    this.running?.abort.abort();
  }

  private emit(s: JobStatus, result: Analysis | null): void {
    for (const l of this.listeners) l(s, result);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const abort = new AbortController();
    this.running = { bookId: next.book.id, abort };
    this.emit({ bookId: next.book.id, state: "running" }, null);
    try {
      const result = await analyzeBook(this.lib, next, abort.signal);
      this.emit({ bookId: next.book.id, state: result ? "done" : "failed" }, result);
    } catch {
      this.emit({ bookId: next.book.id, state: "failed" }, null);
    } finally {
      this.running = null;
      void this.pump();
    }
  }
}
